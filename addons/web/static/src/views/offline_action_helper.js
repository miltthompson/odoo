import { Component, onWillStart } from "@odoo/owl";

export class OfflineActionHelper extends Component {
    static template = "web.OfflineActionHelper";

    setup() {
        this.searches = null;
        onWillStart(async () => {
            this.searches = await this.env.searchModel.getAvailableOfflineSearches();
        });
    }

    onResetFilters() {
        this.env.searchModel.applySearch(this.searches[0]);
    }
}
