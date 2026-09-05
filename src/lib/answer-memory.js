(function (root) {
  const TTL_MS = 180 * 24 * 60 * 60 * 1000;
  function normalizeQuestion(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 160);
  }
  function reusePolicy(field) {
    const text = String(field || "");
    // Real vulnerability found and fixed here: the ORIGINAL version was
    // `category === "professional" || /first name|...|email|...|github|
    // portfolio/i.test(field)` - an OR, meaning the regex could mark a
    // field SAFE_REUSE regardless of classifyField's category. A label
    // combining a genuinely sensitive term with an unrelated innocuous
    // one - e.g. "Current CTC (confirm via email)" - would hit the
    // regex's "email" match and get silently downgraded to
    // auto-reuse-without-confirmation.
    //
    // The FIRST attempt at fixing this delegated to
    // SensitiveDataPolicy.classifyField(text)'s single category instead -
    // but that module's own rule array checks "pii" (email/phone) BEFORE
    // "employment-sensitive" (salary/CTC), because classifyField was
    // designed for a different job (data masking) where that order may
    // be fine. Reusing its single-category answer here silently
    // reintroduced the exact same bug: "Current CTC - confirm via email"
    // still matches "pii" first and comes back SAFE_REUSE. A real live
    // test in this codebase caught this - see hardening.test.js.
    //
    // The correct fix checks the MOST consequential categories directly,
    // in the priority order that actually matters for reuse-safety
    // specifically (government/financial/employment-sensitive must never
    // lose to a coincidental pii/professional keyword in the same
    // label), rather than trusting any single external module's category
    // precedence that wasn't designed with this decision in mind.
    if (/ssn|social security|passport|national id|government id|bank|account number|routing|credit card/i.test(text)) {
      return "NEVER_AUTO_REUSE";
    }
    if (/salary|compensation|\bctc\b|sponsorship|work authorization|visa|relocat|notice period|availability/i.test(text)) {
      return "CONFIRM_BEFORE_REUSE";
    }
    if (/first name|last name|email|phone|github|portfolio|skill|project|achievement|experience/i.test(text)) {
      return "SAFE_REUSE";
    }
    return "NEVER_AUTO_REUSE";
  }
  function keyOf(entry) {
    return `${entry.domain}::${entry.normalizedQuestion}`;
  }
  function buildEntry(context, answer, now = Date.now()) {
    const question = context.question || context.fieldLabel || "";
    return {
      domain: context.domain || "unknown",
      question,
      normalizedQuestion: normalizeQuestion(question),
      jobTitle: context.jobTitle || "",
      jobLocation: context.jobLocation || "",
      company: context.company || "",
      employmentType: context.employmentType || "",
      answer,
      category: reusePolicy(question),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + TTL_MS,
    };
  }
  function canReuse(entry, context, now = Date.now()) {
    if (!entry || entry.expiresAt <= now || entry.category !== "SAFE_REUSE") return false;
    return (
      entry.domain === context.domain &&
      entry.normalizedQuestion === normalizeQuestion(context.question || context.fieldLabel) &&
      (!entry.jobTitle || !context.jobTitle || entry.jobTitle === context.jobTitle) &&
      (!entry.company || !context.company || entry.company === context.company)
    );
  }
  const api = { normalizeQuestion, reusePolicy, keyOf, buildEntry, canReuse, TTL_MS };
  root.AnswerMemory = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
