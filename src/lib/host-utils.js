(function (root) {
  function isHost(hostname, domain) {
    const host = String(hostname || "")
      .toLowerCase()
      .replace(/\.$/, "");
    const base = String(domain || "").toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  }
  const api = { isHost };
  root.HostUtils = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
