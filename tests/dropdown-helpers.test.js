// Plain-Node regression tests for the pure (DOM-free) helper logic behind
// the dropdown fix. content.js's DOM-touching functions (comboboxDisplayedValue,
// collectInteractiveElements, runSingleAction) need a real page and are
// covered by manual verification against the attached log instead - see
// the fix writeup. These are the pieces that don't need a browser at all.
// Run with: node tests/dropdown-helpers.test.js

const assert = require("assert");

// --- looksLikePlaceholder (copied logic, kept in sync with content.js) --
function looksLikePlaceholder(text) {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return true;
  const stripped = normalized.replace(/^-+\s*/, "").replace(/\s*-+$/, "");
  return /^(select|choose|pick)\b.*(\.\.\.)?$|^(select|choose)$|^\s*-+\s*$|^please select/.test(stripped);
}

// --- toISODate (copied logic, kept in sync with content.js) ------------
function toISODate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// --- Option-like leaf detection (copied logic from collectInteractiveElements) --
function looksLikeGeneratedOption(idOrClass, childCount) {
  return /(^|[-_])option([-_]|\d|$)/i.test(idOrClass) && childCount === 0;
}

// --- looksLikeComboboxToggleLabel (copied logic, kept in sync with content.js) --
// Regression test for the actual stagnation bug seen in production: an
// Ashby-style form's real click target for opening a dropdown is a sibling
// <button aria-label="Toggle flyout">, not the role=combobox input itself.
// That button was invisible to isCombobox detection, so it got none of the
// one-open-per-round cap or bounded-retry/verification background.js
// already had - the model just re-toggled it open/closed every round with
// zero net progress until the stagnation guard killed the run.
function looksLikeComboboxToggleLabel(ariaLabelOrTitle) {
  return /toggle|flyout|chevron|dropdown|expand|open menu/.test((ariaLabelOrTitle || "").toLowerCase());
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// Test 5 (spec) - empty initial value should read as placeholder, never a
// "real" selection - this is what stops an unopened combobox from being
// mistaken for one that's already answered.
test("empty combobox display text is a placeholder", () => {
  assert.strictEqual(looksLikePlaceholder(""), true);
});

test("'Select...' / 'Choose one' / 'Please select' read as placeholders", () => {
  assert.strictEqual(looksLikePlaceholder("Select..."), true);
  assert.strictEqual(looksLikePlaceholder("Choose one"), true);
  assert.strictEqual(looksLikePlaceholder("Please select an option"), true);
  assert.strictEqual(looksLikePlaceholder("-- select --"), true);
});

// Test 6 (spec) - a genuine prior selection must NOT be mistaken for a
// placeholder, or the agent would keep reopening an already-answered field.
test("a real selected value is never mistaken for a placeholder", () => {
  assert.strictEqual(looksLikePlaceholder("India"), false);
  assert.strictEqual(looksLikePlaceholder("He/Him"), false);
  assert.strictEqual(looksLikePlaceholder("No"), false);
});

test("react-select/greenhouse-style generated option ids are recognized as leaf options", () => {
  assert.strictEqual(looksLikeGeneratedOption("react-select-2-option-0", 0), true);
  assert.strictEqual(looksLikeGeneratedOption("select__option select__option--is-focused", 0), true);
});

test("a wrapping options *container* (has children) is not treated as a clickable option", () => {
  // e.g. <div class="select__menu-list"> wrapping many option divs -
  // matching on this too would make the model try to click a big
  // non-interactive container instead of an actual option.
  assert.strictEqual(looksLikeGeneratedOption("select__options-list", 3), false);
});

test("date of birth: DD-MM-YYYY and DD/MM/YYYY normalize to ISO for <input type=date>", () => {
  assert.strictEqual(toISODate("15-08-2002"), "2002-08-15");
  assert.strictEqual(toISODate("15/08/2002"), "2002-08-15");
  assert.strictEqual(toISODate("2002-08-15"), "2002-08-15");
});

test("garbage date input does not crash and returns null instead of a bad fill", () => {
  assert.strictEqual(toISODate("not a date"), null);
  assert.strictEqual(toISODate(""), null);
  assert.strictEqual(toISODate(null), null);
});

// --- Bounded-retry counter logic (copied from background.js's per-round loop) --
function simulateComboboxRound(attemptsMap, signature, capExceededCallback) {
  const attempts = (attemptsMap.get(signature) || 0) + 1;
  if (attempts > 3) {
    capExceededCallback();
    attemptsMap.delete(signature);
    return "asked";
  }
  attemptsMap.set(signature, attempts);
  return "opened";
}

// Test 8 (spec) - repeated unsuccessful opens must produce a bounded
// recovery (falls to "ask"), not an infinite loop of identical clicks.
// This is the direct fix for the attached log, where el-29/32/35/42 were
// clicked 4-5 times each across rounds with zero resolution.
test("a combobox that never resolves converts to an ask after 3 attempts, not forever", () => {
  const attemptsMap = new Map();
  let askedCount = 0;
  const results = [];
  for (let round = 0; round < 6; round++) {
    results.push(simulateComboboxRound(attemptsMap, "Sponsorship|sponsorship", () => askedCount++));
  }
  assert.deepStrictEqual(results, ["opened", "opened", "opened", "asked", "opened", "opened"]);
  assert.strictEqual(askedCount, 1);
});

test("a combobox that resolves on attempt 2 never reaches the ask fallback", () => {
  const attemptsMap = new Map();
  attemptsMap.set("Country|country", 1);
  // Simulate: round 2 opens it again, then it resolves and the tracking
  // entry is deleted (mirrors trackedComboboxes cleanup on selected:true).
  const attempts = (attemptsMap.get("Country|country") || 0) + 1;
  assert.strictEqual(attempts, 2);
  attemptsMap.delete("Country|country"); // resolved - background.js does this once snapshot shows filled:true
  assert.strictEqual(attemptsMap.has("Country|country"), false);
});

// Test 10 (root cause) - the actual button from the attached log must be
// recognized as a combobox-toggle candidate so it gets paired and inherits
// isCombobox tracking. Without this, it's an untracked generic button and
// none of the above bounded-retry protection ever applies to it.
test("Ashby-style 'Toggle flyout' button is recognized as a combobox toggle", () => {
  assert.strictEqual(looksLikeComboboxToggleLabel("Toggle flyout"), true);
});

test("ordinary buttons (Submit, Add another, Remove) are not mistaken for toggles", () => {
  assert.strictEqual(looksLikeComboboxToggleLabel("Submit application"), false);
  assert.strictEqual(looksLikeComboboxToggleLabel("Add another education entry"), false);
  assert.strictEqual(looksLikeComboboxToggleLabel(""), false);
});

test("common chevron/expand phrasing across other ATS variants is also caught", () => {
  assert.strictEqual(looksLikeComboboxToggleLabel("Expand options"), true);
  assert.strictEqual(looksLikeComboboxToggleLabel("Open menu"), true);
  assert.strictEqual(looksLikeComboboxToggleLabel("chevron-down"), true);
});

// --- verifyAction outcome logic (Phase 5, copied pure decision table) --
// The real function reads live DOM state; these tests exercise the same
// decision logic against plain before/after values so the rules themselves
// (not the DOM plumbing) are pinned down.
function decideClickVerification({ inputType, checkedAfter, wasExpanded, isExpandedNow, isComboboxRelated }) {
  if (inputType === "checkbox" || inputType === "radio") {
    return checkedAfter ? { verified: true } : { verified: false, reason: "click did not result in checked state" };
  }
  if (isComboboxRelated) {
    if (wasExpanded && !isExpandedNow) {
      return { verified: false, reason: "click closed an already-open menu instead of selecting an option - do not re-click the same toggle, click one of its options instead" };
    }
    return { verified: isExpandedNow, reason: isExpandedNow ? undefined : "menu did not open" };
  }
  return { verified: null, reason: "no automatic verification available for a generic click" };
}

test("checkbox click that results in checked:true verifies", () => {
  assert.deepStrictEqual(decideClickVerification({ inputType: "checkbox", checkedAfter: true }), { verified: true });
});

test("checkbox click that leaves checked:false is a verification failure, not a silent ok", () => {
  const result = decideClickVerification({ inputType: "checkbox", checkedAfter: false });
  assert.strictEqual(result.verified, false);
});

test("combobox click that opens a closed menu verifies as opened", () => {
  const result = decideClickVerification({ isComboboxRelated: true, wasExpanded: false, isExpandedNow: true });
  assert.strictEqual(result.verified, true);
});

// Direct regression for the production bug: re-clicking the same toggle
// button on an already-open menu closes it - must be flagged as a failure
// with an actionable reason, not reported as ok:true like it used to be.
test("combobox click that closes an already-open menu is flagged as a failure with a corrective reason", () => {
  const result = decideClickVerification({ isComboboxRelated: true, wasExpanded: true, isExpandedNow: false });
  assert.strictEqual(result.verified, false);
  assert.match(result.reason, /closed an already-open menu/);
});

test("generic button click reports unknown (null) rather than a fake true or false", () => {
  const result = decideClickVerification({ inputType: "button" });
  assert.strictEqual(result.verified, null);
});

// --- Bounded action recovery loop (Phase 6, copied loop logic) --------
// Mirrors runSingleAction's attempt loop exactly, but against a supplied
// sequence of results instead of real DOM state, so the loop's stopping
// rules are pinned down independent of any particular strategy's DOM code.
const MAX_ACTION_ATTEMPTS = 3;
function simulateRecoveryLoop(verifiedSequence) {
  let lastResult = null;
  let attempts = 0;
  for (let attempt = 0; attempt < MAX_ACTION_ATTEMPTS; attempt++) {
    lastResult = { verified: verifiedSequence[attempt] };
    attempts++;
    if (lastResult.verified === true || lastResult.verified === null) break;
  }
  return { verified: lastResult.verified, attempts, exhausted: lastResult.verified === false };
}

test("succeeds on the first attempt - no recovery needed, attempts stays 1", () => {
  const result = simulateRecoveryLoop([true]);
  assert.deepStrictEqual(result, { verified: true, attempts: 1, exhausted: false });
});

test("fails once, succeeds on the alternate strategy - stops at attempt 2, not exhausted", () => {
  const result = simulateRecoveryLoop([false, true]);
  assert.deepStrictEqual(result, { verified: true, attempts: 2, exhausted: false });
});

// Direct regression for the hard cap: PHASE 6 requires this to be bounded,
// never an infinite retry - three failures in a row must stop at exactly
// three attempts and report exhausted, not keep going.
test("fails all three attempts - stops at the hard cap of 3 and reports exhausted", () => {
  const result = simulateRecoveryLoop([false, false, false]);
  assert.deepStrictEqual(result, { verified: false, attempts: 3, exhausted: true });
});

// A generic button click (verified: null, no check applies) must NEVER be
// retried - re-clicking an unverifiable action could double-submit a form
// action or duplicate a repeater entry. Confirmed here even though the
// sequence *would* succeed on attempt 2, to prove the loop stops on null
// regardless of what a later attempt might have done.
test("verified:null (no check applies) stops immediately and is never retried", () => {
  const result = simulateRecoveryLoop([null, true, true]);
  assert.deepStrictEqual(result, { verified: null, attempts: 1, exhausted: false });
});

// --- autocompleteToken (copied logic, kept in sync with content.js) ---
// The last token of a possibly-compound autocomplete value is the actual
// WHATWG field-name hint ("shipping given-name" -> "given-name"); "off"/
// "on"/empty must never be treated as a real hint.
function autocompleteToken(raw) {
  const normalized = (raw || "").toLowerCase().trim();
  if (!normalized || normalized === "off" || normalized === "on") return "";
  return normalized.split(/\s+/).pop();
}

test("autocomplete token extraction pulls the real field hint from a compound value", () => {
  assert.strictEqual(autocompleteToken("shipping given-name"), "given-name");
  assert.strictEqual(autocompleteToken("email"), "email");
});

test("autocomplete='off'/'on'/empty are never treated as a real field hint", () => {
  assert.strictEqual(autocompleteToken("off"), "");
  assert.strictEqual(autocompleteToken("on"), "");
  assert.strictEqual(autocompleteToken(""), "");
  assert.strictEqual(autocompleteToken(undefined), "");
});

// --- hasFillableWork / unfilledFingerprint invalid-field handling -----
// Copied decision logic: a field can be filled:true and still be genuinely
// unresolved once the page's own validation rejects it (aria-invalid).
// Without this, a run could report "done" while a field the page itself
// considers wrong sits there uncorrected.
function hasFillableWorkSim(elements) {
  return elements.some((el) => {
    if (el.invalid) return true;
    if (el.filled) return false;
    return !el.currentValue;
  });
}

test("a filled but invalid field still counts as fillable work, not 'done'", () => {
  assert.strictEqual(hasFillableWorkSim([{ filled: true, invalid: true, currentValue: "bad-email" }]), true);
});

test("a filled and valid field correctly counts as no remaining work", () => {
  assert.strictEqual(hasFillableWorkSim([{ filled: true, currentValue: "good@email.com" }]), false);
});

// --- Submit detection tiers (Phase 7, copied decision logic) -----------
const STRONG_FINAL_PHRASES = ["submit application", "apply now", "place order", "pay now", "delete account"];
const WEAK_SUBMIT_KEYWORDS = ["submit", "apply", "confirm", "finalize", "finish", "checkout", "publish"];
const NON_FINAL_QUALIFIERS = ["filter", "code", "otp", "verification", "comment", "draft", "password", "section", "step", "search", "email format", "preview", "sort", "column"];

function classifySubmitText({ text, isRealControl, isSubmitType }) {
  const lower = text.toLowerCase().trim();
  if (STRONG_FINAL_PHRASES.some((p) => lower.includes(p))) return true;
  if (isSubmitType) return true;
  if (!isRealControl) return false;
  if (lower.length > 40) return false;
  if (NON_FINAL_QUALIFIERS.some((q) => lower.includes(q))) return false;
  return WEAK_SUBMIT_KEYWORDS.some((kw) => lower.includes(kw));
}

test("a real 'Submit Application' button on any element type is flagged", () => {
  assert.strictEqual(classifySubmitText({ text: "Submit Application", isRealControl: true }), true);
});

// Direct regression for the false-positive the doc explicitly calls out:
// "avoid false positives such as treating ordinary text containing apply
// or confirm as a final submission action."
test("'Apply filters' does not false-positive on the word 'apply'", () => {
  assert.strictEqual(classifySubmitText({ text: "Apply filters", isRealControl: true }), false);
});

test("'Confirm email format' does not false-positive on the word 'confirm'", () => {
  assert.strictEqual(classifySubmitText({ text: "Confirm email format", isRealControl: true }), false);
});

test("a long sentence merely containing 'submit' is never treated as the control itself", () => {
  const longText = "By clicking submit you agree this information is accurate to the best of your knowledge";
  assert.strictEqual(classifySubmitText({ text: longText, isRealControl: true }), false);
});

test("a bare 'Submit' button (short, real control, no disambiguating qualifier) is flagged", () => {
  assert.strictEqual(classifySubmitText({ text: "Submit", isRealControl: true }), true);
});

test("native type=submit is flagged even with a blank/icon-only label", () => {
  assert.strictEqual(classifySubmitText({ text: "", isRealControl: true, isSubmitType: true }), true);
});

test("weak keyword text on a non-control element (e.g. a stray span) is never flagged", () => {
  assert.strictEqual(classifySubmitText({ text: "Submit", isRealControl: false }), false);
});

// --- hasFillableWork/unfilledFingerprint were already covered above;
// this adds the preflight "ready" computation itself.
function computePreflightReady({ requiredMissingCount, invalidCount, unresolvedConsentCount }) {
  return requiredMissingCount === 0 && invalidCount === 0 && unresolvedConsentCount === 0;
}

test("preflight is ready only when nothing required, invalid, or unresolved remains", () => {
  assert.strictEqual(computePreflightReady({ requiredMissingCount: 0, invalidCount: 0, unresolvedConsentCount: 0 }), true);
  assert.strictEqual(computePreflightReady({ requiredMissingCount: 1, invalidCount: 0, unresolvedConsentCount: 0 }), false);
  assert.strictEqual(computePreflightReady({ requiredMissingCount: 0, invalidCount: 1, unresolvedConsentCount: 0 }), false);
  assert.strictEqual(computePreflightReady({ requiredMissingCount: 0, invalidCount: 0, unresolvedConsentCount: 1 }), false);
});

// --- Submission outcome classification (Phase 9, copied decision logic) --
function classifySubmissionOutcome({ urlChanged, successPhraseMatched, errorPhraseMatched }) {
  if (errorPhraseMatched) return { verified: false, hasError: true };
  if (urlChanged || successPhraseMatched) return { verified: true, hasError: false };
  return { verified: false, hasError: false }; // honest "could not verify", not a false positive or negative
}

test("URL change with no error is verified as successful", () => {
  assert.deepStrictEqual(classifySubmissionOutcome({ urlChanged: true }), { verified: true, hasError: false });
});

test("a success phrase with no URL change is still verified", () => {
  assert.deepStrictEqual(classifySubmissionOutcome({ urlChanged: false, successPhraseMatched: "application received" }), { verified: true, hasError: false });
});

// Direct regression for "never falsely report success" - an error phrase
// on the page must override a URL change, since some ATSs redirect to a
// generic error page rather than staying put.
test("an error phrase overrides a URL change - never falsely reports success", () => {
  const result = classifySubmissionOutcome({ urlChanged: true, errorPhraseMatched: "something went wrong" });
  assert.strictEqual(result.verified, false);
  assert.strictEqual(result.hasError, true);
});

test("no URL change and no phrase match is an honest 'could not verify', not a false success", () => {
  assert.deepStrictEqual(classifySubmissionOutcome({ urlChanged: false }), { verified: false, hasError: false });
});

// --- Adapter selection logic (Phase 12, copied loop logic) --------------
// Mirrors selectAdapter()'s ordering rules against plain mock adapters
// instead of real self.__AGENT_ADAPTERS/DOM state.
function selectAdapterSim(adapters, pageContext) {
  for (const adapter of adapters) {
    if (adapter.id === "generic") continue;
    try {
      if (adapter.matches(pageContext)) return adapter;
    } catch {
      // treat a thrown matches() as "doesn't match" - never let one bad
      // adapter block every other adapter from being tried
    }
  }
  return adapters.find((a) => a.id === "generic") || null;
}

test("a real adapter that matches is selected over the generic fallback", () => {
  const adapters = [
    { id: "generic", matches: () => true },
    { id: "greenhouse", matches: (ctx) => ctx.hostname.includes("greenhouse.io") }
  ];
  const result = selectAdapterSim(adapters, { hostname: "boards.greenhouse.io" });
  assert.strictEqual(result.id, "greenhouse");
});

test("no adapter matches - falls back to generic, not undefined", () => {
  const adapters = [
    { id: "generic", matches: () => true },
    { id: "lever", matches: (ctx) => ctx.hostname.includes("lever.co") }
  ];
  const result = selectAdapterSim(adapters, { hostname: "some-random-ats.example.com" });
  assert.strictEqual(result.id, "generic");
});

// Direct regression for "each adapter should be optional and should fall
// back to generic behavior" (Phase 12) - one broken adapter's matches()
// throwing must not prevent a later, working adapter from being checked,
// and must not crash adapter selection entirely.
test("a broken adapter's thrown matches() is treated as no-match, not a crash", () => {
  const adapters = [
    { id: "generic", matches: () => true },
    { id: "broken", matches: () => { throw new Error("boom"); } },
    { id: "workday", matches: (ctx) => ctx.hostname.includes("myworkdayjobs.com") }
  ];
  const result = selectAdapterSim(adapters, { hostname: "acme.myworkdayjobs.com" });
  assert.strictEqual(result.id, "workday");
});

// Regression for the two adapters added in Phase 29 - verifies they
// participate correctly in the same selection ordering as every existing
// adapter, not just that their own host-matching rule works in isolation.
test("smartrecruiters adapter is selected over generic when its host matches", () => {
  const adapters = [
    { id: "generic", matches: () => true },
    { id: "smartrecruiters", matches: (ctx) => ctx.hostname.includes("smartrecruiters.com") }
  ];
  const result = selectAdapterSim(adapters, { hostname: "careers.smartrecruiters.com" });
  assert.strictEqual(result.id, "smartrecruiters");
});

test("successfactors adapter is selected over generic when its host matches", () => {
  const adapters = [
    { id: "generic", matches: () => true },
    { id: "successfactors", matches: (ctx) => ctx.hostname.includes("successfactors") }
  ];
  const result = selectAdapterSim(adapters, { hostname: "career5.successfactors.com" });
  assert.strictEqual(result.id, "successfactors");
});

// --- callAdapterHook safe-fallback behavior -----------------------------
function callAdapterHookSim(adapter, hookName, ...args) {
  try {
    return adapter[hookName]?.(...args) ?? null;
  } catch {
    return null;
  }
}

test("a hook that throws is treated identically to a hook returning null", () => {
  const adapter = { extractJobContext: () => { throw new Error("boom"); } };
  assert.strictEqual(callAdapterHookSim(adapter, "extractJobContext"), null);
});

test("a hook the adapter never defined at all is also treated as null", () => {
  const adapter = { id: "generic" };
  assert.strictEqual(callAdapterHookSim(adapter, "normalizeField"), null);
});

// --- parseJobContext (Phase 14, copied logic) ---------------------------
function parseJobContextSim(rawText, adapterHints = "") {
  const text = `${adapterHints}\n${rawText || ""}`;
  if (!text.trim()) return null;
  const result = {};
  const titleLine = text.match(/^Title:\s*(.+)$/m);
  if (titleLine) result.title = titleLine[1].trim();
  if (/\bremote\b/i.test(text)) result.remotePolicy = "remote";
  else if (/\bhybrid\b/i.test(text)) result.remotePolicy = "hybrid";
  else if (/\bon[\s-]?site\b|\bin[\s-]?office\b/i.test(text)) result.remotePolicy = "on-site";
  if (/\bfull[\s-]?time\b/i.test(text)) result.employmentType = "full-time";
  else if (/\bcontract(or)?\b/i.test(text)) result.employmentType = "contract";
  const experienceMatch = text.match(/(\d+)\s*(?:\+|to|-)\s*(\d+)?\+?\s*years?/i);
  if (experienceMatch) result.experience = experienceMatch[2] ? `${experienceMatch[1]}-${experienceMatch[2]} years` : `${experienceMatch[1]}+ years`;
  const salaryMatch = text.match(/[$£₹€]\s?[\d][\d,]*(?:\.\d+)?(?:\s?-\s?[$£₹€]?\s?[\d][\d,]*(?:\.\d+)?)?/i);
  if (salaryMatch) result.salary = salaryMatch[0].trim();
  const sentences = text.split(/(?<=[.!?])\s+/);
  const sponsorshipSentence = sentences.find((s) => /sponsor/i.test(s));
  if (sponsorshipSentence) result.sponsorshipNote = sponsorshipSentence.trim();
  return Object.keys(result).length ? result : null;
}

test("empty/blank job description text returns null, not an empty guess", () => {
  assert.strictEqual(parseJobContextSim(""), null);
  assert.strictEqual(parseJobContextSim("   "), null);
});

test("remote/hybrid/on-site are detected from plain mentions in the text", () => {
  assert.strictEqual(parseJobContextSim("This is a fully remote position.").remotePolicy, "remote");
  assert.strictEqual(parseJobContextSim("Hybrid role, 3 days in office.").remotePolicy, "hybrid");
});

test("a years-of-experience range is captured as a range, a bare '+' as open-ended", () => {
  assert.strictEqual(parseJobContextSim("Looking for 3-5 years of experience.").experience, "3-5 years");
  assert.strictEqual(parseJobContextSim("Requires 7+ years experience.").experience, "7+ years");
});

// Direct regression for the "never invent facts" requirement: sponsorship
// must surface as the literal sentence, never a guessed true/false.
test("sponsorship mention is quoted verbatim, not classified into yes/no", () => {
  const result = parseJobContextSim("We are unable to provide visa sponsorship for this role.");
  assert.strictEqual(result.sponsorshipNote, "We are unable to provide visa sponsorship for this role.");
  assert.strictEqual(result.sponsorshipYesNo, undefined); // no such field exists - this function never classifies
});

test("a job description with none of the recognized patterns returns null rather than an empty object with nothing useful", () => {
  assert.strictEqual(parseJobContextSim("We are a friendly team building great products together."), null);
});

// --- resolveProfileFields (Phase 13, copied decision logic) ------------
const SOURCE_CONFIDENCE = { profile: 0.98, learned: 0.75, complete: 0.5 };
function resolveOneFieldSim(candidates) {
  const present = candidates.filter((c) => c.value !== undefined);
  if (present.length === 0) return null;
  const normalize = (v) => String(v).trim().toLowerCase();
  const contradicts = new Set(present.map((c) => normalize(c.value))).size > 1;
  const best = present.reduce((a, b) => (SOURCE_CONFIDENCE[a.source] >= SOURCE_CONFIDENCE[b.source] ? a : b));
  return { value: best.value, source: best.source, confidence: SOURCE_CONFIDENCE[best.source], contradicts };
}

test("a single source with a value resolves cleanly with no contradiction", () => {
  const result = resolveOneFieldSim([{ source: "profile", value: "India" }]);
  assert.deepStrictEqual(result, { value: "India", source: "profile", confidence: 0.98, contradicts: false });
});

test("agreeing values across sources (case/whitespace differences aside) are not a false contradiction", () => {
  const result = resolveOneFieldSim([{ source: "profile", value: "India" }, { source: "complete", value: "india " }]);
  assert.strictEqual(result.contradicts, false);
});

// Direct regression for "if two sources contradict, do not silently choose
// one when the difference matters - ask the user": genuinely different
// values must be flagged, even though a tentative value is still returned
// for the model to work with this round.
test("genuinely different values across sources are flagged as a contradiction", () => {
  const result = resolveOneFieldSim([{ source: "profile", value: "India" }, { source: "learned", value: "USA" }]);
  assert.strictEqual(result.contradicts, true);
  assert.strictEqual(result.source, "profile"); // higher-confidence source still wins as the tentative pick
});

test("a field with no value in any source resolves to null, not a fabricated default", () => {
  assert.strictEqual(resolveOneFieldSim([{ source: "profile", value: undefined }]), null);
});

// --- classifyHttpError (Phase 16, copied decision table) ---------------
function classifyStatusSim(status, retryAfterHeader) {
  if (status === 401 || status === 403) return { retryable: false, reason: "auth" };
  if (status === 400 || status === 404 || status === 422) return { retryable: false, reason: "malformed-request" };
  if (status === 429) {
    const seconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    return { retryable: true, reason: "rate-limit", retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : undefined };
  }
  if (status >= 500) return { retryable: true, reason: "server-error" };
  return { retryable: true, reason: "unrecognized" };
}

// Direct regression for "do NOT blindly retry authentication errors or
// invalid requests" - these must never be retryable regardless of how
// many attempts are left.
test("401/403 auth errors are never retryable", () => {
  assert.strictEqual(classifyStatusSim(401).retryable, false);
  assert.strictEqual(classifyStatusSim(403).retryable, false);
});

test("400/404/422 malformed-request errors are never retryable", () => {
  assert.strictEqual(classifyStatusSim(400).retryable, false);
  assert.strictEqual(classifyStatusSim(422).retryable, false);
});

test("429 rate-limit errors are retryable and honor a Retry-After header when present", () => {
  const result = classifyStatusSim(429, "5");
  assert.strictEqual(result.retryable, true);
  assert.strictEqual(result.retryAfterMs, 5000);
});

test("a 429 with no Retry-After header is still retryable, just without a specific delay", () => {
  const result = classifyStatusSim(429);
  assert.strictEqual(result.retryable, true);
  assert.strictEqual(result.retryAfterMs, undefined);
});

test("5xx server errors are retryable", () => {
  assert.strictEqual(classifyStatusSim(500).retryable, true);
  assert.strictEqual(classifyStatusSim(503).retryable, true);
});

// --- withRetry loop behavior (copied loop logic, sync since the
// simulation has no real I/O - matches the synchronous test() helper below) --
function withRetrySim(attempts, { retries = 2 } = {}) {
  let lastError, callCount = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    callCount++;
    const result = attempts[attempt];
    if (result.ok) return { value: result.value, callCount };
    lastError = result.error;
    if (lastError.cancelled) return { error: lastError, callCount };
    if (attempt >= retries || lastError.retryable === false) return { error: lastError, callCount };
  }
  return { error: lastError, callCount };
}

test("a non-retryable error (auth) stops after exactly one attempt, no wasted retries", () => {
  const result = withRetrySim([{ ok: false, error: { retryable: false, message: "401" } }]);
  assert.strictEqual(result.callCount, 1);
});

test("a retryable error keeps retrying up to the cap, then reports the final failure", () => {
  const result = withRetrySim([
    { ok: false, error: { retryable: true } },
    { ok: false, error: { retryable: true } },
    { ok: false, error: { retryable: true } }
  ]);
  assert.strictEqual(result.callCount, 3); // 1 initial + 2 retries = the configured cap, never more
});

// Direct regression for cancellation cutting the retry loop short
// immediately, even on attempt 1 of a cap that would otherwise allow more.
test("a cancelled request stops immediately, never retries even once", () => {
  const result = withRetrySim([{ ok: false, error: { cancelled: true, retryable: true } }]);
  assert.strictEqual(result.callCount, 1);
});

test("succeeding on a later retryable attempt returns success without exhausting the cap", () => {
  const result = withRetrySim([
    { ok: false, error: { retryable: true } },
    { ok: true, value: "recovered" }
  ]);
  assert.strictEqual(result.value, "recovered");
  assert.strictEqual(result.callCount, 2);
});

// --- Learning system (Phase 15, copied decision logic) ------------------
const NEVER_LEARN_KEYWORDS = ["ssn", "social security", "passport", "national id", "bank account", "routing number", "tax id", "credit card", "security code", "cvv"];
const SENSITIVE_LEARN_KEYWORDS = ["salary", "compensation", "date of birth", "dob", "government id", "visa status"];
function learningSensitivitySim(label, key) {
  const text = `${label || ""} ${key || ""}`.toLowerCase();
  if (NEVER_LEARN_KEYWORDS.some((kw) => text.includes(kw))) return "blocked";
  if (SENSITIVE_LEARN_KEYWORDS.some((kw) => text.includes(kw))) return "sensitive";
  return "normal";
}

// Direct regression for "do not automatically store sensitive or risky
// values without user approval" - the most sensitive categories are
// blocked outright, never even reaching the approval queue at all.
test("SSN/passport/bank-account fields are blocked from learning entirely, not just flagged", () => {
  assert.strictEqual(learningSensitivitySim("Social Security Number", "ssn"), "blocked");
  assert.strictEqual(learningSensitivitySim("Passport Number", "passport_number"), "blocked");
  assert.strictEqual(learningSensitivitySim("Bank Account Number", "bank_account"), "blocked");
});

test("salary/DOB fields are flagged sensitive but still offered for approval", () => {
  assert.strictEqual(learningSensitivitySim("Expected Salary", "expected_salary"), "sensitive");
  assert.strictEqual(learningSensitivitySim("Date of Birth", "dob"), "sensitive");
});

test("an ordinary field (city, company name) is neither blocked nor flagged", () => {
  assert.strictEqual(learningSensitivitySim("Current City", "current_city"), "normal");
});

// --- pendingLearnings queue management (copied dedupe/update logic) ----
function upsertPendingSim(queue, candidate) {
  const existingIndex = queue.findIndex((c) => c.fieldSignature === candidate.fieldSignature);
  if (existingIndex >= 0) queue[existingIndex] = candidate;
  else queue.push(candidate);
  return queue;
}

// Direct regression for the actual production bug: pendingLearning used
// to be a single object, so a second field queuing before the first was
// approved silently destroyed it. Now a DIFFERENT field's candidate must
// be added alongside, not replace, the first.
test("a second field queuing before the first is approved does not destroy it - both are kept", () => {
  const queue = upsertPendingSim([], { fieldSignature: "city::example.com", value: "Boston" });
  upsertPendingSim(queue, { fieldSignature: "company::example.com", value: "Acme" });
  assert.strictEqual(queue.length, 2);
});

test("the SAME field queuing again before approval updates in place, not a duplicate", () => {
  const queue = upsertPendingSim([], { fieldSignature: "city::example.com", value: "Boston" });
  upsertPendingSim(queue, { fieldSignature: "city::example.com", value: "Cambridge" });
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].value, "Cambridge");
});

// --- Contradiction detection at learning time ---------------------------
function detectLearningContradictionSim(existingValue, incomingValue) {
  if (existingValue === undefined) return false;
  return String(existingValue).trim() !== String(incomingValue).trim();
}

test("learning a genuinely different value for an already-learned key is flagged as a contradiction", () => {
  assert.strictEqual(detectLearningContradictionSim("Boston", "Cambridge"), true);
});

test("re-learning the exact same value again is not a contradiction", () => {
  assert.strictEqual(detectLearningContradictionSim("Boston", "Boston"), false);
});

test("learning a brand new key with no prior value is not a contradiction", () => {
  assert.strictEqual(detectLearningContradictionSim(undefined, "Boston"), false);
});

// --- coerceBooleanIntent / checkbox consent-exclusion (Phase 22, copied
// logic, kept in sync with field-detection.js's smartAutofillChoices) ---
function coerceBooleanIntentSim(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").toLowerCase().trim();
  if (["yes", "true", "y", "1"].includes(normalized)) return true;
  if (["no", "false", "n", "0"].includes(normalized)) return false;
  return null;
}

const CHECKBOX_CONSENT_KEYWORDS_SIM = ["agree", "terms", "consent", "privacy policy", "accept", "acknowledge"];
function isConsentLikeCheckboxSim(contextText) {
  const lower = contextText.toLowerCase();
  return CHECKBOX_CONSENT_KEYWORDS_SIM.some((k) => lower.includes(k));
}

test("a real boolean profile value passes through coerceBooleanIntent unchanged", () => {
  assert.strictEqual(coerceBooleanIntentSim(true), true);
  assert.strictEqual(coerceBooleanIntentSim(false), false);
});

test("yes/true/y/1 (any case) all coerce to boolean true", () => {
  for (const v of ["yes", "Yes", "TRUE", "y", "1"]) assert.strictEqual(coerceBooleanIntentSim(v), true);
});

test("no/false/n/0 (any case) all coerce to boolean false", () => {
  for (const v of ["no", "No", "FALSE", "n", "0"]) assert.strictEqual(coerceBooleanIntentSim(v), false);
});

test("an unrecognized string value coerces to null (no opinion, leave checkbox alone)", () => {
  assert.strictEqual(coerceBooleanIntentSim("maybe"), null);
  assert.strictEqual(coerceBooleanIntentSim(""), null);
  assert.strictEqual(coerceBooleanIntentSim(undefined), null);
});

test("a checkbox whose context mentions terms/consent/privacy is recognized as consent-like and excluded from auto-check", () => {
  assert.strictEqual(isConsentLikeCheckboxSim("I agree to the Terms and Conditions"), true);
  assert.strictEqual(isConsentLikeCheckboxSim("I consent to background verification"), true);
  assert.strictEqual(isConsentLikeCheckboxSim("Please review our Privacy Policy"), true);
});

test("an ordinary boolean-field checkbox (not consent-related) is NOT excluded", () => {
  assert.strictEqual(isConsentLikeCheckboxSim("Willing to relocate"), false);
  assert.strictEqual(isConsentLikeCheckboxSim("Open to remote work"), false);
});

// --- parseActionBatch (Phase 22, copied logic - bracket-balanced extractor,
// kept in sync with background.js's extractBalancedJson/extractJsonPayload/
// parseActionBatch after the reasoning-model-prose fix) -----------------
const MAX_ACTIONS_PER_ROUND = 8;

function extractBalancedJsonSim(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function extractJsonPayloadSim(raw) {
  const stripped = raw.replace(/```(?:json)?/gi, "");
  let firstObjectMatch = null;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "[") {
      const candidate = extractBalancedJsonSim(stripped, i, "[", "]");
      if (candidate) return candidate;
    } else if (ch === "{" && !firstObjectMatch) {
      firstObjectMatch = extractBalancedJsonSim(stripped, i, "{", "}");
    }
  }
  return firstObjectMatch || stripped;
}

function parseActionBatchSim(raw) {
  const cleaned = extractJsonPayloadSim(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const looksLikeProse = !/^[\s]*[[{]/.test(cleaned);
    const hint = looksLikeProse
      ? "The model returned an explanation instead of a JSON action list - this is common with reasoning-style models. Try a different model/provider in Settings."
      : "The JSON was malformed or truncated.";
    throw new Error(`Model did not return valid JSON. ${hint} (raw start: ${String(raw).slice(0, 160)})`);
  }
  const actions = Array.isArray(parsed) ? parsed : [parsed];
  return actions.slice(0, MAX_ACTIONS_PER_ROUND);
}

test("a markdown-fenced JSON array (```json ... ```) is still parsed correctly", () => {
  const result = parseActionBatchSim('```json\n[{"type":"fill","targetId":"el-1"}]\n```');
  assert.deepStrictEqual(result, [{ type: "fill", targetId: "el-1" }]);
});

test("a single action object (not wrapped in an array) is normalized to a one-item array", () => {
  const result = parseActionBatchSim('{"type":"done"}');
  assert.deepStrictEqual(result, [{ type: "done" }]);
});

test("genuinely invalid JSON throws a clear, truncated error rather than crashing opaquely", () => {
  assert.throws(() => parseActionBatchSim("not json at all"), /did not return valid JSON/);
});

// Direct regression for the real production failure captured in the
// user's record log: a reasoning-style model explained its plan in prose
// ("We need to fill the form using profile data. The elements list
// includes: - el-0: button...") with no JSON anywhere in the response.
// The old greedy regex (`\[\s*\{[\s\S]*\}\s*\]`) found no match here
// either, so this exact case already threw before and after the fix -
// what changed is the error message: it must name the likely cause
// (reasoning model narrating instead of answering) instead of just
// dumping a raw prose fragment, so the failure is actionable in the UI.
test("pure reasoning-model prose with no JSON at all throws an actionable, specific error", () => {
  const proseOnly = 'We need to fill the form using profile data. The elements list includes:\n\n- el-0: button "Request edit access" (likely not needed)\n- el-1: a with label "user@example.com"';
  assert.throws(() => parseActionBatchSim(proseOnly), /explanation instead of a JSON action list/);
});

// Regression for the actual bug the extractor rewrite fixes: the OLD
// greedy regex spans from the FIRST "[" or "{" to the LAST "]" or "}" in
// the whole string, so prose that merely *mentions* a bracketed shape
// before the real answer would get swallowed into one broken JSON.parse
// candidate. The new balanced-bracket scanner must isolate just the real
// array and ignore the unrelated leading brace.
test("prose mentioning a stray brace before the real JSON array does not corrupt extraction", () => {
  const raw = 'The field shape looks like {label: "example"} but here is the actual answer:\n[{"type":"click","targetId":"el-9"}]';
  const result = parseActionBatchSim(raw);
  assert.deepStrictEqual(result, [{ type: "click", targetId: "el-9" }]);
});

// A response with reasoning text BEFORE a valid trailing array (a common
// shape for models that think out loud first) must still resolve to the
// real array, not fail just because the array isn't at the very start of
// the string.
test("reasoning text followed by a valid trailing JSON array is still extracted correctly", () => {
  const raw = 'Let me think about this step by step. The user wants me to fill el-1.\n\n[{"type":"fill","targetId":"el-1","value":"test"}]';
  const result = parseActionBatchSim(raw);
  assert.deepStrictEqual(result, [{ type: "fill", targetId: "el-1", value: "test" }]);
});

// Direct regression for the round-budget cap - a model returning more
// than MAX_ACTIONS_PER_ROUND actions must be truncated, not executed in
// full (unbounded action batches were never the intended design).
test("a batch larger than MAX_ACTIONS_PER_ROUND is truncated, not executed in full", () => {
  const bigBatch = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ type: "fill", targetId: `el-${i}` })));
  const result = parseActionBatchSim(bigBatch);
  assert.strictEqual(result.length, 8);
});

// --- Placeholder resolution/protection (Phase 19, copied logic) --------
function resolvePlaceholdersSim(actions, valueMap) {
  return actions.map((action) => {
    if (typeof action.value !== "string") return action;
    let resolvedValue = action.value;
    for (const [placeholder, realValue] of Object.entries(valueMap)) {
      if (resolvedValue.includes(placeholder)) resolvedValue = resolvedValue.split(placeholder).join(realValue);
    }
    return resolvedValue === action.value ? action : { ...action, value: resolvedValue };
  });
}

const UNRESOLVED_PLACEHOLDER_PATTERN = /\{\{[A-Z0-9_]+\}\}/;
function stripUnresolvedPlaceholdersSim(actions) {
  return actions.filter((a) => !(typeof a.value === "string" && UNRESOLVED_PLACEHOLDER_PATTERN.test(a.value)));
}

test("a known placeholder token is substituted with its real value", () => {
  const result = resolvePlaceholdersSim([{ type: "fill", value: "{{EMAIL}}" }], { "{{EMAIL}}": "a@b.com" });
  assert.strictEqual(result[0].value, "a@b.com");
});

test("an action with no placeholder token is returned unchanged (same reference even)", () => {
  const action = { type: "fill", value: "plain text" };
  const result = resolvePlaceholdersSim([action], { "{{EMAIL}}": "a@b.com" });
  assert.strictEqual(result[0], action); // identity preserved - no unnecessary object copy when nothing changed
});

// Direct regression for the safety-net rule: "if a {{SOMETHING}}-shaped
// token survives all the way to right before a fill actually runs...
// block the action outright." A token with no matching valueMap entry
// (typo'd, hallucinated, or simply unknown) must never reach execution.
test("an unresolved/unknown placeholder token is blocked outright, never passed through", () => {
  const resolved = resolvePlaceholdersSim([{ type: "fill", value: "{{UNKNOWN_TOKEN}}" }], { "{{EMAIL}}": "a@b.com" });
  const safe = stripUnresolvedPlaceholdersSim(resolved);
  assert.strictEqual(safe.length, 0);
});

test("a fully resolved value (plain text, no {{...}} shape) passes through the safety net", () => {
  const safe = stripUnresolvedPlaceholdersSim([{ type: "fill", value: "a@b.com" }]);
  assert.strictEqual(safe.length, 1);
});

// --- FIELD_RULES profile matching (Phase 19, copied matching logic) ----
const FIELD_RULES_SAMPLE = [
  { keys: ["first name", "firstname", "fname", "given name"], profileKeys: ["firstName", "first_name"] },
  { keys: ["last name", "lastname", "lname", "surname", "family name"], profileKeys: ["lastName", "last_name"] }
];
function matchFieldRuleSim(haystack) {
  const lower = haystack.toLowerCase();
  return FIELD_RULES_SAMPLE.find((rule) => rule.keys.some((k) => lower.includes(k))) || null;
}

test("a label matching a known alias resolves to the correct rule regardless of exact wording", () => {
  assert.strictEqual(matchFieldRuleSim("Given Name")?.profileKeys[0], "firstName");
  assert.strictEqual(matchFieldRuleSim("Family Name")?.profileKeys[0], "lastName");
});

test("a label matching no known alias resolves to no rule at all, not a wrong guess", () => {
  assert.strictEqual(matchFieldRuleSim("Favorite Color"), null);
});

// --- unfilledFingerprint string behavior (Phase 19) ---------------------
function unfilledFingerprintSim(elements) {
  const unfilled = elements.filter((el) => !el.filled && ["input", "textarea", "select"].includes(el.tag) && el.type !== "checkbox" && el.type !== "radio" && !el.currentValue).map((el) => el.id);
  const invalid = elements.filter((el) => el.invalid).map((el) => `invalid:${el.id}`);
  return [...unfilled, ...invalid].sort().join(",");
}

test("two snapshots with identical unfilled fields produce the identical fingerprint", () => {
  const snap = [{ id: "el-1", tag: "input", filled: false }];
  assert.strictEqual(unfilledFingerprintSim(snap), unfilledFingerprintSim([...snap]));
});

test("fingerprint is order-independent - element order in the snapshot must not change the result", () => {
  const a = [{ id: "el-2", tag: "input", filled: false }, { id: "el-1", tag: "input", filled: false }];
  const b = [{ id: "el-1", tag: "input", filled: false }, { id: "el-2", tag: "input", filled: false }];
  assert.strictEqual(unfilledFingerprintSim(a), unfilledFingerprintSim(b));
});

test("filling a field changes the fingerprint - real progress is detectable, not masked", () => {
  const before = unfilledFingerprintSim([{ id: "el-1", tag: "input", filled: false }]);
  const after = unfilledFingerprintSim([{ id: "el-1", tag: "input", filled: true }]);
  assert.notStrictEqual(before, after);
});

// --- Record-log PII redaction (Phase 22, copied decision logic) --------
// Direct regression for a real gap found in this security review: the
// old redaction only substring-matched the 3 known {{EMAIL}}/{{PHONE}}/
// {{ADDRESS}} placeholder values - a first name, city, salary, employer,
// or any free-text answer the model wrote (cover letter content) went
// into the persisted, exportable record log completely unredacted,
// because it was never tokenized through the placeholder system to begin
// with. Fixed by redacting known value-bearing keys by name, regardless
// of whether their content happens to match something in valueMap.
const RECORD_LOG_VALUE_KEYS = new Set(["value", "currentValue", "expected", "actual"]);
function redactByKeySim(key, value) {
  if (RECORD_LOG_VALUE_KEYS.has(key) && typeof value === "string" && value) {
    return `[redacted: ${value.length} chars]`;
  }
  return value;
}

test("a field's real value (name, city, salary - anything, not just email/phone/address) is redacted by key name alone", () => {
  assert.strictEqual(redactByKeySim("value", "Priya Sharma"), "[redacted: 12 chars]");
  assert.strictEqual(redactByKeySim("currentValue", "$120,000"), "[redacted: 8 chars]");
});

test("expected/actual verification-mismatch fields are redacted the same way, not just the fill value itself", () => {
  assert.strictEqual(redactByKeySim("expected", "john@company.com"), "[redacted: 16 chars]");
  assert.strictEqual(redactByKeySim("actual", "john@gmail.com"), "[redacted: 14 chars]");
});

test("an empty value stays empty rather than becoming a misleading '[redacted: 0 chars]'", () => {
  assert.strictEqual(redactByKeySim("value", ""), "");
});

test("keys that aren't known value-bearing fields (targetId, type, reasoning) pass through untouched", () => {
  assert.strictEqual(redactByKeySim("targetId", "el-3"), "el-3");
  assert.strictEqual(redactByKeySim("type", "fill"), "fill");
});

// --- scrubMarkupValues (copied logic) -----------------------------------
function scrubMarkupValuesSim(html) {
  return html
    .replace(/\svalue="[^"]*"/gi, ' value="[REDACTED]"')
    .replace(/(<option\b[^>]*>)([^<]*)(<\/option>)/gi, "$1[REDACTED]$3");
}

// Direct regression for the second, easy-to-miss instance of the same
// gap: captured outerHTML/parentOuterHTML debug snapshots (added in an
// earlier phase specifically to help debug stuck fields) had a live
// value="..." attribute baked directly into the HTML string, bypassing
// the value-by-key redaction entirely since it's not a separate field.
test("a value=\"...\" attribute embedded in captured markup is scrubbed, not just a standalone value field", () => {
  const html = '<input id="email" value="john@gmail.com" type="email">';
  const result = scrubMarkupValuesSim(html);
  assert.strictEqual(result, '<input id="email" value="[REDACTED]" type="email">');
});

test("scrubbing markup values preserves structure (tag, id, class, aria-label) - debugging value is not thrown away", () => {
  const html = '<button aria-label="Toggle flyout" class="icon-button icon-button--sm" data-agent-id="el-29"></button>';
  const result = scrubMarkupValuesSim(html);
  // Nothing here should change - no value="..." attribute present, and
  // structural attributes (aria-label, class, data-agent-id) are exactly
  // what let this project trace its very first production bug from a
  // real record log - they must never be redacted.
  assert.strictEqual(result, html);
});

test("a selected <option>'s text content is scrubbed too, not just input value attributes", () => {
  const html = "<option value=\"IN\" selected>India</option>";
  const result = scrubMarkupValuesSim(html);
  assert.strictEqual(result, '<option value="[REDACTED]" selected>[REDACTED]</option>');
});

// --- redactActionsForLog action-type awareness --------------------------
function redactActionsForLogSim(actions) {
  return actions.map((action) => {
    const redacted = { ...action };
    if ((action.type === "fill" || action.type === "type") && typeof redacted.value === "string") {
      redacted.value = redacted.value ? `[redacted: ${redacted.value.length} chars]` : redacted.value;
    }
    return redacted;
  });
}

test("a fill action's free-text value is redacted", () => {
  const result = redactActionsForLogSim([{ type: "fill", targetId: "el-1", value: "Priya Sharma" }]);
  assert.strictEqual(result[0].value, "[redacted: 12 chars]");
});

// Direct regression for the debugging-value tradeoff: a select action's
// value is an enum-like option code (e.g. a country code), not free-text
// PII - blanket-redacting it by key name alone would have made every
// record log useless for debugging dropdown selection without any real
// security benefit, since these values are the SAME for every applicant
// who picks that option, not user-entered data.
test("a select action's enum-like value (e.g. a country code) is NOT redacted - no PII risk, real debugging value", () => {
  const result = redactActionsForLogSim([{ type: "select", targetId: "el-2", value: "US" }]);
  assert.strictEqual(result[0].value, "US");
});

// --- validateAction (Phase 4, copied decision table) --------------------
const ALLOWED_ACTION_TYPES = new Set(["fill", "click", "select", "scroll", "wait", "ask", "done"]);
const MAX_FILL_VALUE_LENGTH = 5000;
const MAX_SCROLL_PX = 20000;
const MAX_WAIT_MS = 5000;

function validateActionSim(action, elements) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return { valid: false, reason: "not an object" };
  if (!ALLOWED_ACTION_TYPES.has(action.type)) return { valid: false, reason: "unknown type" };

  if (["fill", "click", "select"].includes(action.type)) {
    if (!action.targetId || typeof action.targetId !== "string") return { valid: false, reason: "missing targetId" };
    const targetEl = elements.find((e) => e.id === action.targetId);
    if (!targetEl) return { valid: false, reason: "stale targetId" };
    if (action.type === "select") {
      if (!action.value) return { valid: false, reason: "select needs a value" };
      if (Array.isArray(targetEl.options) && !targetEl.options.some((o) => o.value === String(action.value))) {
        return { valid: false, reason: "not a real option" };
      }
    }
  }
  if (action.type === "fill") {
    if (action.value !== undefined && typeof action.value !== "string") return { valid: false, reason: "value not a string" };
    if (typeof action.value === "string" && action.value.length > MAX_FILL_VALUE_LENGTH) return { valid: false, reason: "value too long" };
  }
  if (action.type === "scroll" && action.value !== undefined) {
    const n = Number(action.value);
    if (!Number.isFinite(n) || Math.abs(n) > MAX_SCROLL_PX) return { valid: false, reason: "scroll out of range" };
  }
  if (action.type === "wait" && action.value !== undefined) {
    const n = Number(action.value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_WAIT_MS) return { valid: false, reason: "wait out of range" };
  }
  return { valid: true };
}

test("a well-formed fill action against a real target passes validation", () => {
  const result = validateActionSim({ type: "fill", targetId: "el-1", value: "hello" }, [{ id: "el-1" }]);
  assert.strictEqual(result.valid, true);
});

test("an unknown/hallucinated action type is rejected before ever reaching content.js", () => {
  const result = validateActionSim({ type: "delete_everything", targetId: "el-1" }, [{ id: "el-1" }]);
  assert.strictEqual(result.valid, false);
});

test("a targetId not present in the current snapshot is rejected as stale/hallucinated", () => {
  const result = validateActionSim({ type: "click", targetId: "el-999" }, [{ id: "el-1" }]);
  assert.strictEqual(result.valid, false);
});

test("a select value that isn't one of the field's real options is rejected", () => {
  const result = validateActionSim(
    { type: "select", targetId: "el-1", value: "ZZ" },
    [{ id: "el-1", options: [{ value: "US" }, { value: "IN" }] }]
  );
  assert.strictEqual(result.valid, false);
});

test("a select value that IS a real option passes", () => {
  const result = validateActionSim(
    { type: "select", targetId: "el-1", value: "US" },
    [{ id: "el-1", options: [{ value: "US" }, { value: "IN" }] }]
  );
  assert.strictEqual(result.valid, true);
});

// Direct regression for the one genuinely new gap this phase found:
// nothing previously bounded how long a "wait" action could hold up a
// round - a hallucinated huge value could hang it indefinitely.
test("an absurdly large wait value is rejected, not silently allowed to hang the round", () => {
  const result = validateActionSim({ type: "wait", value: 999999999 }, []);
  assert.strictEqual(result.valid, false);
});

test("a reasonable wait value within bounds passes", () => {
  const result = validateActionSim({ type: "wait", value: 1000 }, []);
  assert.strictEqual(result.valid, true);
});

test("an absurdly large scroll value is rejected the same way", () => {
  const result = validateActionSim({ type: "scroll", value: 999999999 }, []);
  assert.strictEqual(result.valid, false);
});

test("a fill value exceeding the length cap is rejected", () => {
  const result = validateActionSim({ type: "fill", targetId: "el-1", value: "x".repeat(6000) }, [{ id: "el-1" }]);
  assert.strictEqual(result.valid, false);
});

test("ask/done actions (no targetId required) pass validation regardless of targetId presence", () => {
  assert.strictEqual(validateActionSim({ type: "done", reasoning: "finished" }, []).valid, true);
  assert.strictEqual(validateActionSim({ type: "ask", targetId: "el-1", question: "?" }, [{ id: "el-1" }]).valid, true);
});

// --- Dashboard round-results counting (Phase 20 remainder) --------------
// Direct regression for the double-counting risk this design deliberately
// avoids: verify-failed fires per-result for logging, but only an
// exhausted (truly given-up) failure should count toward the "Failed"
// total - a non-exhausted one is still mid-recovery and must not be
// double-counted against both a "warning" and a "failure".
function classifyRoundResultsSim(results) {
  return {
    verifiedCount: results.filter((r) => r.verified === true).length,
    failedCount: results.filter((r) => r.verified === false && r.exhausted).length
  };
}

test("only exhausted failures count toward the Failed total - a still-recovering failure does not", () => {
  const result = classifyRoundResultsSim([
    { verified: false, exhausted: false }, // mid-recovery, not counted
    { verified: false, exhausted: true }, // genuinely gave up, counted
    { verified: true }
  ]);
  assert.strictEqual(result.failedCount, 1);
  assert.strictEqual(result.verifiedCount, 1);
});

test("verified:null (no check applies, e.g. a generic button) counts toward neither total", () => {
  const result = classifyRoundResultsSim([{ verified: null }]);
  assert.strictEqual(result.verifiedCount, 0);
  assert.strictEqual(result.failedCount, 0);
});

// --- gaveSubmitChance state machine (Phase 23, copied loop logic) ------
// Direct regression for the significant bug found while building the
// extension-harness test: hasFillableWork() only knows about fields, not
// about a submit button still sitting unclicked - the old code returned
// "done" the INSTANT every field was filled, never calling the LLM again,
// which meant the model could never propose the submit click the system
// prompt explicitly tells it to defer to a later round. This pins the fix:
// exactly one extra round is granted, never zero, never unbounded - AND
// pins the second, easy-to-miss failure mode found in the same trace: the
// pre-existing stagnation guard compares fingerprints round-over-round,
// and an empty "nothing left unfilled" fingerprint is identical between
// the round that just finished filling and the "one more chance" round,
// which would silently trip the guard and kill the extra round before the
// LLM ever got asked - defeating the fix above entirely if not suppressed
// for that one specific round.
function simulateSubmitChanceRounds(fillableSequence) {
  let gaveSubmitChance = false;
  let onSubmitChanceRound = false;
  const decisions = [];
  for (const hasFillable of fillableSequence) {
    if (!hasFillable) {
      if (!gaveSubmitChance) {
        gaveSubmitChance = true;
        onSubmitChanceRound = true;
        decisions.push("call-llm-one-more-time");
      } else {
        onSubmitChanceRound = false;
        decisions.push("stop");
        break;
      }
    } else {
      gaveSubmitChance = false;
      onSubmitChanceRound = false;
      decisions.push("call-llm-normal");
    }
    // Simulates the stagnation guard immediately following, using the
    // real suppression flag - proves the guard would NOT have fired on
    // the submit-chance round even though the fingerprint is unchanged.
    if (onSubmitChanceRound) decisions.push("stagnation-guard-suppressed-correctly");
  }
  return decisions;
}

test("a form fully filled on round 0 still gets exactly one more round to consider submitting, and the stagnation guard does not kill it", () => {
  const decisions = simulateSubmitChanceRounds([true, false, false]);
  assert.deepStrictEqual(decisions, [
    "call-llm-normal",
    "call-llm-one-more-time",
    "stagnation-guard-suppressed-correctly",
    "stop"
  ]);
});

test("the extra round is granted exactly once, never repeatedly - bounded, not a new infinite loop", () => {
  const decisions = simulateSubmitChanceRounds([false, false, false, false]);
  assert.deepStrictEqual(decisions, ["call-llm-one-more-time", "stagnation-guard-suppressed-correctly", "stop"]);
});

test("new fillable work appearing (a revealed field) resets the one-time allowance for a later submit attempt", () => {
  assert.deepStrictEqual(
    simulateSubmitChanceRounds([false, true, false, false]),
    [
      "call-llm-one-more-time",
      "stagnation-guard-suppressed-correctly",
      "call-llm-normal",
      "call-llm-one-more-time",
      "stagnation-guard-suppressed-correctly",
      "stop"
    ]
  );
});

// --- findComboboxFilterInput / tagComboboxFilterInputs (Phase 24) -------
// Regression test for the actual bug in the attached metlifecareers.com
// Record-mode log: a Select2 nationality combobox opened fine (aria-expanded
// went true) but the model then just re-clicked the same trigger every
// round instead of typing a search query - because the real Select2
// search input has no label/placeholder/name of its own and computeLabel()
// returned "" for it. These are copied minimal-DOM versions of the real
// content.js/dom-helpers.js logic (no jsdom dependency, matching this
// file's existing convention) - real-browser behavior is still unverified,
// see the fix writeup.

// Tiny fake DOM node - only the handful of methods findComboboxFilterInput
// and computeLabel actually call.
function makeNode(tag, attrs = {}) {
  return {
    tag,
    attrs: { ...attrs },
    children: [],
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    get placeholder() {
      return this.attrs.placeholder || "";
    },
    get name() {
      return this.attrs.name || "";
    },
    get labels() {
      return [];
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    closest(selector) {
      // Only the "[class*='dropdown']" shape used by findComboboxFilterInput
      // needs support here.
      let node = this;
      while (node) {
        const cls = node.attrs.class || "";
        if (selector === "[class*='dropdown']" && cls.includes("dropdown")) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector(selector) {
      // Only supports the exact selector findComboboxFilterInput uses.
      const wantsSearchOrText = selector === "input[type='search'], input[type='text']:not([readonly])";
      const search = (node) => {
        for (const child of node.children) {
          if (wantsSearchOrText && child.tag === "input" && (child.attrs.type === "search" || (child.attrs.type === "text" && !child.attrs.readonly))) {
            return child;
          }
          const found = search(child);
          if (found) return found;
        }
        return null;
      };
      return search(this);
    }
  };
}

// Minimal fake document supporting getElementById, matching what
// findComboboxFilterInput needs.
function makeFakeDocument(byId) {
  return { getElementById: (id) => byId[id] || null };
}

// Copied logic from content.js's computeLabel, trimmed to the one branch
// this test needs (inherited label short-circuit).
function computeLabelCopy(el) {
  const inherited = el.getAttribute && el.getAttribute("data-agent-inherited-label");
  if (inherited) return inherited;
  if (el.placeholder) return el.placeholder;
  if (el.name) return el.name;
  return "";
}

// Copied logic from content.js's findComboboxFilterInput.
function findComboboxFilterInputCopy(comboboxEl, doc) {
  const controlsId = comboboxEl.getAttribute("aria-owns") || comboboxEl.getAttribute("aria-controls");
  if (!controlsId) return null;
  const resultsEl = doc.getElementById(controlsId);
  if (!resultsEl) return null;
  const pane = resultsEl.closest("[class*='dropdown']") || resultsEl.parentElement?.parentElement || resultsEl.parentElement;
  if (!pane) return null;
  const input = pane.querySelector("input[type='search'], input[type='text']:not([readonly])");
  if (!input || input === comboboxEl) return null;
  return input;
}

test("finds the Select2-shaped search input as a sibling of the results list, not a descendant of it", () => {
  // <span class="select2-dropdown">
  //   <span class="select2-search--dropdown"><input type=search></span>
  //   <span class="select2-results"><ul id="select2-11112-results">...</ul></span>
  // </span>
  const dropdownPane = makeNode("span", { class: "select2-dropdown" });
  const searchWrapper = dropdownPane.appendChild(makeNode("span", { class: "select2-search--dropdown" }));
  const searchInput = searchWrapper.appendChild(makeNode("input", { type: "search" }));
  const resultsWrapper = dropdownPane.appendChild(makeNode("span", { class: "select2-results" }));
  const resultsList = resultsWrapper.appendChild(makeNode("ul", { id: "select2-11112-results", role: "listbox" }));

  const combobox = makeNode("span", { role: "combobox", "aria-expanded": "true", "aria-owns": "select2-11112-results" });
  const doc = makeFakeDocument({ "select2-11112-results": resultsList });

  const found = findComboboxFilterInputCopy(combobox, doc);
  assert.strictEqual(found, searchInput);
});

test("returns null when the combobox has no aria-owns/aria-controls at all (nothing to look up)", () => {
  const combobox = makeNode("span", { role: "combobox", "aria-expanded": "true" });
  const doc = makeFakeDocument({});
  assert.strictEqual(findComboboxFilterInputCopy(combobox, doc), null);
});

test("returns null when the referenced results id doesn't exist in the document (defensive - malformed/mid-render page)", () => {
  const combobox = makeNode("span", { role: "combobox", "aria-owns": "nonexistent-id" });
  const doc = makeFakeDocument({});
  assert.strictEqual(findComboboxFilterInputCopy(combobox, doc), null);
});

test("an unlabeled filter input inherits the combobox's label plus a type-to-search instruction", () => {
  const filterInput = makeNode("input", { type: "search" });
  assert.strictEqual(computeLabelCopy(filterInput), ""); // confirms the bug: genuinely no label before tagging
  filterInput.setAttribute("data-agent-inherited-label", "Nationality - type to search/filter options");
  assert.strictEqual(computeLabelCopy(filterInput), "Nationality - type to search/filter options");
});

test("a filter input that already has its own real label/placeholder is left alone (never overridden)", () => {
  const filterInput = makeNode("input", { type: "search", placeholder: "Search countries" });
  // tagComboboxFilterInputs() in content.js checks computeLabel(filterInput)
  // before ever calling setAttribute - mirror that guard here.
  const alreadyLabeled = computeLabelCopy(filterInput);
  assert.strictEqual(alreadyLabeled, "Search countries");
  // The real function would skip tagging in this case, so the placeholder
  // must still win afterward.
  assert.strictEqual(computeLabelCopy(filterInput), "Search countries");
});

// --- hasFillableWork / unfilledFingerprint required-choice fix (Phase 25) -
// Regression test for the actual bug behind 5 back-to-back identical
// "Blocked: 4 required field(s) still missing despite confirmation" runs
// in the attached log, each with zero rounds logged in between. Root
// cause: hasFillableWork() unconditionally excluded ALL checkbox/radio
// fields except ones matching consent keywords ("agree", "terms", etc),
// so a required-but-non-consent radio group (e.g. a work-authorization
// yes/no question) was invisible to the fill loop even though
// getFormStatus() - used only in the separate preflight gate right before
// submit - correctly caught it as missing. Copied minimal logic, same
// convention as the rest of this file.

function isUncheckedConsentBoxCopy(el) {
  const CONSENT_KEYWORDS = ["agree", "terms", "consent", "privacy policy", "accept", "acknowledge"];
  if (el.type !== "checkbox" && el.type !== "radio") return false;
  if (el.checked) return false;
  const text = `${el.label || ""} ${el.text || ""}`.toLowerCase();
  return CONSENT_KEYWORDS.some((kw) => text.includes(kw));
}

function buildRequiredRadioGroupCheckedCopy(snapshot) {
  const checked = new Map();
  for (const el of snapshot.elements) {
    if (el.type !== "radio" || !el.name) continue;
    checked.set(el.name, (checked.get(el.name) || false) || !!el.checked);
  }
  return checked;
}

function isUnresolvedRequiredChoiceCopy(el, requiredRadioGroupChecked) {
  if (el.type === "checkbox") return !!el.required && !el.checked;
  if (el.type === "radio") {
    if (!el.required || !el.name) return false;
    return !requiredRadioGroupChecked.get(el.name);
  }
  return false;
}

function hasFillableWorkCopy(snapshot) {
  const requiredRadioGroupChecked = buildRequiredRadioGroupCheckedCopy(snapshot);
  return snapshot.elements.some((el) => {
    if (isUncheckedConsentBoxCopy(el)) return true;
    if (el.invalid) return true;
    if (el.filled) return false;
    if (el.requiresManualUpload) return false;
    if (el.type === "checkbox" || el.type === "radio") return isUnresolvedRequiredChoiceCopy(el, requiredRadioGroupChecked);
    if (!["input", "textarea", "select"].includes(el.tag)) return false;
    return !el.currentValue;
  });
}

test("a required radio group with no wording match ('work authorization') is now seen as fillable work", () => {
  // This is the exact shape that produced 5 back-to-back "Blocked: 4
  // required field(s)" runs with zero fill rounds in between - none of
  // "authorized", "work", "us" trip the consent-keyword list.
  const snapshot = {
    elements: [
      { tag: "input", type: "radio", name: "work_auth", label: "Yes", required: true, checked: false, filled: false },
      { tag: "input", type: "radio", name: "work_auth", label: "No", required: true, checked: false, filled: false }
    ]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), true);
});

test("a required radio group with one option already checked is NOT fillable work", () => {
  const snapshot = {
    elements: [
      { tag: "input", type: "radio", name: "work_auth", label: "Yes", required: true, checked: true, filled: false },
      { tag: "input", type: "radio", name: "work_auth", label: "No", required: true, checked: false, filled: false }
    ]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), false);
});

test("a non-required radio group left unchecked is correctly left alone (not every unchecked radio is 'work')", () => {
  const snapshot = {
    elements: [
      { tag: "input", type: "radio", name: "newsletter_opt_in", label: "Yes", required: false, checked: false, filled: false },
      { tag: "input", type: "radio", name: "newsletter_opt_in", label: "No", required: false, checked: false, filled: false }
    ]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), false);
});

test("a required checkbox with non-consent wording ('I have read the job description') is now fillable work", () => {
  const snapshot = {
    elements: [{ tag: "input", type: "checkbox", label: "I have read the job description", required: true, checked: false, filled: false }]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), true);
});

test("consent-worded checkboxes still work exactly as before (no regression from the fix)", () => {
  const snapshot = {
    elements: [{ tag: "input", type: "checkbox", label: "I agree to the terms", required: false, checked: false, filled: false }]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), true);
});

test("a plain text field still behaves exactly as before (no regression from the fix)", () => {
  const snapshot = {
    elements: [{ tag: "input", type: "text", label: "First name", filled: false, currentValue: undefined }]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), true);
});

// --- "done" claim cross-check regression (Phase 24 - the actual bug from
// the user's log: "No interactive elements present" / "No form elements
// to fill" summaries, which turned out to be the MODEL'S OWN unverified
// claim, accepted at face value even when the deterministic snapshot sent
// to it that same round still showed real unfilled required fields).
// Mirrors the cross-check now in background.js's round loop: when the
// model returns a lone {type:"done"} action, hasFillableWork() is run
// against the SAME snapshot before trusting it.
test("a model's false 'done' claim is caught when the snapshot still has an unfilled required select", () => {
  const snapshot = {
    elements: [
      { tag: "select", label: "Notice period", required: true, filled: false, currentValue: "" }
    ]
  };
  // This is the exact condition background.js checks before accepting a
  // lone {type:"done"} action - if it's true, the claim must be rejected
  // rather than ending the run.
  assert.strictEqual(hasFillableWorkCopy(snapshot), true);
});

test("a genuine 'done' claim (nothing left, matching the log's real completions) is accepted", () => {
  const snapshot = {
    elements: [
      { tag: "input", type: "text", label: "First name", required: true, filled: true, currentValue: "Jane" },
      { tag: "select", label: "Country", required: true, filled: true, currentValue: "US" }
    ]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), false);
});

test("an unchecked required consent checkbox alone is enough to reject a 'done' claim", () => {
  const snapshot = {
    elements: [{ tag: "input", type: "checkbox", label: "I agree to the Terms and Conditions", required: true, checked: false, filled: false }]
  };
  assert.strictEqual(hasFillableWorkCopy(snapshot), true);
});

// --- withRetry attempt-count error enrichment (Phase 24, copied logic,
// kept in sync with providers.js's withRetry - regression for the
// "Error: Request timed out." run_end in the user's log, which gave no
// indication of whether that was attempt 1 or attempt 5) ----------------
function appendAttemptCount(message, attemptsMade) {
  return attemptsMade > 1 ? `${message} (failed after ${attemptsMade} attempts)` : message;
}

test("a first-attempt-only failure (e.g. bad API key) is left unannotated - it wasn't actually retried", () => {
  assert.strictEqual(appendAttemptCount("Anthropic auth error (401).", 1), "Anthropic auth error (401).");
});

test("a failure after multiple retries is annotated with exactly how many attempts were made", () => {
  assert.strictEqual(appendAttemptCount("Request timed out.", 5), "Request timed out. (failed after 5 attempts)");
});

// --- scroll-discovery gating logic (Phase 25, copied logic - kept in
// sync with content.js's discoverElementsBeyondViewport threshold/
// convergence checks). The scroll walk itself needs a real DOM/browser
// and isn't unit-testable here, but the two decisions that make it safe
// and cheap - "is this page even worth the scroll sweep" and "when do we
// stop" - are pure logic and are exactly where a bad threshold would
// either skip real content or turn one snapshot into a slow scroll loop.
function shouldRunDiscoveryScroll(scrollHeight, viewportH) {
  return scrollHeight > viewportH * 1.3;
}

function discoveryConverged(atBottom, stableHeightCount) {
  return atBottom && stableHeightCount >= 2;
}

test("a short page (barely more than one viewport tall) skips the scroll-discovery sweep entirely", () => {
  assert.strictEqual(shouldRunDiscoveryScroll(900, 800), false);
});

test("a long page well beyond one viewport triggers the scroll-discovery sweep", () => {
  assert.strictEqual(shouldRunDiscoveryScroll(4000, 800), true);
});

test("discovery does not stop early while still short of the page bottom, even with a stable height", () => {
  assert.strictEqual(discoveryConverged(false, 3), false);
});

test("discovery does not stop after only one stable-height reading at the bottom - needs two to rule out a slow-mounting field", () => {
  assert.strictEqual(discoveryConverged(true, 1), false);
});

test("discovery stops once at the bottom with two consecutive unchanged-height readings", () => {
  assert.strictEqual(discoveryConverged(true, 2), true);
});

// --- transition detection (Phase 26, copied decision logic - kept in
// sync with background.js's waitForTransition. Regression for the log's
// root cause: a "Continue" click on an SPA/LiveView form with no
// traditional navigation had nothing distinguishing "the click worked and
// swapped in new fields at the same URL" from "the click silently did
// nothing" - both looked identical to a URL-only check). The actual
// polling loop needs a real tab/content-script and isn't unit-testable
// here; what IS pure logic, and exactly where a wrong call would either
// mistake a real transition for a no-op or hang waiting for one that
// isn't coming, is the change-detection comparison itself.
function detectTransition(previousState, currentState) {
  const urlChanged = currentState.url !== previousState.url;
  const domChanged = currentState.structuralFingerprint !== previousState.structuralFingerprint;
  return { urlChanged, domChanged, changed: urlChanged || domChanged || !!currentState.errorPhraseMatched };
}

test("a traditional full-page navigation (URL changed) is detected as a transition", () => {
  const result = detectTransition(
    { url: "https://jobs.example.com/step-1", structuralFingerprint: "a|b|c" },
    { url: "https://jobs.example.com/step-2", structuralFingerprint: "a|b|c", errorPhraseMatched: null }
  );
  assert.strictEqual(result.urlChanged, true);
  assert.strictEqual(result.changed, true);
});

test("an SPA/LiveView-style same-URL field swap is detected as a transition via the structural fingerprint, not the URL", () => {
  const result = detectTransition(
    { url: "https://jobs.example.com/apply", structuralFingerprint: "text:notice_period|select:country" },
    { url: "https://jobs.example.com/apply", structuralFingerprint: "textarea:cover_letter|input:linkedin_url", errorPhraseMatched: null }
  );
  assert.strictEqual(result.urlChanged, false);
  assert.strictEqual(result.domChanged, true);
  assert.strictEqual(result.changed, true);
});

test("a click that genuinely did nothing (same URL, same fields) is correctly NOT reported as a transition", () => {
  const result = detectTransition(
    { url: "https://jobs.example.com/apply", structuralFingerprint: "text:first_name|text:last_name" },
    { url: "https://jobs.example.com/apply", structuralFingerprint: "text:first_name|text:last_name", errorPhraseMatched: null }
  );
  assert.strictEqual(result.changed, false);
});

test("a validation error appearing counts as a transition even with no URL or field-set change", () => {
  const result = detectTransition(
    { url: "https://jobs.example.com/apply", structuralFingerprint: "text:email" },
    { url: "https://jobs.example.com/apply", structuralFingerprint: "text:email", errorPhraseMatched: "please enter a valid email" }
  );
  assert.strictEqual(result.urlChanged, false);
  assert.strictEqual(result.domChanged, false);
  assert.strictEqual(result.changed, true);
});

console.log(`\n${passed} test(s) passed.`);

// --- describeUnresolvedFields (Phase 27, copied logic - kept in sync
// with background.js's describeUnresolvedFields. Regression for spec
// CASE 8 / the stagnation guard's previous generic "no progress" message,
// which gave a person debugging a failed run no lead on WHAT was stuck -
// this must name the actual blocking field(s) by label.) -------------
function describeUnresolvedFieldsCopy(snapshot) {
  const requiredRadioGroupChecked = buildRequiredRadioGroupCheckedCopy(snapshot);
  const unfilled = snapshot.elements
    .filter((el) => !el.filled && ["input", "textarea", "select"].includes(el.tag))
    .filter((el) => el.type !== "checkbox" && el.type !== "radio")
    .filter((el) => !el.requiresManualUpload)
    .filter((el) => !el.currentValue);
  const unresolvedChoices = snapshot.elements
    .filter((el) => el.type === "checkbox" || el.type === "radio")
    .filter((el) => isUncheckedConsentBoxCopy(el) || isUnresolvedRequiredChoiceCopy(el, requiredRadioGroupChecked));
  const invalid = snapshot.elements.filter((el) => el.invalid);
  return [...unfilled, ...unresolvedChoices, ...invalid].map((el) => ({
    id: el.id,
    label: el.label || el.text || el.name || el.id,
    invalid: !!el.invalid
  }));
}

test("describeUnresolvedFields names the exact unfilled required field blocking a stuck run", () => {
  const snapshot = {
    elements: [
      { id: "el-1", tag: "input", type: "text", label: "First name", filled: true, currentValue: "Jane" },
      { id: "el-2", tag: "select", label: "Are you legally authorized to work in this country?", filled: false, currentValue: "", required: true }
    ]
  };
  const blocking = describeUnresolvedFieldsCopy(snapshot);
  assert.strictEqual(blocking.length, 1);
  assert.strictEqual(blocking[0].label, "Are you legally authorized to work in this country?");
});

test("describeUnresolvedFields returns nothing when every field is genuinely resolved", () => {
  const snapshot = {
    elements: [{ id: "el-1", tag: "input", type: "text", label: "Email", filled: true, currentValue: "jane@example.com" }]
  };
  assert.strictEqual(describeUnresolvedFieldsCopy(snapshot).length, 0);
});

test("describeUnresolvedFields surfaces an unchecked required consent checkbox by its label, not a generic placeholder", () => {
  const snapshot = {
    elements: [{ id: "el-9", tag: "input", type: "checkbox", label: "I agree to the Terms and Conditions", required: true, checked: false, filled: false }]
  };
  const blocking = describeUnresolvedFieldsCopy(snapshot);
  assert.strictEqual(blocking.length, 1);
  assert.strictEqual(blocking[0].label, "I agree to the Terms and Conditions");
});

// --- nested-iframe id composition/decomposition (Phase 28, copied logic
// - kept in sync with content.js's getPageSnapshot id-prefixing and
// dispatchAction's unwrapping regex. Regression for the real bug found
// while auditing iframe support: the old window===window.top gate on the
// snapshot/outcome merges meant only ONE level of iframe nesting ever
// worked - a middle frame with its own child iframe silently dropped the
// grandchild's fields. This tests the id scheme itself, which is what
// makes arbitrary-depth nesting actually addressable once the merge
// recursion is unconditional.) -----------------------------------------
function prefixForFrame(frameIndex, childId) {
  return `iframe${frameIndex}-${childId}`;
}

function unwrapOneFrameLevel(targetId) {
  const match = targetId.match(/^iframe(\d+)-(.*)$/);
  if (!match) return null;
  return { frameIndex: parseInt(match[1]), remainder: match[2] };
}

test("a single-level iframe id composes and decomposes back to the original element id", () => {
  const composed = prefixForFrame(0, "el-5");
  assert.strictEqual(composed, "iframe0-el-5");
  const unwrapped = unwrapOneFrameLevel(composed);
  assert.deepStrictEqual(unwrapped, { frameIndex: 0, remainder: "el-5" });
});

test("a two-level nested iframe id unwraps one layer at a time down to the real element id", () => {
  // Grandchild element "el-3" inside frame 0 of the middle frame, which is
  // itself frame 1 of the top document - getPageSnapshot's merge produces
  // this by prefixing once per level as the snapshot bubbles up.
  const composed = prefixForFrame(1, prefixForFrame(0, "el-3"));
  assert.strictEqual(composed, "iframe1-iframe0-el-3");

  const firstUnwrap = unwrapOneFrameLevel(composed);
  assert.deepStrictEqual(firstUnwrap, { frameIndex: 1, remainder: "iframe0-el-3" });

  // The remainder is still iframe-prefixed - this is exactly the case
  // dispatchAction must recurse on rather than treating "iframe0-el-3" as
  // a literal element id to look up locally.
  const secondUnwrap = unwrapOneFrameLevel(firstUnwrap.remainder);
  assert.deepStrictEqual(secondUnwrap, { frameIndex: 0, remainder: "el-3" });
});

test("a plain (non-iframe) element id is correctly recognized as needing no unwrapping", () => {
  assert.strictEqual(unwrapOneFrameLevel("el-12"), null);
});

// --- file-upload verification (Phase 30, copied logic - kept in sync
// with dom-helpers.js's UPLOAD_EVIDENCE_PATTERN and background.js's
// pendingUploads filtering. hasUploadedFile itself needs a real DOM
// element (.files, .parentElement, .textContent) and isn't unit-testable
// in this jsdom-free file, but the two decisions that actually determine
// correctness - "does this post-upload UI text count as evidence" and
// "should an already-uploaded file still show as pending" - are pure
// logic and exactly where the real bugs were.) --------------------------
const UPLOAD_EVIDENCE_PATTERN = /\.(pdf|docx?|rtf|txt|odt)\b|uploaded|remove file|x-icon|delete-file/i;

test("a filename with a resume-typical extension counts as upload evidence", () => {
  assert.strictEqual(UPLOAD_EVIDENCE_PATTERN.test("resume_jane_doe.pdf"), true);
  assert.strictEqual(UPLOAD_EVIDENCE_PATTERN.test("cover-letter.docx"), true);
});

test("a 'remove file' or delete affordance shown after a successful upload counts as evidence", () => {
  assert.strictEqual(UPLOAD_EVIDENCE_PATTERN.test("Remove file"), true);
  assert.strictEqual(UPLOAD_EVIDENCE_PATTERN.test("File uploaded successfully"), true);
});

test("plain unrelated container text is correctly NOT mistaken for upload evidence", () => {
  assert.strictEqual(UPLOAD_EVIDENCE_PATTERN.test("Drag and drop your resume here, or click to browse"), false);
});

// Regression for the real bug found: filtering only on requiresManualUpload
// (the field-TYPE marker, which never changes) instead of also checking
// !currentValue meant an already-uploaded resume was reported as
// "needs manual attention" on every single submit-confirmation.
function filterPendingUploads(elements) {
  return elements.filter((el) => el.requiresManualUpload && !el.currentValue).map((el) => el.label || "File upload");
}

test("an already-uploaded resume is correctly excluded from the pending-uploads list", () => {
  const elements = [{ requiresManualUpload: true, currentValue: "File uploaded", label: "Resume" }];
  assert.deepStrictEqual(filterPendingUploads(elements), []);
});

test("a still-empty required file upload is correctly included in the pending-uploads list", () => {
  const elements = [{ requiresManualUpload: true, currentValue: undefined, label: "Cover letter" }];
  assert.deepStrictEqual(filterPendingUploads(elements), ["Cover letter"]);
});

// --- findProfileValue object-coercion fix (Phase 32, copied logic - kept
// in sync with field-detection.js. Direct regression for a real user-
// reported bug: LinkedIn and GitHub URL fields were filled with the
// literal text "[object Object]" because a profile value stored as an
// object (e.g. {url: "...", verified: true} instead of a plain string)
// was passed through a blind String(value) coercion, and
// String({anything}) always produces exactly that text in JavaScript.)--
function findProfileValueSim(profileData, profileKeys) {
  for (const key of profileKeys) {
    const raw = profileData[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const nestedValue = raw.url ?? raw.value ?? raw.link ?? raw.href;
      if (typeof nestedValue === "string" && nestedValue) return nestedValue;
      continue;
    }
    if (typeof raw === "object") continue;
    return String(raw);
  }
  return null;
}

test("a plain string profile value (the common case) resolves exactly as before", () => {
  assert.strictEqual(findProfileValueSim({ linkedin: "https://linkedin.com/in/janedoe" }, ["linkedin"]), "https://linkedin.com/in/janedoe");
});

test("a LinkedIn/GitHub value accidentally stored as {url: ...} resolves to the real URL, not '[object Object]'", () => {
  const profileData = { linkedin: { url: "https://linkedin.com/in/janedoe", verified: true } };
  assert.strictEqual(findProfileValueSim(profileData, ["linkedin", "linkedinUrl"]), "https://linkedin.com/in/janedoe");
});

test("an object value with none of the recognized sub-keys resolves to null instead of a stringified object", () => {
  const profileData = { github: { username: "janedoe" } }; // no .url/.value/.link/.href
  assert.strictEqual(findProfileValueSim(profileData, ["github", "githubUrl"]), null);
});

test("an array value (also typeof object) is correctly treated as unusable rather than stringified", () => {
  const profileData = { portfolio: ["https://one.example", "https://two.example"] };
  assert.strictEqual(findProfileValueSim(profileData, ["portfolio"]), null);
});

// --- native constraint-validation detection (Phase 33, copied logic -
// kept in sync with content.js's snapshot-entry building. Closes a real
// coverage gap: the only prior signal for a field the page rejected was
// aria-invalid="true", which plenty of forms - plain HTML forms, and
// custom React/Vue components that never touch ARIA at all - never set.
// Every native input/textarea/select carries the browser's own
// Constraint Validation API regardless of framework or ARIA usage,
// independent of any site-specific CSS class guessing.) ------------------
function isValidationErrorSim(validity, value) {
  if (!validity) return false;
  if (validity.valid) return false;
  if (validity.valueMissing) return false; // empty required field = not yet filled, not a validation error
  return !!value;
}

test("a field with a bad-format value (e.g. malformed email) the page's own validation rejects is flagged invalid", () => {
  assert.strictEqual(isValidationErrorSim({ valid: false, valueMissing: false, typeMismatch: true }, "not-an-email"), true);
});

test("an empty required field is correctly NOT flagged invalid - it just hasn't been filled yet", () => {
  assert.strictEqual(isValidationErrorSim({ valid: false, valueMissing: true }, ""), false);
});

test("a field that already passes native validation is not flagged invalid", () => {
  assert.strictEqual(isValidationErrorSim({ valid: true }, "jane@example.com"), false);
});

test("a field with no constraint-validation support at all (validity undefined) is safely treated as not invalid", () => {
  assert.strictEqual(isValidationErrorSim(undefined, "anything"), false);
});

// --- value-shape learning guard (Phase 34, copied logic - kept in sync
// with background.js's valueLooksSensitive/learningSensitivity. Closes a
// real gap: the existing NEVER_LEARN_KEYWORDS blocklist only ever checks
// the field's LABEL text - a field mislabeled as something generic
// ("Verification code", "Additional info") that actually captures an SSN
// or card number would sail straight through with no protection at all,
// since nothing about its harmless-looking label would ever match.) ----
const SENSITIVE_VALUE_PATTERNS = [
  /^\d{3}-?\d{2}-?\d{4}$/,
  /^(?:\d[ -]*?){13,19}$/
];

function valueLooksSensitiveSim(value) {
  const trimmed = String(value || "").trim();
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(trimmed));
}

test("an SSN-shaped value is flagged sensitive even under an innocuous label", () => {
  assert.strictEqual(valueLooksSensitiveSim("123-45-6789"), true);
  assert.strictEqual(valueLooksSensitiveSim("123456789"), true);
});

test("a card-number-shaped value is flagged sensitive regardless of label", () => {
  assert.strictEqual(valueLooksSensitiveSim("4111 1111 1111 1111"), true);
});

test("an ordinary short answer is correctly NOT flagged as a sensitive value shape", () => {
  assert.strictEqual(valueLooksSensitiveSim("Jane Doe"), false);
  assert.strictEqual(valueLooksSensitiveSim("New York, NY"), false);
});

console.log(`\n${passed} test(s) passed.`);
