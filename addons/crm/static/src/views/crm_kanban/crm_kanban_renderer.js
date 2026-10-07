import { CrmColumnProgress } from "./crm_column_progress";
import { RottingKanbanHeader } from "@mail/js/rotting_mixin/rotting_kanban_header";
import { RottingKanbanRenderer } from "@mail/js/rotting_mixin/rotting_kanban_renderer";

class CrmKanbanHeader extends RottingKanbanHeader {
    static components = {
        ...RottingKanbanHeader.components,
        ColumnProgress: CrmColumnProgress,
    };
}

export class CrmKanbanRenderer extends RottingKanbanRenderer {
    static components = {
        ...RottingKanbanRenderer.components,
        KanbanHeader: CrmKanbanHeader,
    };

    get canResequenceRecords() {
        // Offline, the kanban groups' DOM nodes are replaced mid-drag, which
        // orphans the sortable's listeners and turns the drag into a silent
        // no-op: prevent it from starting instead. Stages remain editable
        // from the statusbar in the form view.
        if (this.env.services.offline?.offline) {
            return false;
        }
        return super.canResequenceRecords;
    }
}
