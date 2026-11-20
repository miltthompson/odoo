import { Crypto } from "@web/core/crypto";
import { IndexedDB } from "@web/core/utils/indexed_db";

const encoder = new TextEncoder();
const KEYS = "keys";
const ENTRIES = "entries";
const QUEUE_META = "meta";

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

    prune() {
        return navigator.locks.request(this.name, async () => {
            const current = await this.db.read(KEYS, "current");
            for (const key of (await this.db.getAllKeys(KEYS)) || []) {
                if (key !== "current" && key !== current) {
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
        const seq = ((await this.db.read(QUEUE_META, "seq")) || 0) + 1;
        // A crash between writing the counter and entry can leave a gap, not a reused sequence.
        await this.db.write(QUEUE_META, "seq", seq);
        const saved = { ...entry, seq };
        await this.write(saved);
        return saved;
    }

    async write(entry) {
        await this.keyReady;
        const { id, key } = await this.keys.current();
        // Store the UUID rather than the legacy hash, which is derived from plaintext.
        const payload = await new Crypto(key).encrypt(entry);
        await this.db.write(ENTRIES, entry.key, { keyId: id, payload });
    }

    async remove(key) {
        await this.db.delete(ENTRIES, key);
        if (!(await this.db.getAllKeys(ENTRIES))?.length) {
            await this.keys.prune();
        }
    }
}

export function clearLegacyReadStores() {
    return Promise.all([
        new IndexedDB("rpc").invalidate(),
        new IndexedDB("webclient_menu").invalidate(),
    ]);
}
