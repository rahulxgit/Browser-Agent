// Small storage boundary for extension data. Secrets are session-only; all
// durable profile/configuration data stays in local storage.
(function (root) {
  const SECRET_KEYS = new Set(["apiKey"]);
  let queue = Promise.resolve();

  async function sessionArea() {
    const { persistApiKey } = await chrome.storage.local.get(["persistApiKey"]);
    if (persistApiKey) return chrome.storage.local;
    return chrome.storage.session || chrome.storage.local;
  }

  function serial(work) {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  }

  async function getProviderConfig() {
    const value = await chrome.storage.local.get(["provider", "gatewayUrl", "model", "taskType"]);
    return value || {};
  }

  async function setProviderConfig(config) {
    const safe = Object.fromEntries(Object.entries(config || {}).filter(([key]) => !SECRET_KEYS.has(key)));
    return chrome.storage.local.set(safe);
  }

  async function getSecret(key = "apiKey") {
    const area = await sessionArea();
    return (await area.get([key]))[key] || "";
  }

  async function setSecret(key = "apiKey", value = "") {
    if (!SECRET_KEYS.has(key)) throw new Error("Unsupported secret key");
    const area = await sessionArea();
    return area.set({ [key]: value });
  }

  async function removeSecret(key = "apiKey") {
    const area = await sessionArea();
    return area.remove([key]);
  }

  async function clearSessionSecrets() {
    const area = await sessionArea();
    return area.remove([...SECRET_KEYS]);
  }

  // Serializes read-modify-write sequences in this service worker so two
  // tabs cannot silently lose each other's update.
  function updateLocal(key, update) {
    return serial(async () => {
      const current = (await chrome.storage.local.get([key]))[key];
      const next = await update(current);
      await chrome.storage.local.set({ [key]: next });
      return next;
    });
  }

  const api = {
    getProviderConfig,
    setProviderConfig,
    getSecret,
    setSecret,
    removeSecret,
    clearSessionSecrets,
    updateLocal,
  };
  root.StorageManager = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
