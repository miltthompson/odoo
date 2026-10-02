import { onMounted, onPatched } from "@odoo/owl";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { Thread } from "@mail/core/common/thread_model";

// Buttons needed to post a note/message on a crm.lead while offline. The
// offline framework auto-disables every button without this attribute, so the
// queued message_post below would otherwise be unreachable. Attachments and
// activities stay disabled on purpose: they can't be queued.
const OFFLINE_CHATTER_BUTTONS =
    ".o-mail-Chatter-sendMessage, .o-mail-Chatter-logNote, .o-mail-Composer-send";

patch(Chatter.prototype, {
    setup() {
        super.setup(...arguments);
        const enableOfflineButtons = () => {
            if (this.threadModel?.() !== "crm.lead") {
                return;
            }
            this.rootRef()
                ?.querySelectorAll(OFFLINE_CHATTER_BUTTONS)
                .forEach((el) => el.setAttribute("data-available-offline", ""));
        };
        onMounted(enableOfflineButtons);
        onPatched(enableOfflineButtons);
    },
});

patch(Thread.prototype, {
    async post(body, postData = {}, extraData = {}) {
        const offline = this.store.env.services.offline;
        if (this.model !== "crm.lead" || !offline?.offline) {
            return super.post(...arguments);
        }
        const notification = this.store.env.services.notification;
        // Records created offline have no real id yet and attachments go through
        // an upload route: neither can be queued.
        if (!Number.isInteger(this.id) || this.id <= 0) {
            notification.add(_t("You need to be online to post on this record."), {
                type: "warning",
            });
            return;
        }
        if (postData.attachments?.length) {
            notification.add(_t("Attachments can't be sent while offline."), {
                type: "warning",
            });
            return;
        }
        const kwargs = {
            body: String(body),
            message_type: "comment",
            subtype_xmlid: postData.isNote ? "mail.mt_note" : "mail.mt_comment",
        };
        if (postData.subject) {
            kwargs.subject = postData.subject;
        }
        if (postData.mentionedPartners?.length) {
            kwargs.partner_ids = postData.mentionedPartners.map((partner) => partner.id);
        }
        offline.scheduleORM("crm.lead", "message_post", [[this.id]], kwargs, {
            extras: {
                timeStamp: Date.now(),
                displayName: this.display_name || _t("Lead %(id)s", { id: this.id }),
            },
        });
        notification.add(_t("Saved: your message will be posted once back online."), {
            type: "info",
        });
    },
});
