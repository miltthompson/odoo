import { Domain } from "@web/core/domain";

/** Fold the queue over stable record IDs without modifying an RPC cache entry. */
export function getOfflineOverlay(entries, model, context) {
    const changes = new Map();
    const companies = JSON.stringify(context.allowed_company_ids);
    for (const entry of entries) {
        if (entry.target.model !== model || JSON.stringify(entry.kwargs?.context?.allowed_company_ids) !== companies) {
            continue;
        }
        const values = entry.extras?.overlayValues;
        let patch;
        switch (entry.method) {
            case "web_save":
                patch = values;
                break;
            case "action_archive":
            case "action_unarchive":
                patch = { active: entry.method === "action_unarchive" };
                break;
            case "unlink":
            case "web_unlink":
                patch = null;
                break;
        }
        if (patch === undefined) {
            continue;
        }
        for (const id of entry.target.ids) {
            const existing = changes.get(id);
            changes.set(id, {
                created: existing?.created || entry.createdId === id,
                before: existing?.before || entry.extras?.overlayBefore,
                patch: patch && { ...existing?.patch, ...patch },
            });
        }
    }
    return changes;
}

function asDomainValue(value) {
    if (Array.isArray(value)) {
        return value.map(asDomainValue);
    }
    return value?.id ?? value;
}

function matcher(domain, context, fields) {
    const normalized = new Domain(domain || []);
    const names = normalized.toList().filter(Array.isArray).map(([name]) => name);
    const activeTest = fields.active && context.active_test !== false && !names.includes("active");
    return (row, knownMember = false) => {
        if (!row || (activeTest && row.active === false)) {
            return false;
        }
        if (names.some((name) => !(name in row))) {
            // A cached member was already filtered by the server. Never guess that a new
            // row matches a filter on fields not present in the saved response.
            return knownMember;
        }
        try {
            return normalized.contains(Object.fromEntries(names.map((name) => [name, asDomainValue(row[name])])));
        } catch {
            return knownMember;
        }
    };
}

export function overlayList(result, config, overlay) {
    const matches = matcher(config.domain, config.context, config.fields);
    const visible = new Set(result.records.map((row) => row.id));
    const records = [];
    let length = result.length;
    for (const row of result.records) {
        const change = overlay.get(row.id);
        const updated = !change ? row : change.patch && { ...row, ...change.patch };
        if (!change || matches(updated, true)) {
            records.push(updated);
        } else {
            length--;
        }
    }
    for (const [id, change] of overlay) {
        if (visible.has(id) || !change.patch) {
            continue;
        }
        const before = change.created ? null : change.before;
        const after = { ...before, ...change.patch, id };
        if ((change.created || before) && !matches(before) && matches(after)) {
            length++;
            if (!config.offset) {
                records.unshift(after);
            }
        }
    }
    return { ...result, records, length };
}

export function overlayGroups(result, config, overlay) {
    const candidates = new Map();
    function collect(groups) {
        for (const group of groups) {
            for (const row of group.__records || []) {
                if (overlay.has(row.id)) {
                    candidates.set(row.id, row);
                }
            }
            if (group.__groups) {
                collect(group.__groups.groups);
            }
        }
    }
    collect(result.groups);
    const pairs = [];
    for (const [id, change] of overlay) {
        const before = change.created ? null : candidates.get(id) || change.before;
        if (before || change.created) {
            pairs.push({ id, before, after: change.patch && { ...before, ...change.patch, id } });
        }
    }
    function project(groups, domain, items) {
        return groups.map((source) => {
            const group = { ...source };
            const groupDomain = Domain.and([domain, group.__extra_domain || []]).toList();
            const matches = matcher(groupDomain, config.context, config.fields);
            const deltas = [];
            const shown = new Set((group.__records || []).map((row) => row.id));
            const sums = Object.keys(group).filter((key) => key.endsWith(":sum"));
            for (const { id, before, after } of items) {
                const had = matches(before, shown.has(id));
                const has = matches(after, shown.has(id));
                if (!had && !has) {
                    continue;
                }
                deltas.push({ id, before: had ? before : null, after: has ? after : null });
                group.__count += Number(has) - Number(had);
                for (const sum of sums) {
                    const field = sum.split(":")[0];
                    group[sum] += (has ? Number(after[field]) || 0 : 0) - (had ? Number(before[field]) || 0 : 0);
                }
            }
            if (group.__groups) {
                group.__groups = { ...group.__groups, groups: project(group.__groups.groups, groupDomain, deltas) };
            }
            if (group.__records) {
                const changed = new Map(deltas.map(({ id, after }) => [id, after]));
                group.__records = group.__records.map((row) => changed.has(row.id) ? changed.get(row.id) : row).filter(Boolean);
                if (!group.__offset) {
                    for (const { before, after } of deltas) {
                        if (!before && after && !shown.has(after.id)) {
                            group.__records.unshift(after);
                        }
                    }
                }
            }
            return group;
        });
    }
    return { ...result, groups: project(result.groups, config.domain, pairs) };
}
