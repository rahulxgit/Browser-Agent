/* global NodeFilter */
// Runs in the page. Three jobs: (1) instant, zero-LLM-cost autofill for
// obviously-labeled fields using profile data, (2) describe the remaining
// page state to the LLM for anything the heuristic couldn't confidently
// handle, (3) carry out actions - single or batched - that come back from
// the background worker.

const ELEMENT_ATTR = "data-agent-id";
const FILLED_ATTR = "data-agent-filled";
let agentWriteInProgress = false;
let _snapshotCache = new Map();

// --- Site adapter architecture (Phase 12) -------------------------------
// Adapter files (src/adapters/*.js) are injected by background.js's
// ensureContentScript() BEFORE this file, in the same execution world -
// each one pushes itself onto self.__AGENT_ADAPTERS. Every hook is
// optional and additive: content.js's own generic detection/execution/
// verification logic (built up across Phases 5, 6, 9, 10, 11) always runs
// unless a matched adapter's hook explicitly returns something truthy to
// override it. If no adapter file loaded at all (e.g. this script somehow
// ran standalone, or a future refactor changes the injection order), the
// inline fallback below still guarantees selectAdapter() never returns
// undefined and every hook call stays safe to invoke unguarded.
const INLINE_FALLBACK_ADAPTER = {
  id: "generic-inline",
  matches: () => true,
  extractJobContext: () => null,
  normalizeField: () => null,
  executeSpecialControl: () => null,
  verifyAction: () => null
};

function selectAdapters() {
  const adapters = (typeof self !== "undefined" && self.__AGENT_ADAPTERS) || [];
  const pageContext = { hostname: location.hostname, pathname: location.pathname };
  
  const matched = [];
  for (const adapter of adapters) {
    if (adapter.id === "generic") continue;
    try {
      if (adapter.matches(pageContext)) matched.push(adapter);
    } catch {}
  }
  
  const generic = adapters.find((a) => a.id === "generic") || INLINE_FALLBACK_ADAPTER;
  matched.push(generic);
  return matched;
}

const activeAdapters = selectAdapters();

// Wraps any adapter hook call so a bug in one specific adapter can never
// break the generic pipeline it was only ever meant to optionally enhance
// - every call site below treats a thrown error identically to a null
// return: fall back to the existing generic behavior.
function callAdapterHook(hookName, ...args) {
  for (const adapter of activeAdapters) {
    try {
      const result = adapter[hookName]?.(...args);
      if (result !== undefined && result !== null) return result;
    } catch {}
  }
  return null;
}

// Native, browser-implemented visibility check (Chrome 114+, which is
// already this extension's floor). It accounts for display/visibility,
// zero-size ancestors, and content-visibility in one call instead of a
// getBoundingClientRect() + getComputedStyle() pair per element - on a
// 40-60 field ATS form that's roughly half the layout/style work per
// snapshot. Falls back to the manual check on anything older.
const supportsNativeVisibilityCheck = typeof Element.prototype.checkVisibility === "function";


// Builds a compact list of interactive elements the model can act on.
// Raw HTML is too noisy and burns tokens, so we only send what matters:
// tag, role, label text, current value, and a short id we can act on.
// Fields already filled (by the heuristic pass or a prior LLM step) are
// still included but flagged, so the model doesn't waste a step re-filling
// something that's already correct.
// Module-level, never resets. The previous per-call `let counter = 0`
// caused a real bug: once new elements appear on a later snapshot (after
// a manual edit, a conditional field revealing itself, etc.), the counter
// starts back at 0 and can hand out an id like "el-3" that's *already*
// attached to a different, older element. Two elements sharing an id means
// `document.querySelector([data-agent-id="el-3"])` resolves to whichever
// one comes first in the DOM - so an action meant for the new field could
// silently land on and overwrite the wrong (possibly already-correct,
// manually-filled) one instead.
let idCounter = 0;

// --- Select2/AJAX-style combobox filter inputs (Phase 24) ---------------
// Confirmed against a real Record-mode log (metlifecareers.com, jQuery
// Select2 nationality field): clicking the combobox opens it fine
// (aria-expanded flips to true), but Select2 doesn't let you pick an
// option by clicking the trigger a second time - the actual next step is
// to type into a small search/filter <input> that Select2 injects INSIDE
// the open dropdown pane. That input has no name, no placeholder, no
// aria-label, and isn't wrapped in a <label> - computeLabel() returns ""
// for it. An unlabeled blank text box gives the model nothing to act on,
// so it just re-clicked the same combobox every round (which does NOT
// reopen a fresh state - the field stayed expanded, nothing changed) until
// the stagnation guard killed the run. This mirrors the Ashby
// toggle-button pairing fix from the original audit, but for the
// "type here to filter" shape instead of the "separate toggle button"
// shape.
//
// Generic, not Select2-specific: any role=combobox whose aria-owns/
// aria-controls points at a currently-open listbox, where that listbox's
// dropdown "pane" contains a plain text/search input with no label of its
// own, gets that input tagged so computeLabel() can borrow the combobox's
// label plus an explicit instruction to type there.
function findComboboxFilterInput(comboboxEl) {
  const controlsId = comboboxEl.getAttribute("aria-owns") || comboboxEl.getAttribute("aria-controls");
  if (!controlsId) return null;
  const resultsEl = document.getElementById(controlsId);
  if (!resultsEl) return null;
  // Select2's actual shape: <span class="select2-dropdown">
  //   <span class="select2-search--dropdown"><input class="select2-search__field"></span>
  //   <span class="select2-results"><ul id="...-results">...options...</ul></span>
  // </span>
  // The search input is a sibling of the results container's wrapper, not
  // a descendant of it - walk up to the shared dropdown pane and search
  // from there. Fall back to a couple of parent levels for other libraries
  // that shape this differently but still nest both under one pane.
  const pane =
    resultsEl.closest("[class*='dropdown']") ||
    resultsEl.parentElement?.parentElement ||
    resultsEl.parentElement;
  if (!pane) return null;
  const input = pane.querySelector("input[type='search'], input[type='text']:not([readonly])");
  if (!input || input === comboboxEl) return null;
  return input;
}

function tagComboboxFilterInputs() {
  const openCombos = document.querySelectorAll('[role="combobox"][aria-expanded="true"]');
  for (const combo of openCombos) {
    let filterInput;
    try {
      filterInput = findComboboxFilterInput(combo);
    } catch {
      continue; // never let a malformed/unexpected dropdown shape break the whole snapshot
    }
    if (!filterInput) continue;
    // Only borrow a label when the input genuinely has none of its own -
    // never override a real label a specific site did provide.
    if (computeLabel(filterInput)) continue;
    const comboLabel = labelFor(combo) || "this field";
    filterInput.setAttribute("data-agent-inherited-label", `${comboLabel} - type to search/filter options`);
  }
}

// Hoisted to module scope (was previously nested inside
// collectInteractiveElements only) so computeStructuralFingerprint can
// also see through shadow roots - without this, a transition happening
// entirely inside a shadow-DOM component (a web-component-based question
// widget swapping its internal content) was invisible to transition
// detection even though the exact same traversal already found those
// elements for normal fill/select actions.
function queryAllShadows(root, selector) {
  let nodes = Array.from(root.querySelectorAll(selector));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
  let el;
  while ((el = walker.nextNode())) {
    if (el.shadowRoot) {
      nodes = nodes.concat(queryAllShadows(el.shadowRoot, selector));
    }
  }
  return nodes;
}

function collectInteractiveElements() {
  // Must run before the main pass below so any filter input the loop
  // encounters already carries its inherited label - order-independent
  // regardless of where in the DOM the input happens to sit relative to
  // its combobox.
  tagComboboxFilterInputs();

  const selector =
    "input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=combobox], [role=radio], [role=checkbox], " +
    // Custom (non-native) dropdowns - React-Select, Workday, Greenhouse, etc.
    // don't reliably use role=option/role=listbox at all (React-Select in
    // particular renders plain <div>s). What IS reliable across these
    // libraries is a generated id/class containing "option" (e.g.
    // react-select's `react-select-2-option-0` / `select__option`) - so we
    // match on that pattern too, not just ARIA roles, further down.
    "[role=option], [role=listbox] *, [id*='option'], [class*='option'], [contenteditable=true]";
  const nodes = queryAllShadows(document, selector);
  const results = [];
  let optionLikeCount = 0;
  const MAX_OPTION_LIKE = 40; // a big open country/state listbox can have hundreds of entries - cap so one open dropdown doesn't blow the whole snapshot's token budget

  for (const el of nodes) {
    if (!isVisible(el)) continue;
    if (el.disabled) continue;

    const role = el.getAttribute("role") || "";
    const idOrClass = `${el.id || ""} ${el.className || ""}`;
    // A leaf-level match only - a wrapping container whose id/class merely
    // *contains* "option" (e.g. an outer "options-list" div) isn't itself
    // clickable as one option; require it to actually look like a leaf
    // (no interactive-looking children) or carry role=option explicitly.
    const looksLikeGeneratedOption = /(^|[-_])option([-_]|\d|$)/i.test(idOrClass) && el.children.length === 0;
    const isOptionLike = role === "option" || looksLikeGeneratedOption || (el.tagName === "LI" && !!el.closest("[role=listbox]"));
    if (isOptionLike) {
      if (optionLikeCount >= MAX_OPTION_LIKE) continue;
      optionLikeCount++;
    } else if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && el.tagName !== "BUTTON" &&
      el.tagName !== "A" && role !== "combobox" && role !== "button" && role !== "radio" && role !== "checkbox" && !el.isContentEditable) {
      // Everything else matched only by the broad "[id*=option]"/"[class*=option]"
      // selector but didn't pass the leaf-option check above - skip it,
      // it's a container, not something the model should click.
      continue;
    }

    const id = el.getAttribute(ELEMENT_ATTR) || `el-${idCounter++}`;
    el.setAttribute(ELEMENT_ATTR, id);

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || (role === "radio" || role === "checkbox" ? role : "");
    const text = (el.innerText || el.value || "").trim().slice(0, 80);
    const label = labelFor(el).slice(0, 80);
    _snapshotCache.set(id, { id: el.id, name: el.name, tag, type, label });
    const filled = el.getAttribute(FILLED_ATTR) === "true";

    const entry = {
      id,
      tag,
      type,
      label,
      // Skip resending "text" when it's just a duplicate of the label -
      // pure token waste for buttons/links where innerText == label.
      text: text && text !== label ? text : undefined,
      name: el.name || (role === "radio" ? (el.closest('[role="radiogroup"]') || {}).id : undefined) || undefined,
      role: role || undefined,
      required: el.required || el.getAttribute("aria-required") === "true" || undefined,
      currentValue: "value" in el ? String(el.value || "").slice(0, 80) || undefined : undefined,
      filled: filled || undefined
    };

    // aria-describedby often carries genuinely load-bearing context a bare
    // label misses entirely - format hints ("MM/DD/YYYY"), character
    // limits, or (once a field has been touched) the live validation
    // error text. Only attached when non-empty and not just a repeat of
    // the label, so it doesn't double every field's token cost for no
    // benefit on plain forms that don't use it.
    const hint = describedByText(el);
    if (hint && hint !== label) entry.hint = hint;

    // aria-invalid is the one signal that distinguishes "we filled this
    // and it's fine" from "we filled this and the page just rejected it" -
    // without surfacing it, a field that fails format validation after a
    // fill still reads as filled:true and the model has no reason to ever
    // revisit it.
    if (el.getAttribute("aria-invalid") === "true") {
      entry.invalid = true;
      if (hint) entry.validationMessage = hint;
    }

    // Many forms (plenty of custom React/Vue components, and plain HTML
    // forms that never touch ARIA at all) show a validation failure with
    // no aria-invalid anywhere - the above check alone misses them
    // entirely. Every native input/textarea/select still carries the
    // browser's own Constraint Validation API regardless of framework,
    // completely independent of ARIA usage or any site-specific CSS class
    // naming (which would be exactly the kind of brittle, guessable
    // selector this codebase deliberately avoids elsewhere). valueMissing
    // is excluded on purpose - an empty required field the agent hasn't
    // reached yet isn't a validation ERROR, it's just not filled in yet;
    // this is only meant to catch a field that HAS a value the page
    // considers wrong (bad email format, pattern mismatch, out-of-range
    // number, etc), which is a genuinely different situation the model
    // needs to know to go fix rather than skip as already-handled.
    if (el.validity && !el.validity.valid && !el.validity.valueMissing && el.value) {
      entry.invalid = true;
      entry.validationMessage = entry.validationMessage || el.validationMessage || hint;
    }

    // Native type="submit" is a strong, DOM-verified submit signal on its
    // own, independent of visible text (an icon-only submit button has no
    // useful label at all). HTML defaults a plain <button type> to
    // "submit" when the attribute is omitted entirely - only meaningful
    // when the button is actually inside a <form>, so that's checked too
    // rather than flagging every bare <button> on the page.
    const rawType = el.getAttribute("type");
    const isSubmitType =
      (el.tagName === "INPUT" && rawType === "submit") ||
      (el.tagName === "BUTTON" && (rawType === "submit" || !rawType) && !!el.closest("form"));
    if (isSubmitType) entry.isSubmitType = true;

    // React-Select (and most other custom comboboxes) is the actual root
    // cause behind "click succeeds but the field never looks filled": the
    // combobox's real <input> is just a search/filter box, and its .value
    // is blank even once a real option has been picked - the picked value
    // is rendered as separate text elsewhere inside the control (e.g. a
    // `.select__single-value` span). Reading el.value alone can never see
    // a completed selection, which is why the old snapshot always reported
    // these as unfilled and the model kept reopening them forever.
    if (role === "combobox") {
      entry.isCombobox = true;
      entry.expanded = el.getAttribute("aria-expanded") === "true";
      const controlText = comboboxDisplayedValue(el);
      if (controlText && !looksLikePlaceholder(controlText)) {
        entry.currentValue = controlText.slice(0, 80);
        entry.filled = true;
      }
    } else if (tag === "button" && looksLikeComboboxToggleLabel(el)) {
      // Mirror the paired combobox's identity (label/name) and state onto
      // this button so background.js's existing isCombobox-gated retry cap
      // and post-round verification treat a click here exactly like a
      // click on the real combobox - same signature, same "filled" truth,
      // no separate bookkeeping needed on the background side at all.
      const paired = findPairedCombobox(el);
      if (paired) {
        entry.isCombobox = true;
        entry.pairedWithCombobox = true;
        const pairedLabel = labelFor(paired).slice(0, 80) || label;
        entry.label = pairedLabel;
        entry.name = paired.name || entry.name;
        entry.expanded = paired.getAttribute("aria-expanded") === "true";
        const controlText = comboboxDisplayedValue(paired);
        if (controlText && !looksLikePlaceholder(controlText)) {
          entry.currentValue = controlText.slice(0, 80);
          entry.filled = true;
        }
      }
    }

    // Any input/textarea that already has a real value - whether the user
    // typed it by hand, a previous LLM round filled it, or the heuristic
    // pass did - counts as "filled" the same way. Previously only the
    // extension's own fills got the filled:true flag; a manually-typed
    // value only showed up as currentValue, which the model wasn't
    // reliably told to leave alone, so it could "helpfully" overwrite a
    // field the user had already filled in by hand.
    if (["input", "textarea"].includes(tag) && type !== "checkbox" && type !== "radio" && type !== "file" && entry.currentValue) {
      entry.filled = true;
    }

    // checkbox/radio "value" is almost always the static string "on" (the
    // HTML default when no value attribute is set) regardless of whether
    // it's actually checked - currentValue is meaningless for these. The
    // real state the model needs is .checked, which was missing entirely
    // before this, making required consent checkboxes ("I agree to the
    // terms") invisible to the agent.
    if (type === "checkbox" || type === "radio") {
      entry.checked = el.checked !== undefined ? el.checked : el.getAttribute("aria-checked") === "true";
      entry.currentValue = undefined;
    }

    // File inputs (resume/cover letter upload) can't be filled by a script
    // at all - browsers block programmatic file selection for security.
    // Flag it explicitly so the model skips it cleanly instead of trying a
    // "fill" that silently does nothing and wastes a round figuring that
    // out the hard way.
    if (type === "file") {
      entry.requiresManualUpload = true;
      // hasUploadedFile, not a bare files.length check - see its comment
      // in dom-helpers.js for why: some drag-and-drop widgets clear the
      // underlying input's files once their own async upload finishes,
      // which would otherwise make a successfully-uploaded resume look
      // permanently empty to the rest of the pipeline.
      entry.currentValue = hasUploadedFile(el) ? "File uploaded" : undefined;
    }

    // Selects are useless to the model without knowing the valid options -
    // it was previously picking values blind. Cap at 25 options and 40
    // chars each so a huge country/state dropdown doesn't blow the budget.
    if (tag === "select") {
      entry.options = Array.from(el.options)
        
        .map((o) => ({ value: o.value, text: o.text.trim().slice(0, 40) }));
      // A select the user (or a previous run) already set is "done" the
      // same way a filled text field is - without this, a manually-chosen
      // dropdown value looked identical to an untouched one and the model
      // would happily re-pick it, sometimes to something else.
      if (el.value) entry.filled = true;
    }

    // A matched adapter gets one chance to adjust this specific entry
    // after all the generic detection above has already run - e.g. a
    // site-specific multi-part date/phone field the generic label/hint
    // logic can't fully make sense of on its own. Merged in, not replaced
    // wholesale, so an adapter only needs to return the fields it actually
    // wants to change.
    const fieldOverride = callAdapterHook("normalizeField", el, entry);
    if (fieldOverride && typeof fieldOverride === "object") Object.assign(entry, fieldOverride);

    results.push(entry);
  }

  // Radio groups need a second pass: membership can only be determined
  // once every radio in the DOM has been seen. If ANY radio in a
  // name-group is already checked - by the user manually, or by a prior
  // run - the whole group is answered. Without this, every *other* radio
  // in that group still looked like open, actionable work each round, so
  // the model (or a later heuristic pass) could click a different option
  // and silently flip a choice the user had already made by hand.
  const groupHasChecked = new Map();
  for (const el of nodes) {
    const isRadio = (el.getAttribute("type") || "").toLowerCase() === "radio" || el.getAttribute("role") === "radio";
    const groupName = el.name || (el.getAttribute("role") === "radio" ? (el.closest('[role="radiogroup"]') || {}).id : null);
    if (!isRadio || !groupName) continue;
    const isChecked = el.checked !== undefined ? el.checked : el.getAttribute("aria-checked") === "true";
    if (isChecked) groupHasChecked.set(groupName, true);
  }
  if (groupHasChecked.size) {
    for (const entry of results) {
      if (entry.type === "radio" && entry.name && groupHasChecked.get(entry.name)) {
        entry.filled = true;
      }
    }
  }

  return results;
}

// A React-Select-style control usually looks like:
//   <div class="select__control">
//     <div class="select__value-container">
//       <div class="select__single-value">India</div>   <-- the real answer
//       <input role="combobox" class="select__input" />  <-- always blank
//     </div>
//   </div>
// We don't know the library's class names in advance, so instead of
// guessing a selector, walk up a couple of container levels from the input
// and read the container's visible text with the input's own (always
// blank-ish) value subtracted out. This is generic across React-Select,
// Workday, and most other div-based combobox implementations.
function comboboxDisplayedValue(inputEl) {
  let container = inputEl.parentElement;
  for (let depth = 0; depth < 3 && container; depth++) {
    const text = container.innerText ? container.innerText.trim() : "";
    if (text) return text;
    container = container.parentElement;
  }
  return "";
}

// Some ATS widgets (Ashby's job board is the confirmed case, class prefix
// "remix-css-*") don't put the actual open/close behavior on the
// role="combobox" input itself - a separate sibling button (e.g.
// aria-label="Toggle flyout") is the real click target, and the input is
// just the filter box next to it. That button carries no role=combobox and
// no aria-expanded of its own, so the old code never flagged it as
// isCombobox - which meant it got NONE of the one-open-per-round cap,
// bounded-retry counting, or post-click "did this actually get answered"
// verification background.js already has for real combobox elements.
// Concretely: the model would batch-click 4-5 of these toggle buttons in a
// single round (nothing stopped it), and since a "toggle" click flips
// open<->closed rather than "ensure open", clicking the SAME button again
// next round (because it still looked unfilled) just closed what round 0
// had opened - net DOM state after N rounds is identical to round 0,
// which is exactly the stagnation-guard fingerprint match that was killing
// these runs. Rather than hardcode Ashby's markup, detect the pattern
// generically: a button whose accessible name suggests it toggles a
// flyout/dropdown, sitting near a role=combobox element in the same control.
function looksLikeComboboxToggleLabel(el) {
  const label = (el.getAttribute("aria-label") || el.title || "").toLowerCase();
  return /toggle|flyout|chevron|dropdown|expand|open menu/.test(label);
}

// Walks up a few container levels (a combobox "control" wrapper is almost
// never more than 2-3 levels above either the input or its toggle button)
// looking for a role=combobox element elsewhere in the same control. Capped
// depth so an unrelated ancestor (e.g. the whole form) can't accidentally
// pair a toggle button with some other field's combobox.
function findPairedCombobox(buttonEl) {
  let container = buttonEl.parentElement;
  for (let depth = 0; depth < 3 && container; depth++) {
    const found = container.querySelector('[role="combobox"]');
    if (found) return found;
    container = container.parentElement;
  }
  return null;
}

function looksLikePlaceholder(text) {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return true;
  // Strip decorative leading/trailing dashes first ("-- Select --", "- Choose -")
  // - some dropdowns wrap the placeholder in dashes and the un-stripped
  // regex below only ever matched a bare "select"/"choose" at the start.
  const stripped = normalized.replace(/^-+\s*/, "").replace(/\s*-+$/, "");
  return /^(select|choose|pick)\b.*(\.\.\.)?$|^(select|choose)$|^\s*-+\s*$|^please select/.test(stripped);
}

async function getPageSnapshot() {
  const localSnap = await getLocalPageSnapshot();
  // Previously gated on `window === window.top`, which only ever merged
  // ONE level of iframe nesting: a middle frame (itself embedded, but
  // with a child iframe of its own - e.g. an ATS iframe that embeds a
  // separate payment/background-check widget iframe) would be asked for
  // its snapshot via AGENT_REQUEST_SNAPSHOT, and used to just answer with
  // its own local elements only, silently dropping its grandchild's
  // fields with no error or signal anywhere. Every frame now performs
  // this same merge regardless of its position in the frame tree, so
  // nesting resolves correctly to any depth - each level asks its own
  // direct children, and the AGENT_REQUEST_SNAPSHOT responder below calls
  // this same recursive function rather than the local-only one.
  const frames = Array.from(document.querySelectorAll("iframe"));
  const frameSnaps = await Promise.all(frames.map((frame, index) => new Promise(resolve => {
    if (!frame.contentWindow) return resolve(null);
    const timeout = setTimeout(() => resolve(null), 500);
    const listener = (event) => {
      if (event.source === frame.contentWindow && event.data && event.data.type === "AGENT_IFRAME_SNAPSHOT") {
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        resolve(event.data.snapshot);
      }
    };
    window.addEventListener("message", listener);
    frame.contentWindow.postMessage({ type: "AGENT_REQUEST_SNAPSHOT" }, "*");
  })));
  for (let i = 0; i < frameSnaps.length; i++) {
    const fs = frameSnaps[i];
    if (fs) {
      // A grandchild element arrives already prefixed once by its own
      // parent frame (e.g. "iframe0-el-3") - prefixing again here with
      // THIS frame's index produces the full composite path
      // ("iframe1-iframe0-el-3") that dispatchAction below unwinds one
      // layer at a time on the way back down.
      localSnap.elements.push(...fs.elements.map(e => ({ ...e, id: `iframe${i}-${e.id}`, _frameIndex: i })));
      if (fs.jobContext) localSnap.jobContext = (localSnap.jobContext ? localSnap.jobContext + "\n" + fs.jobContext : fs.jobContext).slice(0, 5000);
    }
  }
  return localSnap;
}

async function getLocalPageSnapshot() {
  return {
    url: location.href,
    title: document.title,
    jobContext: extractJobContext(),
    elements: collectInteractiveElements()
  };
}

function extractJobContext() {
  // A matched adapter's own extractJobContext() gets first chance - e.g.
  // Ashby's known structured markup - before falling back to the generic
  // selector-based extraction that already worked fine for every site
  // without a dedicated adapter.
  const adapterResult = callAdapterHook("extractJobContext");
  if (adapterResult) return String(adapterResult).slice(0, 5000);

  const selectors = [
    "[data-job-description]", "[data-testid*='job-description']", "[class*='job-description']",
    "[id*='job-description']", ".jobs-description__content", ".description__text"
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = node && node.innerText ? node.innerText.replace(/\s+/g, " ").trim() : "";
    if (text.length >= 120) return text.slice(0, 5000);
  }
  return document.querySelector('meta[name="description"]')?.content?.slice(0, 1000) || "";
}

function getElementDebugState(id) {
  const el = id ? findElement(id) : null;
  if (!el) return null;
  return {
    outerHTML: el.outerHTML.slice(0, 1000),
    parentOuterHTML: el.parentElement ? el.parentElement.outerHTML.slice(0, 1500) : null,
    boundingRect: el.getBoundingClientRect().toJSON ? el.getBoundingClientRect().toJSON() : null,
    value: el.value ?? null
  };
}

function findElement(id) {
  let el = document.querySelector(`[${ELEMENT_ATTR}="${id}"]`);
  return el;
}

function setNativeValue(el, value) {
  // React and other frameworks track their own value via a setter on the
  // prototype, so a plain el.value = x doesn't trigger their onChange.
  agentWriteInProgress = true;
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    queueMicrotask(() => { agentWriteInProgress = false; });
    return;
  }

  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  queueMicrotask(() => { agentWriteInProgress = false; });
}

// --- Post-action verification (Phase 5) --------------------------------
// A resolved click()/setNativeValue() promise only proves the browser
// accepted the call, never that the field ended up in the state we wanted.
// This was already true in spirit for comboboxes (background.js checks the
// NEXT round's snapshot), but every other action type just returned
// {ok:true} unconditionally - a "select" that silently landed on the wrong
// option, or a checkbox click a framework's onChange handler rejected,
// looked identical to a real success. verifyAction() captures the concrete,
// checkable outcome for each action type right after it runs, so a failure
// is reported as a failure instead of surfacing as an inexplicable stuck
// field several rounds later.
function verifyAction(type, el, action, context = {}) {
  if (!el) return { verified: null, reason: "no target element" };

  // A matched adapter's own verification takes priority when it has one -
  // e.g. a site-specific control whose "did this actually work" signal
  // isn't a plain DOM value/checked/aria-expanded check. Falls through to
  // every generic rule below when the adapter has nothing to add.
  const override = callAdapterHook("verifyAction", type, el, action, context);
  if (override) return override;

  switch (type) {
    case "fill": {
      const expected = String(action.value ?? "");
      const actual = el.isContentEditable ? el.textContent : String(el.value ?? "");
      if (actual === expected) return { verified: true };
      return { verified: false, reason: "DOM value did not match what was written", expected, actual };
    }

    case "select": {
      const actual = el.value;
      if (actual === String(action.value)) return { verified: true };
      return { verified: false, reason: "select() did not land on the requested option", expected: action.value, actual };
    }

    case "click": {
      const tag = el.tagName.toLowerCase();
      const elRole = el.getAttribute("role");
      const inputType = (el.getAttribute("type") || (elRole === "radio" || elRole === "checkbox" ? elRole : "")).toLowerCase();

      if (inputType === "checkbox") {
        // The system prompt's only documented use of click-on-checkbox is
        // "check an unchecked consent box" - a click that leaves it
        // unchecked (framework rejected it, disabled mid-flight, etc.) is
        // a real failure, not a no-op.
        const isChecked = el.checked !== undefined ? el.checked : el.getAttribute("aria-checked") === "true";
        return isChecked
          ? { verified: true }
          : { verified: false, reason: "checkbox click did not result in checked state" };
      }

      if (inputType === "radio") {
        const isChecked = el.checked !== undefined ? el.checked : el.getAttribute("aria-checked") === "true";
        return isChecked
          ? { verified: true }
          : { verified: false, reason: "radio click did not result in checked state" };
      }

      // Option-like leaf (an item inside an open combobox/listbox) -
      // verify the parent control's displayed value actually changed to
      // something real, not just that the click event fired.
      const role = el.getAttribute("role") || "";
      const idOrClass = `${el.id || ""} ${el.className || ""}`;
      const looksLikeOption = role === "option" || /(^|[-_])option([-_]|\d|$)/i.test(idOrClass) || (tag === "li" && !!el.closest("[role=listbox]"));
      if (looksLikeOption) {
        let text = "";
        const pairedCombobox = (el.getAttribute("role") || "") === "combobox" ? el : findPairedCombobox(el);
        if (pairedCombobox && pairedCombobox.tagName === "INPUT") {
          text = pairedCombobox.value || "";
        }
        if (!text) {
          const container = el.closest("[role=listbox]")?.parentElement || el.parentElement;
          text = container ? comboboxDisplayedValue({ parentElement: container }) : "";
        }
        if (text && !looksLikePlaceholder(text)) return { verified: true, actual: text.slice(0, 80) };
        return { verified: false, reason: "clicking this option did not update the control's displayed value" };
      }

      // Combobox toggle (real role=combobox, or a paired toggle-button per
      // the isCombobox mirroring above) - the ONLY thing worth checking
      // immediately is whether this click just closed a menu that was
      // already open, which is precisely the toggle-storm bug that caused
      // production stagnation: clicking the same "open" button every round
      // with no option selected in between just flips it open/closed with
      // zero net progress forever.
      if (context.comboboxExpansion) {
        const { wasExpanded, isExpandedNow } = context.comboboxExpansion;
        if (wasExpanded && !isExpandedNow) {
          return { verified: false, fatal: true, reason: "click closed an already-open menu instead of selecting an option - do not re-click the same toggle, click one of its options instead" };
        }
        return { verified: isExpandedNow, reason: isExpandedNow ? undefined : "menu did not open" };
      }

      // Generic buttons/links: we have no way to know what a given site
      // expects a click to do, so report "unknown" honestly rather than
      // faking confidence either way. Deliberately never retried (see
      // MAX_ACTION_ATTEMPTS below) - re-clicking an unverifiable button
      // could double-submit a form action or duplicate a list entry.
      return { verified: null, reason: "no automatic verification available for a generic click" };
    }

    default:
      return { verified: null };
  }
}

// --- Bounded action recovery (Phase 6) ---------------------------------
// A verification failure used to just get reported and left for a whole
// extra LLM round to notice and retry - slow, burns round/token budget,
// and for the exact toggle-storm bug this replaces, actively wrong (the
// model would often re-click the SAME toggle the SAME way, closing what it
// had just reopened, forever). Recovery instead happens immediately,
// synchronously, inside the content script: try up to MAX_ACTION_ATTEMPTS
// total attempts, escalating to a different DOM strategy each time,
// stopping the moment a real verification (true) is reached. Never
// unbounded - after the cap, the final failed result is returned as-is for
// background.js/the LLM to decide the next move (retry differently next
// round, or hand off to the human), matching the existing combobox
// ask-fallback pattern rather than duplicating it here.
const MAX_ACTION_ATTEMPTS = 3;

function typeCharacterByCharacter(el, value) {
  // Strategy 2 for "fill": some heavily-customized inputs (seen mostly on
  // Material UI/Workday-style forms) only commit a value if it arrives as
  // a real sequence of keydown/input/keyup events rather than one bulk
  // value-setter call - setNativeValue's single dispatch can get silently
  // ignored by an onKeyDown-driven masked-input component.
  agentWriteInProgress = true;
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  const setValue = (v) => (descriptor && descriptor.set ? descriptor.set.call(el, v) : (el.value = v));
  setValue("");
  let current = "";
  for (const ch of value) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    current += ch;
    setValue(current);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  queueMicrotask(() => { agentWriteInProgress = false; });
}

function toggleViaKeyboard(el) {
  // Strategy 2 for checkbox/radio clicks: .click() can be swallowed by an
  // overlay or a preventDefault'd handler on some custom-styled toggle
  // components. A real Space keypress is what a keyboard user (and most
  // accessible custom checkbox implementations) actually triggers on.
  el.focus();
  el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true }));
}

function clickViaPointerSequence(el) {
  // Strategy 2 for option-leaf clicks: some virtualized/portal-rendered
  // option lists (react-window, react-virtual) bind selection to
  // mousedown/pointerdown rather than the synthetic click .click() fires,
  // so a plain click() can silently do nothing on the first attempt.
  for (const EventCtor of [PointerEvent, MouseEvent]) {
    el.dispatchEvent(new EventCtor("pointerdown", { bubbles: true }));
    el.dispatchEvent(new EventCtor("mousedown", { bubbles: true }));
    el.dispatchEvent(new EventCtor("mouseup", { bubbles: true }));
    break; // PointerEvent covers both cases when supported; MouseEvent is the fallback constructor if PointerEvent is undefined
  }
  el.click();
}

// --- Submit safety, Layer 3 (Phase 7) ----------------------------------
// background.js's isLikelySubmitAction() is Layer 2 - it decides whether
// to pause for human confirmation BEFORE an action ever reaches here. This
// is the independent Layer 3: even if background's classifier has a bug,
// or a prompt-injected instruction somehow got a submit-shaped click into
// a batch without going through the pause, THIS check still refuses to
// execute it. Deliberately a separate, minimal, self-contained heuristic
// (not shared code with background.js) - the point of two independent
// layers is that one has a blind spot the other doesn't, so they should
// not be able to fail identically from the same bug.
const CONTENT_SCRIPT_SUBMIT_PHRASES = [
  "submit", "apply now", "send application", "finish application",
  "complete application", "confirm and submit", "place order", "pay now",
  "confirm and pay", "delete account"
];

function looksSubmitLikeToContentScript(el) {
  const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || el.name || el.placeholder || "").toLowerCase().trim();
  return CONTENT_SCRIPT_SUBMIT_PHRASES.some(phrase => text.includes(phrase));
}

// Executes exactly one attempt for one strategy index and returns the
// verification result. Element is re-queried fresh each attempt (not
// reused from a previous attempt) so a DOM re-render between attempts
// (React tearing down and recreating the node) can't leave us acting on a
// stale reference - findElement() re-resolves by the stable data-agent-id.
function attemptAction(action, strategyIndex) {
  const { type, targetId, value } = action;
  const el = targetId ? findElement(targetId) : null;
  if (!el) throw new Error(`No element for ${targetId}`);

  // A matched adapter gets first refusal on strategyIndex 0 only - later
  // recovery attempts (strategyIndex >= 1) always fall through to the
  // generic strategies below, since an adapter override that failed once
  // has no special claim to a retry the generic bounded-recovery loop
  // (Phase 6) already handles perfectly well.
  if (strategyIndex === 0) {
    const override = callAdapterHook("executeSpecialControl", action, el, strategyIndex);
    if (override) return override;
  }

  switch (type) {
    case "fill": {
      if (el.tagName === "SELECT") throw new Error("Use select action for a dropdown");
      if (!el.isContentEditable && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") {
        throw new Error("Fill is only supported for text inputs, textareas, and editable text");
      }
      if (["file", "checkbox", "radio", "hidden", "submit", "button", "password"].includes((el.type || "").toLowerCase())) {
        throw new Error(`Fill is not supported for input type ${el.type || "unknown"}`);
      }
      el.focus();
      if (strategyIndex === 0) {
        setNativeValue(el, String(value ?? ""));
      } else {
        typeCharacterByCharacter(el, String(value ?? ""));
      }
      el.setAttribute(FILLED_ATTR, "true");
      return verifyAction("fill", el, action);
    }

    case "select": {
      if (el.tagName !== "SELECT") throw new Error("Select action requires a native dropdown");
      if (!Array.from(el.options).some((option) => option.value === String(value))) {
        throw new Error(`Dropdown option is not available: ${value}`);
      }
      if (strategyIndex >= 1) el.focus(); // strategy 2: ensure focus before writing, in case a blur handler was resetting the value
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.setAttribute(FILLED_ATTR, "true");
      return verifyAction("select", el, action);
    }

    case "click": {
      const inputType = (el.getAttribute("type") || "").toLowerCase();

      // Layer 3 gate - see looksSubmitLikeToContentScript() above. Must run
      // before any DOM interaction at all, not just before el.click() -
      // scrollIntoView itself is harmless, but checking first means a
      // blocked action never does anything observable to the page.
      if (looksSubmitLikeToContentScript(el) && !action.confirmationToken) {
        throw new Error(
          "Blocked: this looks like a final submit/confirm/delete action and has no human-confirmation token attached. " +
          "It must go through the pause-and-confirm flow, not a regular action batch."
        );
      }

      const comboboxEl = (el.getAttribute("role") || "") === "combobox" ? el : findPairedCombobox(el);
      const wasExpanded = comboboxEl ? comboboxEl.getAttribute("aria-expanded") === "true" : undefined;

      el.scrollIntoView({ block: "center" });
      if (inputType === "checkbox" || inputType === "radio") {
        if (strategyIndex === 0) el.click();
        else toggleViaKeyboard(el);
      } else if (strategyIndex >= 2) {
        clickViaPointerSequence(el);
      } else {
        el.click();
      }

      const context = comboboxEl
        ? { comboboxExpansion: { wasExpanded, isExpandedNow: comboboxEl.getAttribute("aria-expanded") === "true" } }
        : {};
      return verifyAction("click", el, action, context);
    }

    default:
      throw new Error(`Unknown action type for recovery: ${type}`);
  }
}

// Public entry point: runs the bounded-recovery loop for types that have a
// meaningful retry strategy (fill/select/click), single-shot for
// everything else (type/scroll/wait have no verification to recover from).
async function runSingleAction(action) {
  const { type, targetId, value } = action;

  if (!["fill", "select", "click"].includes(type)) {
    return runSingleActionLegacy(action);
  }

  const el = targetId ? findElement(targetId) : null;
  if (!el) throw new Error(`No element for ${targetId}`);

  let lastResult = null;
  const strategiesTried = [];

  for (let attempt = 0; attempt < MAX_ACTION_ATTEMPTS; attempt++) {
    lastResult = attemptAction(action, attempt);
    strategiesTried.push(attempt);

    // verified === true -> done. verified === null -> nothing to recover
    // from (no check applies, e.g. a generic button) - retrying blind is
    // never safe, so stop after the first attempt regardless of the cap.
    if (lastResult.verified === true || lastResult.verified === null || lastResult.fatal) break;

    // verified === false -> a real, checkable failure. Try again with the
    // next strategy unless we've hit the hard cap.
  }

  const exhausted = lastResult.verified === false;
  return { ok: true, ...lastResult, attempts: strategiesTried.length, exhausted: exhausted || undefined };
}

async function runSingleActionLegacy(action) {
  const { type, targetId, value } = action;
  const el = targetId ? findElement(targetId) : null;

  switch (type) {
    case "type":
      // Keyboard fallback for comboboxes that filter as you type (most
      // React-Select-style controls do) - type the desired text into the
      // search input, then optionally press Enter to accept whichever
      // option the filtering left highlighted. Useful when clicking a
      // rendered option is unreliable (e.g. it re-renders mid-click).
      if (!el) throw new Error(`No element for ${targetId}`);
      el.focus();
      setNativeValue(el, String(value ?? ""));
      if (action.pressEnter) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      }
      return { ok: true };

    case "scroll": {
      // Defense in depth - background.js's validateAction (Phase 4)
      // already bounds this for actions coming straight from the model,
      // but a few internal fallback actions get constructed by
      // background.js AFTER that validation loop runs (the bounded-retry
      // "type" reconstructions) and never pass through it. Clamping here
      // too means no path - model output or internal code - can ever
      // request an unbounded scroll.
      const clamped = Math.max(-20000, Math.min(20000, Number(value) || 400));
      window.scrollBy(0, clamped);
      return { ok: true };
    }

    case "wait": {
      // Same reasoning as scroll - this is the one gap Phase 4 found that
      // had NO cap anywhere before: an unbounded wait could hang a round
      // indefinitely. 5000ms matches background.js's MAX_WAIT_MS.
      const clamped = Math.max(0, Math.min(5000, Number(value) || 500));
      await new Promise((r) => setTimeout(r, clamped));
      return { ok: true };
    }

    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

// Resolves one action to wherever its target actually lives - locally in
// this frame, or forwarded into a (possibly further-nested) child iframe.
// Extracted out of runActionBatch's loop so the exact same forwarding
// logic can also be used by the AGENT_RUN_ACTION responder below: a
// forwarded action's targetId can itself still carry a further
// "iframeN-" prefix when the real target is nested two or more levels
// deep (composite ids like "iframe1-iframe0-el-3", produced by
// getPageSnapshot's merge). Without this being shared, only the top
// frame ever unwrapped a prefix, and a nested target one level further
// down had nothing to strip it and would fail with "element not found"
// on an id that was never meant to be looked up literally.
async function dispatchAction(originalAction) {
  let action = { ...originalAction };
  if (action.targetId && action.targetId.startsWith("iframe")) {
    const match = action.targetId.match(/^iframe(\d+)-(.*)$/);
    if (match) {
      const frameIndex = parseInt(match[1]);
      action.targetId = match[2];
      const frames = Array.from(document.querySelectorAll("iframe"));
      const frame = frames[frameIndex];
      if (frame && frame.contentWindow) {
        const msgId = Math.random().toString();
        const res = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Iframe action timeout")), 5000);
          const listener = (event) => {
            if (event.source === frame.contentWindow && event.data && event.data.type === "AGENT_ACTION_RESULT" && event.data.id === msgId) {
              clearTimeout(timeout);
              window.removeEventListener("message", listener);
              resolve(event.data.result);
            }
          };
          window.addEventListener("message", listener);
          frame.contentWindow.postMessage({ type: "AGENT_RUN_ACTION", action, msgId }, "*");
        });
        return res;
      }
    }
  }
  return runSingleAction(action);
}

// Runs a batch of actions in order, stopping early if one fails or if a
// submit-like click shows up (the background worker checks for that before
// sending the batch, but this is a second guard in case something slips
// through). Returns per-action results so the caller can log exactly what
// happened.
async function runActionBatch(actions) {
  const results = [];
  for (const originalAction of actions) {
    try {
      const res = await dispatchAction(originalAction);
      results.push({ action: originalAction, ...res });
    } catch (err) {
      results.push({ action: originalAction, ok: false, error: err.message });
    }
  }
  return results;
}

// Waits until the DOM has stopped changing (no mutations for `quietMs`),
// capped at `maxMs` total. Used instead of a fixed sleep after actions -
// static forms resolve almost instantly instead of always waiting the
// worst-case delay, while genuinely dynamic pages (validation messages,
// conditional fields appearing) still get real time to settle.
function waitForDomStable(quietMs = 150, maxMs = 1500) {
  return new Promise((resolve) => {
    let settleTimer = null;
    const hardCap = setTimeout(finish, maxMs);

    const observer = new MutationObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, quietMs);
    });

    function finish() {
      clearTimeout(settleTimer);
      clearTimeout(hardCap);
      observer.disconnect();
      resolve();
    }

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    settleTimer = setTimeout(finish, quietMs);
  });
}

// --- Heuristic autofill -----------------------------------------------
// Matches common job-application fields directly against profile data by
// label/name keywords, with zero LLM calls. This is what makes filling a
// 15-field form fast and nearly free - the LLM only needs to handle
// whatever this pass can't confidently match (custom questions, dropdowns
// with unpredictable option text, etc).


function getFormStatus() {
  const fields = Array.from(document.querySelectorAll("input, textarea, select, [role=radio], [role=checkbox]"));
  const missing = [];
  const seenRadioGroups = new Set();

  for (const el of fields) {
    // el.required alone misses custom upload widgets that mark themselves
    // required only via aria-required (common on accessible drag-and-drop
    // components, which frequently aren't real <input required> at all,
    // just a styled wrapper around a plain hidden file input).
    const isRequired = el.required || el.getAttribute("aria-required") === "true";
    if (!isVisible(el) || el.disabled || !isRequired) continue;
    const role = el.getAttribute("role");
    const type = (el.type || (role === "radio" || role === "checkbox" ? role : "")).toLowerCase();
    if (type === "file") {
      if (!hasUploadedFile(el)) missing.push({ label: labelFor(el) || "Required file upload", type: "file" });
      continue;
    }
    if (type === "checkbox") {
      const isChecked = el.checked !== undefined ? el.checked : el.getAttribute("aria-checked") === "true";
      if (!isChecked) missing.push({ label: labelFor(el) || "Required confirmation", type });
      continue;
    }
    if (type === "radio") {
      const group = el.name || (el.getAttribute("role") === "radio" ? (el.closest('[role="radiogroup"]') || {}).id : null) || el.id;
      if (!group || seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
      
      let someChecked = false;
      if (el.name) {
        const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`));
        someChecked = radios.some((radio) => radio.checked);
      } else {
        const radiogroup = el.closest('[role="radiogroup"]');
        if (radiogroup) {
          const radios = Array.from(radiogroup.querySelectorAll('[role="radio"]'));
          someChecked = radios.some((radio) => radio.getAttribute("aria-checked") === "true");
        } else {
          someChecked = el.getAttribute("aria-checked") === "true";
        }
      }
      if (!someChecked) missing.push({ label: labelFor(el) || "Required choice", type });
      continue;
    }
    if (!String(el.value || "").trim()) missing.push({ label: labelFor(el) || el.name || "Required field", type: el.tagName.toLowerCase() });
  }

  return { missing, count: missing.length };
}

// --- Submission verification (Phase 9) ----------------------------------
// A confirmed submit click resolving without throwing only proves the
// click event fired - never that a form actually posted successfully.
// This looks for the same signals a person would: did the URL change, did
// a success/confirmation message show up, or is there an error banner
// still sitting on the page. None of these are perfectly reliable alone
// (some ATSs stay on the same URL and just swap content via history.push,
// others show a toast that's gone by the time this runs) - that's exactly
// why the caller treats "not verified" as its own honest outcome rather
// than either "success" or "failure".
// Phase 25: widened after this pattern kept showing up as "could not be
// verified" across several real runs (BambooHR among them) even on forms
// that plausibly did go through - the original phrase list was written
// against a handful of ATSs and missed common wording elsewhere.
const SUCCESS_PHRASES = [
  "thank you for applying", "thank you for your application", "application received",
  "application submitted", "successfully submitted", "we've received your application",
  "your application has been submitted", "thanks for applying", "application complete",
  "application has been received", "application was successful", "application confirmed",
  "we'll be in touch", "we will be in touch", "your submission has been received", "applied successfully", "application sent", "you've applied", "has been sent successfully", "application is complete",
  "you have successfully applied", "we have received your application"
];

const ERROR_PHRASES = [
  "something went wrong", "please try again", "failed to submit", "session expired",
  "please log in", "please sign in", "an error occurred", "unable to submit"
];

// Best-effort DIRECT text access from same-origin child iframes, as a
// supplementary source alongside the top document. This function itself
// only helps with same-origin children (frame.contentDocument throws for
// cross-origin ones - genuinely, permanently blocked by the browser for
// plain DOM access, extension or not). That used to make this comment
// note cross-origin frames as an unfixable structural gap - it isn't one
// anymore: ensureContentScript in background.js now injects with
// allFrames:true, which DOES reach cross-origin child frames (a
// browser-granted extension privilege distinct from the DOM access
// blocked here), and content.js's own AGENT_REQUEST_OUTCOME /
// AGENT_IFRAME_OUTCOME postMessage protocol in getSubmissionOutcome()
// below relays outcomes out of those frames regardless of origin. So a
// cross-origin iframe's confirmation text IS visible to
// getSubmissionOutcome() today, just not through this particular
// function - verified live in
// tests/extension-harness/cross-origin-iframe.spec.js against two real
// servers on different ports. This function stays as a same-origin-only
// convenience path; the real cross-origin coverage lives in the
// postMessage merge, not here.
function collectFrameText() {
  let combined = document.body.innerText || "";
  const iframes = document.querySelectorAll("iframe");
  for (const frame of iframes) {
    try {
      const frameDoc = frame.contentDocument;
      if (frameDoc && frameDoc.body) combined += "\n" + (frameDoc.body.innerText || "");
    } catch {
      // Cross-origin - inaccessible by design, nothing more to do here.
    }
  }
  return combined;
}

async function getSubmissionOutcome(previousUrl) {
  // Same nested-iframe fix as getPageSnapshot above - this used to only
  // merge child-frame outcomes at the very top frame, so a validation
  // error surfacing inside a grandchild iframe (a payment/background-
  // check widget embedded inside an ATS's own iframe) was invisible no
  // matter how the top frame polled. Every frame now merges its own
  // direct children's outcomes, recursing naturally to any depth.
  const frames = Array.from(document.querySelectorAll("iframe"));
  const frameOutcomes = await Promise.all(frames.map(frame => new Promise(resolve => {
    if (!frame.contentWindow) return resolve(null);
    const timeout = setTimeout(() => resolve(null), 500);
    const listener = (event) => {
      if (event.source === frame.contentWindow && event.data && event.data.type === "AGENT_IFRAME_OUTCOME") {
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        resolve(event.data.outcome);
      }
    };
    window.addEventListener("message", listener);
    frame.contentWindow.postMessage({ type: "AGENT_REQUEST_OUTCOME", previousUrl }, "*");
  })));
  let outcome = getLocalSubmissionOutcome(previousUrl);
  for (const fo of frameOutcomes) {
    if (fo) {
      if (fo.urlChanged) outcome.urlChanged = true;
      if (fo.successPhraseMatched) outcome.successPhraseMatched = fo.successPhraseMatched;
      if (fo.errorPhraseMatched) outcome.errorPhraseMatched = fo.errorPhraseMatched;
      if (fo.alertText) outcome.alertText = fo.alertText;
      outcome.remainingFieldCount += fo.remainingFieldCount;
    }
  }
  return outcome;
}

function getLocalSubmissionOutcome(previousUrl) {
  const urlChanged = location.href !== previousUrl;
  const bodyText = collectFrameText().slice(0, 6000).toLowerCase();

  const successPhraseMatched = SUCCESS_PHRASES.find((p) => bodyText.includes(p)) || null;
  const errorPhraseMatched = ERROR_PHRASES.find((p) => bodyText.includes(p)) || null;

  // An explicit ARIA alert/live-region is a stronger, more specific signal
  // than scanning body text for phrases - if the page raised one, surface
  // its text directly rather than only a generic phrase match.
  const alertEl = document.querySelector('[role="alert"], [aria-live="assertive"]');
  const alertText = alertEl && alertEl.innerText ? alertEl.innerText.trim().slice(0, 200) : null;

  // Weak supplementary signal, surfaced but deliberately NOT folded into
  // "verified" on its own (too easy for a page that just hides the form
  // behind a loading spinner to false-positive this): did the form's
  // required-looking fields largely disappear from the page after
  // submitting? A big drop is consistent with the form being swapped out
  // for a confirmation panel. Useful context for a human reading the
  // record log even when the phrase/URL signals above stay inconclusive.
  const remainingFieldCount = document.querySelectorAll("input:not([type=hidden]), textarea, select, [role=radio], [role=checkbox]").length;

  return {
    url: location.href,
    urlChanged,
    successPhraseMatched,
    errorPhraseMatched,
    alertText: alertText || null,
    remainingFieldCount
  };
}

// Some frameworks (virtualized lists, infinite-scroll question sets,
// content gated behind an IntersectionObserver-triggered lazy hydration)
// simply do not put later fields in the DOM at all until the page has
// actually been scrolled near them - unlike a normal long form, where
// isVisible()'s checkVisibility() already sees everything regardless of
// scroll position because it's all rendered up front. Those cases used to
// produce exactly the log's dangerous failure mode: the first snapshot
// legitimately found zero elements (there was nothing to find yet), and
// that got reported as "form already filled / nothing to fill" instead of
// "haven't looked at the rest of the page yet".
//
// This walks the page in viewport-sized steps, waiting briefly at each
// stop for any lazy content to mount, then returns to the original
// scroll position. It does not collect elements itself - it only ensures
// they exist in the DOM before the normal collectInteractiveElements()
// pass (already called right after this, in getLocalPageSnapshot) runs.
// Bounded on both ends (step count and per-step wait) so a page with a
// genuinely infinite scroll (social feeds, "load more" spam) can't turn
// one snapshot into an unbounded scroll-forever loop.
const MAX_DISCOVERY_SCROLL_STEPS = 10;

async function discoverElementsBeyondViewport() {
  const doc = document.scrollingElement || document.documentElement;
  const startY = window.scrollY;
  const viewportH = window.innerHeight;

  // Nothing meaningfully below the fold - not worth the settle-wait cost
  // on the vast majority of short forms, which is every round otherwise.
  if (doc.scrollHeight <= viewportH * 1.3) return;

  let previousHeight = doc.scrollHeight;
  let stableHeightCount = 0;

  for (let step = 0; step < MAX_DISCOVERY_SCROLL_STEPS; step++) {
    const targetY = Math.min((step + 1) * viewportH * 0.85, doc.scrollHeight - viewportH);
    window.scrollTo({ top: targetY, behavior: "instant" });
    await waitForDomStable(120, 500);

    const atBottom = window.scrollY + viewportH >= doc.scrollHeight - 2;
    const heightUnchanged = doc.scrollHeight === previousHeight;
    stableHeightCount = heightUnchanged ? stableHeightCount + 1 : 0;
    previousHeight = doc.scrollHeight;

    // Two consecutive steps with neither new height (nothing lazy-loaded
    // in) nor further room to scroll means there's nothing left to
    // discover - stop early instead of burning the full step budget on a
    // short-ish page that just barely exceeded the 1.3x threshold above.
    if (atBottom && stableHeightCount >= 2) break;
  }

  // Restore exactly where the page was - this runs mid-task, potentially
  // with a human watching, and should be invisible/undisturbing when it
  // doesn't find anything new.
  window.scrollTo({ top: startY, behavior: "instant" });
  await waitForDomStable(80, 400);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (window !== window.top) return false;
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_SNAPSHOT") {
    (async () => {
      if (msg.discoverScroll) {
        try {
          await discoverElementsBeyondViewport();
        } catch {
          // Non-fatal - a page that fights back on programmatic scrolling
          // (locked body, custom scroll-jacking) just falls back to
          // whatever was already rendered, same as before this existed.
        }
      }
      sendResponse(await getPageSnapshot());
    })();
    return true;
  }

  if (msg.type === "RUN_ACTION") {
    // Backward compatible single-action path.
    runSingleAction(msg.action)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "RUN_ACTION_BATCH") {
    runActionBatch(msg.actions)
      .then((results) => sendResponse({ results }))
      .catch((err) => sendResponse({ results: [], error: err.message }));
    return true;
  }

  if (msg.type === "WAIT_DOM_STABLE") {
    waitForDomStable(msg.quietMs, msg.maxMs).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "SMART_AUTOFILL") {
    (async () => {
      try {
        const result = await smartAutofill(msg.profileData);
        sendResponse(result);
      } catch (err) {
        sendResponse({ filledCount: 0, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "GET_DEBUG_STATE") {
    sendResponse(getElementDebugState(msg.targetId));
    return true;
  }

  if (msg.type === "GET_FORM_STATUS") {
    sendResponse(getFormStatus());
    return true;
  }

  if (msg.type === "GET_SUBMISSION_OUTCOME") {
    try {
      getSubmissionOutcome(msg.previousUrl).then(sendResponse);
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return true;
  }

  if (msg.type === "GET_TRANSITION_STATE") {
    getTransitionState()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// A "Continue"/"Next" click on an SPA/LiveView-style multi-step form
// almost never causes a traditional navigation - the URL frequently stays
// identical while the same route just swaps in a whole new set of
// questions. Before this existed, nothing distinguished that legitimate
// case from "the click silently did nothing" - both looked like "no URL
// change" to the only signal being checked (getSubmissionOutcome's
// urlChanged, which was built for the different, narrower job of
// detecting a final form submission). This computes a cheap structural
// signature of the CURRENT set of interactive fields so a caller can
// diff it against an earlier one and catch a same-URL DOM swap, not just
// a URL change.
//
// Deliberately NOT a cryptographic hash - collisions are irrelevant here
// (this only ever answers "did the field set meaningfully change", never
// anything security-sensitive), and a simple length-capped join of
// tag+type+name+label is both fast to compute every poll tick and easy
// to eyeball in a record log if something ever needs to be debugged by a
// human, unlike an opaque hash.
function computeStructuralFingerprint() {
  // queryAllShadows, not a plain querySelectorAll - a transition entirely
  // inside a shadow-DOM component (a web-component question widget
  // swapping its own internal content) previously produced an identical
  // fingerprint before and after, since a plain query can't see past a
  // shadow root at all. Reuses the exact same traversal
  // collectInteractiveElements already relies on for fill/select, so
  // anything the agent can act on is also something transition detection
  // can see change.
  const nodes = queryAllShadows(document, "input:not([type=hidden]), textarea, select, button, [role=button], [role=radio], [role=checkbox]");
  const parts = nodes.slice(0, 200).map((el) => {
    const label = (computeLabel(el) || el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40);
    return `${el.tagName}:${el.type || ""}:${el.name || ""}:${label}`;
  });
  return parts.join("|").slice(0, 4000);
}

async function getTransitionState() {
  const local = {
    url: location.href,
    title: document.title,
    structuralFingerprint: computeStructuralFingerprint(),
    remainingFieldCount: document.querySelectorAll("input:not([type=hidden]), textarea, select, [role=radio], [role=checkbox]").length,
    errorPhraseMatched: ERROR_PHRASES.find((p) => collectFrameText().slice(0, 6000).toLowerCase().includes(p)) || null
  };
  // Same recursive iframe-merge pattern as getPageSnapshot/
  // getSubmissionOutcome - without it, a "Continue"-equivalent click
  // whose only visible effect was swapping content INSIDE an iframe (a
  // Greenhouse/Workday-style embed replacing its own question set) would
  // report structuralFingerprint as unchanged, since only the top
  // document's fields were ever being compared.
  const frames = Array.from(document.querySelectorAll("iframe"));
  if (frames.length === 0) return local;
  const frameStates = await Promise.all(frames.map((frame, index) => new Promise(resolve => {
    if (!frame.contentWindow) return resolve(null);
    const timeout = setTimeout(() => resolve(null), 500);
    const listener = (event) => {
      if (event.source === frame.contentWindow && event.data && event.data.type === "AGENT_IFRAME_TRANSITION_STATE") {
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        resolve(event.data.state);
      }
    };
    window.addEventListener("message", listener);
    frame.contentWindow.postMessage({ type: "AGENT_REQUEST_TRANSITION_STATE" }, "*");
  })));
  for (let i = 0; i < frameStates.length; i++) {
    const fs = frameStates[i];
    if (fs) {
      local.structuralFingerprint += `||iframe${i}:${fs.structuralFingerprint}`;
      local.remainingFieldCount += fs.remainingFieldCount;
      if (fs.errorPhraseMatched && !local.errorPhraseMatched) local.errorPhraseMatched = fs.errorPhraseMatched;
    }
  }
  return local.structuralFingerprint.length > 4000
    ? { ...local, structuralFingerprint: local.structuralFingerprint.slice(0, 4000) }
    : local;
}


if (window !== window.top) {
  window.addEventListener("message", async (event) => {
    if (event.data && event.data.type === "AGENT_REQUEST_SNAPSHOT") {
      // Recursive (this frame's own children get merged in too, not just
      // its local elements) - see getPageSnapshot's comment on why the
      // old window===window.top gate silently dropped grandchild frames.
      event.source.postMessage({ type: "AGENT_IFRAME_SNAPSHOT", snapshot: await getPageSnapshot() }, "*");
    }
    if (event.data && event.data.type === "AGENT_REQUEST_OUTCOME") {
      event.source.postMessage({ type: "AGENT_IFRAME_OUTCOME", outcome: await getSubmissionOutcome(event.data.previousUrl) }, "*");
    }
    if (event.data && event.data.type === "AGENT_REQUEST_TRANSITION_STATE") {
      event.source.postMessage({ type: "AGENT_IFRAME_TRANSITION_STATE", state: await getTransitionState() }, "*");
    }
    if (event.data && event.data.type === "AGENT_RUN_ACTION") {
      try {
        // dispatchAction, not runSingleAction directly - a forwarded
        // action's targetId can still carry a further "iframeN-" prefix
        // when the real target is nested two or more levels deep, and
        // only dispatchAction knows how to keep unwrapping and forwarding
        // it the rest of the way down.
        const res = await dispatchAction(event.data.action);
        event.source.postMessage({ type: "AGENT_ACTION_RESULT", id: event.data.msgId, result: res }, "*");
      } catch (err) {
        event.source.postMessage({ type: "AGENT_ACTION_RESULT", id: event.data.msgId, result: { ok: false, error: err.message } }, "*");
      }
    }
  });
}

let _visionStyle = null;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PREPARE_VISION") {
    if (!_visionStyle) {
      _visionStyle = document.createElement("style");
      document.head.appendChild(_visionStyle);
    }
    const ids = msg.sensitiveIds || [];
    const selectors = ids.map(id => `[data-agent-id="${id}"]`).join(", ");
    const rule = selectors ? `${selectors}, input[type="password"] { color: transparent !important; background-color: black !important; border-color: black !important; }` : `input[type="password"] { color: transparent !important; background-color: black !important; border-color: black !important; }`;
    _visionStyle.textContent = rule;
    sendResponse({ ok: true });
  }
  if (msg.type === "CLEANUP_VISION") {
    if (_visionStyle && _visionStyle.parentNode) {
      _visionStyle.parentNode.removeChild(_visionStyle);
      _visionStyle = null;
    }
    sendResponse({ ok: true });
  }
});
