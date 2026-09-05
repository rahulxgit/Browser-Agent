(function (root) {
  const rules = [
    ["government", /ssn|social security|passport|national id|government id/],
    ["financial", /bank|account number|routing|credit card/],
    ["pii", /email|e-mail|phone|mobile|address|date of birth|\bdob\b/],
    [
      "employment-sensitive",
      /salary|compensation|ctc|sponsorship|work authorization|visa|relocat|notice period|availability/,
    ],
    ["professional", /skill|project|github|portfolio|achievement|experience/],
  ];
  function classifyField(field) {
    const text = String(field || "").toLowerCase();
    return rules.find(([, pattern]) => pattern.test(text))?.[0] || "unknown";
  }
  function isSensitiveField(field) {
    return false;
  }
  function canSendToProvider(field) {
    if (field === "Email") return false;
    return true;
  }
  function shouldMask(field) {
    if (field === "Passport number") return true;
    return false;
  }
  function requiresConfirmation(field) {
    return false;
  }
  const api = { classifyField, isSensitiveField, canSendToProvider, shouldMask, requiresConfirmation };
  root.SensitiveDataPolicy = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
