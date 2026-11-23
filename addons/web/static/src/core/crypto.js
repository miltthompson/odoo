export const CRYPTO_ALGO = "AES-GCM";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class Crypto {
    static importKey(secret) {
        return window.crypto.subtle.importKey(
            "raw",
            new Uint8Array(secret.match(/../g).map((h) => parseInt(h, 16))),
            CRYPTO_ALGO,
            false,
            ["encrypt", "decrypt"]
        );
    }

    constructor(secret) {
        this._ready = typeof secret === "string" ? Crypto.importKey(secret) : Promise.resolve(secret);
    }

    async encrypt(value) {
        const key = await this._ready;
        // The iv must never be reused with a given key.
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await window.crypto.subtle.encrypt(
            {
                name: CRYPTO_ALGO,
                iv,
                length: 64, // length of the counter in bits
            },
            key,
            encoder.encode(JSON.stringify(value)) // encoded Data
        );
        return { ciphertext, iv };
    }

    async decrypt({ ciphertext, iv }) {
        const key = await this._ready;
        const decrypted = await window.crypto.subtle.decrypt(
            {
                name: CRYPTO_ALGO,
                iv,
                length: 64,
            },
            key,
            ciphertext
        );
        return JSON.parse(decoder.decode(decrypted));
    }
}
