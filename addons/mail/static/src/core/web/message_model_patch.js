import { getChatterReadCache, isCacheableChatter } from "@mail/chatter/web/chatter_read_cache";
import { Message } from "@mail/core/common/message_model";

import { patch } from "@web/core/utils/patch";

/** @type {import("models").Message} */
const messagePatch = {
    async edit() {
        const data = await super.edit(...arguments);
        if (data && isCacheableChatter(this.thread?.model, this.thread?.id, this.thread?.rpcParams)) {
            const { model, id } = this.thread;
            getChatterReadCache()?.updateMessage(model, id, this.id, String(this.body));
        }
        return data;
    },
    async remove() {
        const { model, id, rpcParams } = this.thread ?? {};
        const messageId = this.id;
        const data = await super.remove(...arguments);
        if (isCacheableChatter(model, id, rpcParams)) {
            getChatterReadCache()?.updateMessage(model, id, messageId);
        }
        return data;
    },
    get canReplyAll() {
        return this.canForward && !this.isNote && !this.isEmpty;
    },
    get canForward() {
        if (!this.thread || this.isEmpty) {
            return false;
        }
        return (
            !this.thread.channel &&
            ["comment", "email", "email_outgoing"].includes(this.message_type)
        );
    },
};
patch(Message.prototype, messagePatch);
