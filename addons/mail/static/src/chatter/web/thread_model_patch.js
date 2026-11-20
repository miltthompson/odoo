import { Thread } from "@mail/core/common/thread_model";
import "@mail/chatter/web_portal_project/thread_model_patch";
import { getChatterReadCache, isCacheableChatter } from "@mail/chatter/web/chatter_read_cache";

import { ConnectionLostError } from "@web/core/network/rpc";
import { patch } from "@web/core/utils/patch";

const pendingRestores = new WeakMap();

/** @type {import("models").Thread} */
const threadPatch = {
    chatterSavedAt: undefined,
    hasOfflineChatterSnapshot: false,
    hasRestoredOfflineMessages: false,
    hasLoadedChatterActivities: false,

    isOfflineChatter() {
        return (
            isCacheableChatter(this.model, this.id, this.rpcParams) &&
            this.store.env.services.offline?.offline === true
        );
    },

    /** Rehydrate read-only server data without replacing local/pending messages. */
    async restoreOfflineChatter() {
        const existing = pendingRestores.get(this);
        if (existing) {
            return existing;
        }
        const restore = (async () => {
            const snapshot = await getChatterReadCache()?.read(this.model, this.id);
            if (!this.isOfflineChatter()) {
                return;
            }
            const { activities, messages } = this.hasReadAccess !== false ? snapshot ?? {} : {};
            if (activities && !this.hasLoadedChatterActivities) {
                this.store.insert(activities.data, { broadcast: false });
                this.hasLoadedChatterActivities = true;
            }
            if (messages && !this.persistentMessages.length) {
                this.store.insert(messages.data, { broadcast: false });
                const saved = messages.ids.map((id) => this.store["mail.message"].get(id));
                this.messages.unshift(...saved.filter(Boolean));
                this.loadOlder = messages.hasOlder;
                this.hasRestoredOfflineMessages = true;
            }
            this.status = "ready";
            this.isLoaded = true;
            this.isLoadingAttachments = false;
            this.hasLoadingFailed = false;
            this.hasLoadingFailedError = undefined;
            this.hasOfflineChatterSnapshot = Boolean(activities || messages);
            this.chatterSavedAt = this.hasOfflineChatterSnapshot
                ? Math.min(activities?.savedAt ?? Infinity, messages?.savedAt ?? Infinity)
                : undefined;
        })().finally(() => pendingRestores.delete(this));
        pendingRestores.set(this, restore);
        return restore;
    },

    /** @param {string[]} requestList */
    async fetchThreadData(requestList) {
        if (this.isOfflineChatter()) {
            return this.restoreOfflineChatter();
        }
        this.isLoadingAttachments =
            this.isLoadingAttachments || requestList.includes("attachments");
        try {
            await super.fetchThreadData(...arguments);
        } catch (error) {
            if (!(error instanceof ConnectionLostError) || !this.isOfflineChatter()) {
                throw error;
            }
            return this.restoreOfflineChatter();
        }
        if (this.hasOfflineChatterSnapshot && this.hasReadAccess === false) {
            this.messages = [];
            this.hasRestoredOfflineMessages = false;
            this.activities = [];
            this.loadOlder = false;
            this.status = "ready";
        }
        if (requestList.includes("activities")) {
            this.hasLoadedChatterActivities = this.hasReadAccess === true;
        }
        this.hasOfflineChatterSnapshot = false;
        if (!this.message_main_attachment_id && this.attachmentsInWebClientView.length > 0) {
            this.setMainAttachmentFromIndex(0);
        }
    },

    async fetchNewMessages() {
        if (this.isOfflineChatter()) {
            return this.restoreOfflineChatter();
        }
        const replacesSavedHistory = this.hasRestoredOfflineMessages && this.status !== "loading";
        await super.fetchNewMessages(...arguments);
        if (this.hasLoadingFailedError instanceof ConnectionLostError && this.isOfflineChatter()) {
            return this.restoreOfflineChatter();
        }
        if (replacesSavedHistory && !this.hasLoadingFailed) {
            this.hasRestoredOfflineMessages = false;
        }
    },

    getFetchNewMessagesAfter() {
        // A saved cursor might be several pages behind. Refresh the latest page on reconnect.
        return this.hasRestoredOfflineMessages ? undefined : super.getFetchNewMessagesAfter();
    },

    async fetchMoreMessages() {
        if (!this.isOfflineChatter()) {
            await super.fetchMoreMessages(...arguments);
        }
    },

    async loadAround() {
        if (!this.isOfflineChatter()) {
            await super.loadAround(...arguments);
        }
    },

    get fullComposerCloseRequestList() {
        return super.fullComposerCloseRequestList.concat([
            "defaultSubject",
            "scheduledMessages",
            "suggestedSubject",
        ]);
    },
};
patch(Thread.prototype, threadPatch);
