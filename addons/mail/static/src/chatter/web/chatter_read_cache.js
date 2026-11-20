import { Crypto, CRYPTO_ALGO } from "@web/core/crypto";
import { isRPCCacheDisabled } from "@web/core/network/rpc_cache";
import { user } from "@web/core/user";
import { Mutex } from "@web/core/utils/concurrency";
import { IndexedDB, IDBQuotaExceededError } from "@web/core/utils/indexed_db";
import { pick } from "@web/core/utils/objects";
import { session } from "@web/session";

const TABLE = "chatter";
const MAX_AGE = luxon.Duration.fromObject({ years: 1 }).toMillis();
const MODELS = {
    "mail.activity": {
        fields: [
            "activity_category", "create_date", "date_deadline", "date_done", "display_name",
            "icon", "note", "phone", "res_id", "res_model", "state", "summary",
        ],
        relations: {
            activity_type_id: "mail.activity.type",
            create_uid: "res.users",
            user_id: "res.users",
            role_id: "res.role",
        },
    },
    "mail.activity.type": { fields: ["name"] },
    "mail.guest": { fields: ["name"] },
    "mail.message": {
        fields: [
            "body", "date", "email_from", "message_type", "model", "record_name", "res_id",
            "subject", "default_subject", "thread", "write_date",
        ],
        relations: {
            author_id: "res.partner",
            author_guest_id: "mail.guest",
            subtype_id: "mail.message.subtype",
        },
    },
    "mail.message.subtype": { fields: ["description"] },
    "res.partner": { fields: ["name", "is_company"] },
    "res.role": { fields: ["name"] },
    "res.users": { relations: { partner_id: "res.partner" } },
};

let cache;

/** Returns the authenticated user's cache, or undefined when persistence is unavailable. */
export function getChatterReadCache() {
    if (
        !window.isSecureContext ||
        !window.crypto?.subtle ||
        !window.indexedDB ||
        !session.db ||
        !user.userId ||
        !user.isInternalUser ||
        !session.browser_cache_secret ||
        isRPCCacheDisabled()
    ) {
        return;
    }
    const scope = JSON.stringify([session.db, user.userId]);
    const version = `${session.registry_hash}:${CRYPTO_ALGO}:1`;
    if (cache?.scope !== scope || cache.version !== version) {
        cache = new ChatterReadCache(scope, version, session.browser_cache_secret);
    }
    return cache;
}

export function isCacheableChatter(model, id, accessParams) {
    return (
        Boolean(model) &&
        model !== "discuss.channel" &&
        Number.isInteger(id) &&
        id > 0 &&
        !Object.keys(accessParams ?? {}).length
    );
}

/** Project only the records needed for history and activities, not other requests in the batch. */
function projectRecords(payload, rootModel, ids) {
    const data = {};
    const seen = new Map();
    const indexes = new Map();
    function visit(model, id) {
        if (!id) {
            return;
        }
        if (!seen.has(model)) {
            seen.set(model, new Set());
        }
        if (seen.get(model).has(id)) {
            return;
        }
        seen.get(model).add(id);
        if (!indexes.has(model)) {
            indexes.set(model, new Map((payload[model] ?? []).map((record) => [record.id, record])));
        }
        const record = indexes.get(model).get(id);
        if (!record) {
            return;
        }
        const { fields = [], relations = {} } = MODELS[model];
        (data[model] ??= []).push(pick(record, "id", ...fields, ...Object.keys(relations)));
        for (const [field, target] of Object.entries(relations)) {
            visit(target, record[field]);
        }
    }
    for (const id of ids) {
        visit(rootModel, id);
    }
    return data;
}

function mergeRecords(oldData, newData, messageIds) {
    const merged = { ...oldData };
    for (const [model, records] of Object.entries(newData)) {
        const byId = new Map((oldData[model] ?? []).map((record) => [record.id, record]));
        for (const record of records) {
            byId.set(record.id, { ...byId.get(record.id), ...record });
        }
        merged[model] = [...byId.values()];
    }
    if (messageIds) {
        const visible = new Set(messageIds);
        merged["mail.message"] = (merged["mail.message"] ?? []).filter(({ id }) => visible.has(id));
    }
    return merged;
}

class ChatterReadCache {
    constructor(scope, version, secret) {
        this.scope = scope;
        this.version = version;
        this.name = `mail.chatter:${scope}`;
        this.db = new IndexedDB(this.name, version);
        this.crypto = new Crypto(secret);
        this.mutex = new Mutex();
    }

    withLock(callback) {
        // The snapshot is shared across tabs. Lock the whole read/modify/write, including clear().
        return navigator.locks?.request(this.name, callback) ?? this.mutex.exec(callback);
    }

    async key(model, id, context = user.context) {
        // Include the active company context, language and any other user-context access scope.
        const input = new TextEncoder().encode(JSON.stringify([context, model, id]));
        const hash = await window.crypto.subtle.digest("SHA-256", input);
        return Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0")
        ).join("");
    }

    async readByKey(key) {
        const entry = await this.db.read(TABLE, key);
        if (entry && Date.now() - entry.savedAt <= MAX_AGE) {
            return this.crypto.decrypt(entry.data);
        }
    }

    /** Returns { activities, messages } (each with data and savedAt), or undefined on a miss. */
    async read(model, id) {
        try {
            const key = await this.key(model, id);
            return await this.withLock(() => this.readByKey(key));
        } catch {
            // Unavailable storage or a rotated secret must behave like an empty cache.
        }
    }

    /** Discard one thread's server snapshot in the current scope; never affects pending writes. */
    async invalidate(model, id) {
        try {
            const key = await this.key(model, id);
            await this.withLock(() => this.db.delete(TABLE, key));
        } catch {
            // Browser persistence is best effort.
        }
    }

    /** Clear saved chatter for the current user in all company contexts. */
    async clear() {
        try {
            await this.withLock(() => this.db.deleteDatabase());
        } catch {
            // Browser persistence is best effort.
        }
    }

    /** Keep an edited or removed message consistent with a page already saved on the device. */
    async updateMessage(model, id, messageId, body) {
        try {
            const key = await this.key(model, id);
            await this.withLock(async () => {
                const snapshot = await this.readByKey(key);
                const messages = snapshot?.messages;
                if (!messages?.ids.includes(messageId)) {
                    return;
                }
                const records = messages.data["mail.message"] ?? [];
                if (body === undefined) {
                    // The online thread may still paginate from the deleted message placeholder.
                    messages.oldestCursor ??= messages.ids[0];
                    messages.ids = messages.ids.filter((id) => id !== messageId);
                    messages.data["mail.message"] = records.filter(({ id }) => id !== messageId);
                } else {
                    const message = records.find(({ id }) => id === messageId);
                    if (!message) {
                        return;
                    }
                    message.body = ["markup", body];
                }
                const savedAt = Math.max(snapshot.activities?.savedAt ?? 0, messages.savedAt);
                await this.writeSnapshot(key, snapshot, savedAt);
            });
        } catch {
            // Browser persistence is best effort; the server accepted the change.
        }
    }

    async writeSnapshot(key, snapshot, savedAt) {
        const data = await this.crypto.encrypt(snapshot);
        try {
            await this.db.write(TABLE, key, { data, savedAt });
        } catch (error) {
            if (error instanceof IDBQuotaExceededError) {
                await this.db.deleteDatabase();
            }
        }
    }

    async capture(fetchParams, payload, context) {
        const changes = new Map();
        for (const request of fetchParams) {
            if (!Array.isArray(request)) {
                continue;
            }
            const [name, params, requestId] = request;
            if (name !== "mail.thread" && name !== "/mail/thread/messages") {
                continue;
            }
            const { thread_model: model, thread_id: id, access_params: accessParams } = params ?? {};
            if (!isCacheableChatter(model, id, accessParams)) {
                continue;
            }
            const threadKey = JSON.stringify([model, id]);
            if (!changes.has(threadKey)) {
                const thread = payload["mail.thread"]?.find((row) => row.model === model && row.id === id);
                changes.set(threadKey, { model, id, thread, pages: [] });
            }
            const change = changes.get(threadKey);
            const { thread } = change;
            // Project and detach server data before Store.insert converts relations in place.
            if (
                name === "mail.thread" &&
                params.request_list?.includes("activities") &&
                thread?.hasReadAccess &&
                Array.isArray(thread.activities)
            ) {
                const data = projectRecords(payload, "mail.activity", thread.activities);
                data["mail.thread"] = [
                    pick(thread, "id", "model", "activities", "hasReadAccess", "hasWriteAccess", "canPostOnReadonly"),
                ];
                change.activities = structuredClone(data);
            } else if (name === "/mail/thread/messages" && params.fetch_params?.around == null) {
                const ids = payload.DataResponse?.find((row) => row.id === requestId)?.messages;
                if (Array.isArray(ids)) {
                    const data = projectRecords(payload, "mail.message", ids);
                    change.pages.push({ params: params.fetch_params, ids: [...ids], data: structuredClone(data) });
                }
            }
        }
        await Promise.all([...changes.values()].map(async ({ model, id, thread, activities, pages }) => {
            const denied = thread?.hasReadAccess === false;
            if (!denied && !activities && !pages.length) {
                return;
            }
            const key = await this.key(model, id, context);
            const savedAt = Date.now();
            return this.withLock(async () => {
                if (denied) {
                    await this.db.delete(TABLE, key);
                    return;
                }
                const snapshot = (await this.readByKey(key).catch(() => undefined)) ?? {};
                let changed = Boolean(activities);
                if (activities) {
                    snapshot.activities = { data: activities, savedAt };
                }
                for (const { params, ids, data } of pages) {
                    changed = this.captureMessages(snapshot, params, ids, data, savedAt) || changed;
                }
                if (changed) {
                    await this.writeSnapshot(key, snapshot, savedAt);
                }
            });
        }));
    }

    captureMessages(snapshot, { before, after, limit } = {}, ids, page, savedAt) {
        const previous = snapshot.messages;
        const oldestCursor = previous?.oldestCursor ?? previous?.ids[0];
        if (
            before != null &&
            oldestCursor != null &&
            before >= oldestCursor &&
            before <= (previous.ids.at(-1) ?? oldestCursor)
        ) {
            // The cursor lies inside the saved window. The response owns the range below it,
            // down to the oldest returned message (or all older history on a short page).
            const pageStart = ids.at(-1) ?? before;
            const fullPage = ids.length > 0 && ids.length >= limit;
            const olderIds = fullPage ? previous.ids.filter((id) => id < pageStart) : [];
            const newerIds = previous.ids.filter((id) => id >= before);
            const mergedIds = [...olderIds, ...[...ids].reverse(), ...newerIds];
            snapshot.messages = {
                ids: mergedIds,
                data: mergeRecords(previous.data, page, mergedIds),
                oldestCursor: fullPage ? Math.min(pageStart, oldestCursor) : pageStart,
                hasOlder: fullPage && (pageStart < oldestCursor || previous.hasOlder),
                savedAt,
            };
        } else if (after != null && after === previous?.ids.at(-1)) {
            snapshot.messages = {
                ...previous,
                ids: [...new Set(previous.ids.concat([...ids].reverse()))],
                data: mergeRecords(previous.data, page),
                savedAt,
            };
        } else if (before == null && after == null) {
            const latestIds = [...ids].reverse();
            const hasOlder = ids.length >= limit;
            if (hasOlder && previous?.ids.includes(latestIds[0])) {
                // The shared boundary proves continuity. The new page owns the range it covers,
                // including any messages removed since the previous fetch.
                const keptIds = previous.ids.filter((id) => id < latestIds[0]);
                const mergedIds = [...keptIds, ...latestIds];
                snapshot.messages = {
                    ...previous,
                    ids: mergedIds,
                    data: mergeRecords(previous.data, page, mergedIds),
                    savedAt,
                };
            } else {
                snapshot.messages = { ids: latestIds, data: page, hasOlder, savedAt };
            }
        } else {
            // Don't join an arbitrary jump to a saved window: it can leave gaps in history.
            return false;
        }
        return true;
    }
}
