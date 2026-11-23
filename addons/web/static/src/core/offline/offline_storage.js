import { Crypto } from "@web/core/crypto";
import { IndexedDB } from "@web/core/utils/indexed_db";

const encoder = new TextEncoder();
const KEYS = "keys";
const ENTRIES = "entries";
const QUEUE_META = "meta";
const RESOLVED_RECORDS = "resolved-records";
export const RESOLUTION_TTL = 30 * 24 * 60 * 60 * 1000;

export async function offlineDigest(text) {
    const digest = await window.crypto.subtle.digest("SHA-256", encoder.encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function offlineDatabaseName(name, { db, uid }) {
    return `${name}:${JSON.stringify([db, uid])}`;
}

/** The same scoped key store can be read by the service worker at offline startup. */
export class OfflineKeyStore {
    constructor(owner) {
        this.name = offlineDatabaseName("offline-keys", owner);
        this.db = new IndexedDB(this.name, undefined, { durability: "strict" });
    }

    async current(secret) {
        const id = secret && (await offlineDigest(secret));
        return navigator.locks.request(this.name, async () => {
            const current = await this.db.read(KEYS, "current");
            if (!id) {
                return current && { id: current, key: await this.get(current) };
            }
            let key = await this.get(id);
            if (!key) {
                key = await Crypto.importKey(secret);
                await this.db.write(KEYS, id, key);
            }
            if (current !== id) {
                await this.db.write(KEYS, "current", id);
            }
            return { id, key };
        });
    }

    get(id) {
        return this.db.read(KEYS, id);
    }

    prune(retain = new Set()) {
        return navigator.locks.request(this.name, async () => {
            const current = await this.db.read(KEYS, "current");
            for (const key of (await this.db.getAllKeys(KEYS)) || []) {
                if (key !== "current" && key !== current && !retain.has(key)) {
                    await this.db.delete(KEYS, key);
                }
            }
        });
    }
}

export class OfflineQueueStore {
    constructor(owner, secret) {
        this.owner = owner;
        this.name = offlineDatabaseName("offline-queue", owner);
        // Unlike read caches, this store must never be reset on a version change.
        this.db = new IndexedDB(this.name, undefined, { durability: "strict" });
        this.keys = new OfflineKeyStore(owner);
        this.keyReady = this.keys.current(secret);
    }

    lock(callback) {
        return navigator.locks.request(this.name, callback);
    }

    async list() {
        const rows = (await this.db.getAllEntries(ENTRIES)) || [];
        const keyPromises = new Map();
        const entries = await Promise.all(rows.map(({ value }) => this._decrypt(value, keyPromises)));
        return entries.sort((a, b) => a.seq - b.seq);
    }

    async get(key) {
        const row = await this.db.read(ENTRIES, key);
        return row && this._decrypt(row, new Map());
    }

    async _decrypt({ keyId, payload }, keys) {
        if (!keys.has(keyId)) {
            keys.set(keyId, this.keys.get(keyId));
        }
        const entry = await new Crypto(await keys.get(keyId)).decrypt(payload);
        if (entry.db !== this.owner.db || entry.uid !== this.owner.uid) {
            throw new Error("Offline queue entry has a different owner");
        }
        return entry;
    }

    async add(entry) {
        const [saved] = await this.addMany([entry]);
        return saved;
    }

    async addMany(entries) {
        let seq = (await this.db.read(QUEUE_META, "seq")) || 0;
        const saved = entries.map((entry) => ({ ...entry, seq: ++seq }));
        // An interrupted write can leave a gap, but cannot reuse a sequence number.
        await this.db.write(QUEUE_META, "seq", seq);
        // All entries commit in a single IndexedDB transaction.
        await this._writeEntries(saved);
        return saved;
    }

    write(entry) {
        return this._writeEntries([entry]);
    }

    async _writeEntries(entries) {
        await this.keyReady;
        const { id, key } = await this.keys.current();
        const crypto = new Crypto(key);
        // Store the UUID rather than the compatibility key derived from plaintext.
        const values = await Promise.all(entries.map(async (entry) => ({
            key: entry.key,
            value: { keyId: id, payload: await crypto.encrypt(entry) },
        })));
        await this.db.write(ENTRIES, values);
    }

    wasDraftDiscarded(key) {
        return this.db.read(QUEUE_META, `discarded:${key}`);
    }

    async recordResolution(model, localId, key, id) {
        const current = await this.keys.current();
        const index = JSON.stringify([model, localId]);
        const payload = await new Crypto(current.key).encrypt({ id, key });
        await this.db.write(RESOLVED_RECORDS, index, {
            payload,
            keyId: current.id,
            expires: Date.now() + RESOLUTION_TTL,
        });
    }

    async resolveRecord(model, localId) {
        const row = await this.db.read(RESOLVED_RECORDS, JSON.stringify([model, localId]));
        if (row?.expires > Date.now()) {
            const crypto = new Crypto(await this.keys.get(row.keyId));
            return crypto.decrypt(row.payload);
        }
    }

    async rememberDraftRecord(key, model, id, localId = `offline:${key}`) {
        const updates = (await this.list())
            .filter((entry) => entry.target.model === model && entry.refs.includes(key) && entry.target.ids.includes(localId))
            .map((entry) => ({
                ...entry,
                ...(entry.method === "web_save" && { resolvedResId: id }),
                target: {
                    ...entry.target,
                    ids: [...new Set(entry.target.ids.map((targetId) => targetId === localId ? id : targetId))],
                },
            }));
        if (updates.length) {
            await this._writeEntries(updates);
        }
        return updates;
    }

    async remove(key, { discardedDraft = false } = {}) {
        if (discardedDraft) {
            // Keep just the UUID marker, and never commit it while the draft can still replay.
            await this.db.writeAndDelete(QUEUE_META, `discarded:${key}`, true, ENTRIES, key);
        } else {
            await this.db.delete(ENTRIES, key);
        }
        if (!(await this.db.getAllKeys(ENTRIES))?.length) {
            const retain = new Set();
            for (const { key, value } of (await this.db.getAllEntries(RESOLVED_RECORDS)) || []) {
                if (value.expires > Date.now()) {
                    retain.add(value.keyId);
                } else {
                    await this.db.delete(RESOLVED_RECORDS, key);
                }
            }
            await this.keys.prune(retain);
        }
    }
}

export function clearLegacyReadStores() {
    return Promise.all([
        // Match only read caches; leave the legacy write store and database version alone.
        new IndexedDB("offline").invalidate([/^visited-ui-items/, /^many2x_/]),
        new IndexedDB("rpc").invalidate(),
        new IndexedDB("webclient_menu").invalidate(),
    ]);
}
