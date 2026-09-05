(function (root) {
  const ALLOWED_ACTION_TYPES = new Set(["fill", "click", "select", "scroll", "wait", "ask", "done"]);
  function validateActionShape(action) {
    if (!action || typeof action !== "object" || Array.isArray(action) || !ALLOWED_ACTION_TYPES.has(action.type))
      return false;
    if (["fill", "click", "select"].includes(action.type) && typeof action.targetId !== "string") return false;
    if (action.type === "ask" && typeof action.question !== "string") return false;
    // Optional on every action type, not required - the system prompt
    // invites but does not mandate it, so an older/simpler model that
    // never sends one must not have its otherwise-valid action rejected.
    // When present, though, it has to actually be a usable confidence
    // value (0-1) - a malformed one (a string, a number outside range) is
    // worse than none at all if something downstream ever trusts it for
    // a threshold decision.
    if (action.confidence !== undefined && (typeof action.confidence !== "number" || action.confidence < 0 || action.confidence > 1)) return false;
    return true;
  }
  function validateActionBatch(value, max = 8) {
    return Array.isArray(value) && value.length <= max && value.every(validateActionShape);
  }
  // Pinpoints exactly which action(s) in a batch fail validation and why,
  // in contrast to validateActionBatch's plain true/false - used to build
  // an actionable error message instead of a generic rejection, the same
  // way a bad-JSON parse failure was already made specific in an earlier
  // phase.
  function describeActionBatchErrors(value) {
    if (!Array.isArray(value)) return ["response was not a JSON array of actions"];
    const errors = [];
    value.forEach((action, i) => {
      if (validateActionShape(action)) return;
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        errors.push(`action[${i}] is not an object`);
      } else if (!ALLOWED_ACTION_TYPES.has(action.type)) {
        errors.push(`action[${i}] has an unrecognized type "${action.type}"`);
      } else if (["fill", "click", "select"].includes(action.type) && typeof action.targetId !== "string") {
        errors.push(`action[${i}] (type "${action.type}") is missing a string targetId`);
      } else if (action.type === "ask" && typeof action.question !== "string") {
        errors.push(`action[${i}] (type "ask") is missing a string question`);
      } else if (action.confidence !== undefined) {
        errors.push(`action[${i}] has an invalid confidence value (must be a number between 0 and 1)`);
      } else {
        errors.push(`action[${i}] failed validation`);
      }
    });
    return errors;
  }
  const api = { ALLOWED_ACTION_TYPES, validateActionShape, validateActionBatch, describeActionBatchErrors };
  root.ActionSchema = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
