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

function mergeRecords(oldData, newData) {
    const merged = { ...oldData };
    for (const [model, records] of Object.entries(newData)) {
        const byId = new Map((oldData[model] ?? []).map((record) => [record.id, record]));
        for (const record of records) {
            byId.set(record.id, { ...byId.get(record.id), ...record });
        }
        merged[model] = [...byId.values()];
    }
    return merged;
}

class ChatterReadCache {
    constructor(scope, version, secret) {
        this.scope = scope;
        this.version = version;
        this.db = new IndexedDB(`mail.chatter:${scope}`, version);
        this.crypto = new Crypto(secret);
        this.mutex = new Mutex();
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
            return await this.mutex.exec(() => this.readByKey(key));
        } catch {
            // Unavailable storage or a rotated secret must behave like an empty cache.
        }
    }

    /** Discard one thread's server snapshot in the current scope; never affects pending writes. */
    async invalidate(model, id) {
        try {
            const key = await this.key(model, id);
            await this.mutex.exec(() => this.db.delete(TABLE, key));
        } catch {
            // Browser persistence is best effort.
        }
    }

    /** Clear saved chatter for the current user in all company contexts. */
    async clear() {
        try {
            await this.mutex.exec(() => this.db.deleteDatabase());
        } catch {
            // Browser persistence is best effort.
        }
    }

    async capture(fetchParams, payload, context) {
        const changes = new Map();
        for (const request of fetchParams) {
            if (!Array.isArray(request)) {
                continue;
            }
            const [name, params, requestId] = request;
            const { thread_model: model, thread_id: id, access_params: accessParams } = params ?? {};
            if (!isCacheableChatter(model, id, accessParams)) {
                continue;
            }
            if (name !== "mail.thread" && name !== "/mail/thread/messages") {
                continue;
            }
            const threadKey = JSON.stringify([model, id]);
            if (!changes.has(threadKey)) {
                changes.set(threadKey, { model, id, requests: [] });
            }
            changes.get(threadKey).requests.push({ name, params, requestId });
        }
        await Promise.all([...changes.values()].map(async ({ model, id, requests }) => {
            const thread = payload["mail.thread"]?.find((row) => row.model === model && row.id === id);
            const key = await this.key(model, id, context);
            if (thread?.hasReadAccess === false) {
                return this.mutex.exec(() => this.db.delete(TABLE, key));
            }
            const savedAt = Date.now();
            return this.mutex.exec(async () => {
                const snapshot = (await this.readByKey(key).catch(() => undefined)) ?? {};
                let changed = false;
                for (const { name, params, requestId } of requests) {
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
                        snapshot.activities = { data, savedAt };
                        changed = true;
                    } else if (name === "/mail/thread/messages") {
                        const response = payload.DataResponse?.find((row) => row.id === requestId);
                        changed = this.captureMessages(
                            snapshot, params.fetch_params, response?.messages, payload, savedAt
                        ) || changed;
                    }
                }
                if (changed) {
                    const data = await this.crypto.encrypt(snapshot);
                    try {
                        await this.db.write(TABLE, key, { data, savedAt });
                    } catch (error) {
                        if (error instanceof IDBQuotaExceededError) {
                            await this.db.deleteDatabase();
                        }
                    }
                }
            });
        }));
    }

    captureMessages(snapshot, { before, after, around, limit } = {}, ids, payload, savedAt) {
        if (!Array.isArray(ids) || around != null) {
            return false;
        }
        const page = projectRecords(payload, "mail.message", ids);
        const previous = snapshot.messages;
        if (before != null && before === previous?.ids[0]) {
            snapshot.messages = {
                ids: [...new Set([...ids].reverse().concat(previous.ids))],
                data: mergeRecords(previous.data, page),
                hasOlder: ids.length >= limit,
                savedAt,
            };
        } else if (after != null && after === previous?.ids.at(-1)) {
            snapshot.messages = {
                ids: [...new Set(previous.ids.concat([...ids].reverse()))],
                data: mergeRecords(previous.data, page),
                hasOlder: previous.hasOlder,
                savedAt,
            };
        } else if (before == null && after == null) {
            snapshot.messages = {
                ids: [...ids].reverse(), data: page, hasOlder: ids.length >= limit, savedAt,
            };
        } else {
            // Don't join an arbitrary jump to a saved window: it can leave gaps in history.
            return false;
        }
        return true;
    }
}
