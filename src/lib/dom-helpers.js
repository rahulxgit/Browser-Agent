// --- DOM label/visibility helpers, extracted from content.js (Phase 21) --
// Injected alongside content.js via the same files-array mechanism as the
// adapters and lib/field-detection.js. Pure, generic DOM utilities with
// zero combobox-specific coupling - labelFor/computeLabel in particular
// are called from nearly everywhere else in content.js and its sibling
// lib files, so this loads first among the non-adapter files.

function isVisible(el) {
  if (supportsNativeVisibilityCheck) {
    return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

// Labels are the most expensive part of a snapshot (label.innerText forces
// a layout read, and closest()/previousElementSibling walk the tree) and
// almost never change for a given element within a single run - re-deriving
// them every round for every element on a 50-field form adds up fast across
// up to MAX_ROUNDS calls. Cached per-element; invalidated only if the
// element's own label-relevant attributes change, so a genuinely dynamic
// label (rare, but some SPA forms relabel a field after a selection) still
// gets picked up rather than sticking to a stale value forever.
const labelCache = new WeakMap();

function labelSignature(el) {
  // aria-labelledby wasn't in the cache key even after computeLabel started
  // resolving it - harmless for a static page, but on an SPA that
  // relabels a field after some other action, the cache would keep
  // serving the pre-relabel text forever since nothing here ever changed.
  return `${el.getAttribute("aria-label") || ""}|${el.getAttribute("aria-labelledby") || ""}|${el.placeholder || ""}|${el.name || ""}|${el.getAttribute("data-agent-inherited-label") || ""}`;
}

// Spec requirement: "Verify the uploaded file actually appears in the
// application's UI/state. Do not just [set the file] and assume
// success." This agent never programmatically sets file inputs at all
// (browsers block that outright for security - uploads are always done
// by the human), so the equivalent verification job here is the reverse:
// correctly recognizing that a human's upload DID succeed, even on the
// subset of upload widgets that clear input.files once their own async
// upload/processing finishes and switch to showing a filename chip,
// checkmark, or "remove" button instead. Checking files.length alone
// would wrongly flag those as still-empty forever, right after the
// person just uploaded their resume.
const UPLOAD_EVIDENCE_PATTERN = /\.(pdf|docx?|rtf|txt|odt)\b|uploaded|remove file|x-icon|delete-file/i;

function hasUploadedFile(el) {
  if (el.files && el.files.length > 0) return true;
  // Walk a few container levels up looking for post-upload UI text/markup
  // most drag-and-drop widgets render once their JS-driven upload
  // finishes. Bounded to 4 levels so this can't accidentally match
  // unrelated page content far outside the actual widget.
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const text = (node.getAttribute("aria-label") || "") + " " + (node.textContent || "");
    if (UPLOAD_EVIDENCE_PATTERN.test(text.slice(0, 300))) return true;
  }
  return false;
}

function labelFor(el) {
  const cached = labelCache.get(el);
  const signature = labelSignature(el);
  if (cached && cached.signature === signature) return cached.value;

  const value = computeLabel(el);
  labelCache.set(el, { signature, value });
  return value;
}

function computeLabel(el) {
  // Set by tagComboboxFilterInputs() in content.js (Phase 24) for Select2-
  // style "type to search" inputs that Select2 injects with no label,
  // placeholder, or name of their own - checked first since a real label
  // never gets attached this way (see the guard in tagComboboxFilterInputs)
  // and this is strictly filling a gap, not overriding a genuine one.
  const inherited = el.getAttribute && el.getAttribute("data-agent-inherited-label");
  if (inherited) return inherited;
  if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
  // aria-labelledby MUST take precedence over aria-label per ARIA spec.
  // MS Forms uses both (aria-label="Multi Line Text" and aria-labelledby="QuestionId... QuestionInfo..."),
  // so checking aria-label first resulted in 16 identical "Multi Line Text" labels.
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => {
        const textContent = document.getElementById(id)?.innerText?.trim();
        return textContent ? textContent.replace(/\s+/g, " ") : "";
      })
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
  if (el.placeholder) return el.placeholder;
  if (el.name) return el.name;
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) return wrappingLabel.innerText.trim();
  // fieldset/legend fallback - previously only used for radio/select
  // groups via groupContextText(), but a plain text input inside a
  // <fieldset> with no label of its own (some multi-part fields - phone
  // country code + number, structured address - do this) got nothing
  // useful out of computeLabel at all before this.
  const fieldset = el.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend && legend.innerText && legend.innerText.trim().length < 100) return legend.innerText.trim();
  }
  // Some ATS forms put the label as a preceding sibling <div>/<span>
  // rather than a real <label> - check the immediately preceding element.
  const prev = el.previousElementSibling;
  if (prev && prev.innerText && prev.innerText.trim().length < 60) {
    return prev.innerText.trim();
  }
  return "";
}

// aria-describedby (help text, error text) is NOT a label - it's
// supplementary context ("Format: YYYY-MM-DD", "Numbers only", the actual
// validation error once one fires) that a plain label-based match throws
// away entirely. Surfaced separately as entry.hint rather than folded into
// the label itself, since mixing the two would make label|name signatures
// (used for combobox retry-tracking) unstable the moment help text changes.
function describedByText(el) {
  const describedBy = el.getAttribute("aria-describedby");
  if (!describedBy) return "";
  return describedBy
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.innerText?.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 150);
}
