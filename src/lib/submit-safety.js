// --- Submit detection, Phase 7 Layer 2, extracted from background.js
// (Phase 21) -------------------------------------------------------
// Loaded via importScripts() into background.js's global scope. Kept
// deliberately separate from lib/providers.js and
// lib/profile-intelligence.js despite all three being importScripts'd
// together - this file is Layer 2 of a multi-layer safety system
// (see content.js's independent Layer 3 duplicate), and keeping it in
// its own file makes that boundary visible in the project structure,
// not just in a comment.

// --- Submit detection (Phase 7) ----------------------------------------
// The old version was a single flat keyword list matched against any
// clickable text - functional, but exactly the kind of "single substring
// check" the doc calls out as insufficient: "apply" alone would fire on
// "Apply filters", "confirm" on "Confirm email format", "send" on "Send
// verification code". Split into two tiers instead: phrases that are
// unambiguous in this domain regardless of what they're attached to, and
// weaker single-word signals that only count on a real actionable control
// with a short, button-shaped label and no disambiguating qualifier.
const STRONG_FINAL_PHRASES = [
  "submit application",
  "submit my application",
  "submit your application",
  "apply now",
  "apply for this job",
  "apply for this role",
  "send application",
  "finish application",
  "complete application",
  "complete my application",
  "confirm and submit",
  "confirm application",
  "review and submit",
  "place order",
  "pay now",
  "confirm and pay",
  "delete account",
  "delete my account"
];

// Weak signals only count when the element itself is a real actionable
// control (not a paragraph, not an option in an unrelated dropdown) with a
// short, button-shaped label - a long sentence merely containing one of
// these words is never a match regardless of element type.
const WEAK_SUBMIT_KEYWORDS = [
  "submit", "apply", "confirm", "finalize", "finish", "checkout",
  "purchase", "deactivate", "unsubscribe", "send message", "post job", "publish"
];

// Qualifiers that indicate the weak keyword is attached to something other
// than the final form-submission action, even though the bare word
// matched - "Confirm email format", "Send verification code", "Publish
// draft" are all real, harmless buttons that would otherwise false-positive
// on "confirm"/"send"/"publish" alone.
const NON_FINAL_QUALIFIERS = [
  "filter", "code", "otp", "verification", "comment", "draft", "password",
  "section", "step", "search", "email format", "preview", "sort", "column"
];

const CLICKABLE_CONTROL_TAGS = new Set(["button", "a"]);

function isLikelySubmitAction(action, snapshot) {
  if (action.type !== "click") return false;
  const target = snapshot?.elements?.find(e => e.id === action.targetId);
  if (!target) return false;

  const text = (target.text || target.label || target.name || target.placeholder || "").toLowerCase().trim();
  
  if (STRONG_FINAL_PHRASES.some(p => text.includes(p))) return true;

  const tag = (target.tag || "").toLowerCase();
  if (CLICKABLE_CONTROL_TAGS.has(tag)) {
    const wordCount = text.split(/\s+/).length;
    if (wordCount <= 4) {
      const hasWeak = WEAK_SUBMIT_KEYWORDS.some(k => text.includes(k));
      const hasQual = NON_FINAL_QUALIFIERS.some(q => text.includes(q));
      if (hasWeak && !hasQual) return true;
    }
  }

  return false;
}
