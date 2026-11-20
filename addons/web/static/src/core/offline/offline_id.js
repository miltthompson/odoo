// The view/router APIs expect numeric record IDs. Reserve negative IDs for this device;
// send the full UUID, not this shortened local alias, when referring to a queued create.
export function offlineRecordId(key) {
    return -parseInt(key.replaceAll("-", "").slice(0, 13), 16) || -1;
}

export function isOfflineRecordId(id) {
    return Number.isSafeInteger(id) && id < 0;
}

export function offlineRecordRef(key) {
    return `offline:${key}`;
}
