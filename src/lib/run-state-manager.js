(function (root) {
  const KEY = "activeRuns";
  async function list() {
    return (await (chrome.storage.session || chrome.storage.local).get([KEY]))[KEY] || {};
  }
  async function put(run) {
    const all = await list();
    all[run.runId] = { ...all[run.runId], ...run, updatedAt: Date.now() };
    await (chrome.storage.session || chrome.storage.local).set({ [KEY]: all });
    return all[run.runId];
  }
  async function remove(runId) {
    const all = await list();
    delete all[runId];
    await (chrome.storage.session || chrome.storage.local).set({ [KEY]: all });
  }
  async function pending(runId, pendingAction) {
    return put({ runId, status: pendingAction ? "waiting" : "running", pendingAction: pendingAction || null });
  }
  const api = { KEY, list, put, remove, pending };
  root.RunStateManager = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
