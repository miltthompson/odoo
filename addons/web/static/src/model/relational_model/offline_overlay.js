import { Domain } from "@web/core/domain";
import { getAggregateSpecifications } from "./utils";

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
    const tokens = new Domain(domain || []).toList();
    const activeTest = fields.active && context.active_test !== false &&
        !tokens.some((token) => Array.isArray(token) && token[0] === "active");
    let index = 0;
    // Unread fields are unknown, not false. Evaluate known conditions too: an
    // unread search filter must not hide a definitive change of group membership.
    function predicate() {
        const token = tokens[index++];
        if (token === "!") {
            const child = predicate();
            return (row) => {
                const value = child(row);
                return value === undefined ? value : !value;
            };
        }
        if (token === "&" || token === "|") {
            const left = predicate();
            const right = predicate();
            return (row) => {
                const a = left(row);
                const b = right(row);
                const decisiveValue = token === "|";
                return a === decisiveValue || b === decisiveValue ? decisiveValue :
                    a === undefined || b === undefined ? undefined : !decisiveValue;
            };
        }
        const [name] = token;
        const condition = new Domain([token]);
        return (row) => {
            if (typeof name !== "string" || name in row) {
                try {
                    return condition.contains({ [name]: asDomainValue(row[name]) });
                } catch {
                    return undefined;
                }
            }
        };
    }
    const matches = tokens.length ? predicate() : () => true;
    return (row, knownMember = false) => Boolean(row) &&
        (!activeTest || row.active !== false) && (matches(row) ?? knownMember);
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

function makeLocalGroup(groupBy, value, config) {
    const field = config.fields[groupBy];
    // Granular dates and relational paths require server formatting and boundaries.
    if (!field || !["many2one", "boolean", "selection", "char", "integer"].includes(field.type)) {
        return;
    }
    const key = asDomainValue(value) ?? false;
    const group = {
        [groupBy]: field.type === "many2one" && key ? [key, value.display_name] : key,
        __extra_domain: [[groupBy, "=", key]],
        __count: 0,
    };
    if (field.type === "many2one") {
        // A list group header may instantiate a record for this relation.
        group.__values = key ? { id: key, display_name: value.display_name } : {};
    }
    for (const aggregate of getAggregateSpecifications(config.fields)) {
        group[aggregate] = aggregate.endsWith(":array_agg_distinct") ? [] : false;
    }
    return group;
}

function updateCurrencyAggregates(group, source, deltas, fields, rates, companyCurrency) {
    const currenciesByField = new Map();
    const allRowsKnown = !source.__offset && source.__records?.length === source.__count;
    const amounts = (record, field) => Number(record?.[field]) || 0;
    const currencyId = (record, field) => asDomainValue(record[field]) || false;
    const rate = (id) => !id || id === companyCurrency ? 1 : rates[id]?.rate;
    for (const key of Object.keys(source).filter((key) => key.endsWith(":sum_currency"))) {
        const field = key.split(":")[0];
        const currencyField = fields[field].currency_field;
        const currencyKey = `${currencyField}:array_agg_distinct`;
        const deltaByCurrency = new Map();
        for (const { before, after } of deltas) {
            for (const [row, sign] of [[before, -1], [after, 1]]) {
                if (row) {
                    const id = currencyId(row, currencyField);
                    deltaByCurrency.set(id, (deltaByCurrency.get(id) || 0) + sign * amounts(row, field));
                }
            }
        }
        let total = Number(source[key]) || 0;
        for (const [id, delta] of deltaByCurrency) {
            if (delta) {
                total += delta * (rate(id) ?? NaN);
            }
        }
        // Without a saved rate we cannot show an updated converted total.
        group[key] = Number.isFinite(total) ? total : false;
        if (!currenciesByField.has(currencyField)) {
            const remaining = allRowsKnown ? group.__records.map((row) => currencyId(row, currencyField)) :
                deltas.filter(({ before }) => before).length === source.__count ? [] : source[currencyKey] || [];
            const added = deltas.filter(({ after }) => after).map(({ after }) => currencyId(after, currencyField));
            currenciesByField.set(currencyField, [...new Set([...remaining, ...added])]);
            group[currencyKey] = currenciesByField.get(currencyField);
        }
    }
}

export function overlayGroups(result, config, overlay, rates = {}, companyCurrency) {
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
    const matchesView = matcher(config.domain, config.context, config.fields);
    for (const [id, change] of overlay) {
        const before = change.created ? null : candidates.get(id) || change.before;
        const after = change.patch && { ...before, ...change.patch, id };
        const knownMember = candidates.has(id);
        const had = matchesView(before, knownMember);
        const has = matchesView(after, knownMember);
        if (had || has) {
            pairs.push({ id, before: had ? before : null, after: has ? after : null });
        }
    }
    function project(response, items, level, offset) {
        const sources = [...response.groups];
        const length = response.length ?? sources.length;
        const groupBy = config.groupBy?.[level];
        // If only one page was saved, the destination might be on another page.
        if (groupBy && !offset && sources.length >= length) {
            const existing = new Set(sources.map((source) => {
                const value = source[groupBy];
                return (Array.isArray(value) ? value[0] : asDomainValue(value)) ?? false;
            }));
            for (const { after } of items) {
                if (!after || !(groupBy in after)) {
                    continue;
                }
                const value = after[groupBy];
                const key = asDomainValue(value) ?? false;
                if (!existing.has(key)) {
                    const group = makeLocalGroup(groupBy, value, config);
                    if (group) {
                        if (level + 1 < config.groupBy.length) {
                            group.__groups = { groups: [], length: 0 };
                        } else {
                            group.__records = [];
                        }
                        sources.push(group);
                        existing.add(key);
                    }
                }
            }
        }
        const groups = sources.map((source) => {
            const group = { ...source };
            const matches = matcher(group.__extra_domain, { active_test: false }, config.fields);
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
                group.__groups = project(group.__groups, deltas, level + 1, group.__offset);
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
            if (deltas.length) {
                updateCurrencyAggregates(group, source, deltas, config.fields, rates, companyCurrency);
            }
            return group;
        });
        return { ...response, groups, length: length + sources.length - response.groups.length };
    }
    return project(result, pairs, 0, config.offset);
}
