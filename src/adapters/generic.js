// Generic adapter (Phase 12) - the always-available fallback every other
// adapter falls back to. Every real ATS adapter's hooks are OPTIONAL
// overrides of content.js's existing generic behavior, not replacements
// for it - this file exists mainly to document the interface shape and
// give selectAdapter() something to return when no site-specific adapter
// matches, which is still true for the large majority of job boards.
//
// Every hook returns null/undefined on purpose. content.js only ever
// applies a hook's result when it's truthy - a null here (or a thrown
// error from any adapter, generic or not) always means "fall back to the
// existing generic logic," never "do nothing at all."
(function () {
  const genericAdapter = {
    id: "generic",

    // Always matches - used only as the last resort in selectAdapter(),
    // after every real candidate adapter has already had a chance.
    matches() {
      return true;
    },

    // Returning null tells content.js's extractJobContext() to use its
    // own selector-based fallback (unchanged, pre-Phase-12 behavior).
    extractJobContext() {
      return null;
    },

    // Called once per detected element, after content.js has already
    // built the full generic entry (label, hint, validation state,
    // isCombobox, etc). Returning null makes zero changes to that entry.
    normalizeField() {
      return null;
    },

    // Called before content.js's generic attemptAction() switch runs for
    // a given action. Returning null lets the generic fill/select/click
    // logic (with its own Phase-6 bounded recovery) handle it as normal.
    executeSpecialControl() {
      return null;
    },

    // Called before content.js's generic verifyAction(). Returning null
    // defers to the generic verification rules from Phase 5.
    verifyAction() {
      return null;
    }
  };

  self.__AGENT_ADAPTERS = self.__AGENT_ADAPTERS || [];
  self.__AGENT_ADAPTERS.push(genericAdapter);
})();
