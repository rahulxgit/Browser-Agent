// --- Field detection / heuristic autofill matching, extracted from
// content.js (Phase 21) -------------------------------------------
// Injected into the SAME execution world as content.js via
// chrome.scripting.executeScript's files array (background.js's
// ensureContentScript, same pattern already used for src/adapters/*.js) -
// every function here is directly callable from content.js exactly as if
// it had never moved. FIELD_RULES/GROUP_CONTEXT_RULES/smartAutofill and
// friends: the zero-LLM-cost heuristic pass and its supporting matching
// tables, kept together since they only ever get called as a unit.

const FIELD_RULES = [
  { keys: ["first name", "firstname", "fname", "given name", "nombre", "prénom", "vorname"], profileKeys: ["firstName", "first_name"] },
  { keys: ["middle name", "middlename", "segundo nombre", "deuxième prénom", "zweiter vorname"], profileKeys: ["middleName", "middle_name"] },
  { keys: ["last name", "lastname", "lname", "surname", "family name", "apellidos", "nom de famille", "nachname"], profileKeys: ["lastName", "last_name"] },
  { keys: ["full name", "your name", "candidate name", "nombre completo", "nom complet", "vollständiger name"], profileKeys: ["name", "fullName"] },
  { keys: ["preferred name", "nickname", "apodo", "surnom", "spitzname"], profileKeys: ["preferredName", "nickname"] },
  { keys: ["pronoun", "pronombre", "pronom", "pronomen"], profileKeys: ["pronouns"] },
  { keys: ["email", "e-mail", "correo electrónico", "courriel", "e-mail-adresse"], profileKeys: ["email"] },
  { keys: ["phone", "mobile", "contact number", "teléfono", "móvil", "téléphone", "telefon", "handy"], profileKeys: ["phone", "phoneNumber"] },
  { keys: ["linkedin"], profileKeys: ["linkedin", "linkedinUrl"] },
  { keys: ["github"], profileKeys: ["github", "githubUrl"] },
  { keys: ["portfolio", "personal website", "sitio web", "site web", "webseite"], profileKeys: ["portfolio", "portfolioUrl", "website"] },
  { keys: ["twitter", "x profile"], profileKeys: ["twitter", "twitterUrl"] },
  { keys: ["address line", "street address", "address", "dirección", "adresse"], profileKeys: ["address", "addressLine1"] },
  { keys: ["city", "current city", "ciudad", "ville", "stadt"], profileKeys: ["city"] },
  { keys: ["state", "province", "region", "estado", "provincia", "région", "bundesland"], profileKeys: ["state", "region"] },
  { keys: ["country", "país", "pays", "land"], profileKeys: ["country"] },
  { keys: ["zip", "postal code", "pincode", "código postal", "code postal", "postleitzahl"], profileKeys: ["postalCode", "zipCode", "pincode"] },
  { keys: ["university", "college", "institute", "school name", "universidad", "université", "universität"], profileKeys: ["university", "college"] },
  { keys: ["degree", "título", "diplôme", "abschluss"], profileKeys: ["degree"] },
  { keys: ["field of study", "major", "specialization", "área de estudio", "domaine d'études", "studienfach"], profileKeys: ["fieldOfStudy", "major", "specialization"] },
  { keys: ["cgpa", "gpa", "promedio", "moyenne", "notendurchschnitt"], profileKeys: ["cgpa", "gpa"] },
  { keys: ["graduation year", "grad year", "graduation date", "año de graduación", "année d'obtention du diplôme", "abschlussjahr"], profileKeys: ["graduationYear"] },
  { keys: ["notice period", "período de preaviso", "préavis", "kündigungsfrist"], profileKeys: ["noticePeriod"] },
  { keys: ["current salary", "current ctc", "current compensation", "salario actual", "salaire actuel", "aktuelles gehalt"], profileKeys: ["currentSalary", "currentCTC"] },
  { keys: ["expected salary", "expected ctc", "salary expectation", "desired salary", "salario esperado", "salaire souhaité", "gehaltsvorstellung"], profileKeys: ["expectedSalary", "expectedCTC"] },
  { keys: ["available from", "availability", "start date", "disponibilidad", "disponibilité", "verfügbarkeit", "startdatum"], profileKeys: ["availability", "availableFrom"] },
  { keys: ["work authorization", "authorized to work", "autorización de trabajo", "autorisation de travail", "arbeitserlaubnis"], profileKeys: ["workAuthorization"] },
  { keys: ["current company", "current employer", "empresa actual", "entreprise actuelle", "aktueller arbeitgeber"], profileKeys: ["currentCompany", "currentEmployer"] },
  { keys: ["current title", "current designation", "current role", "current position", "cargo actual", "poste actuel", "aktuelle position"], profileKeys: ["currentTitle", "currentRole"] },
  { keys: ["total experience", "years of experience", "work experience", "experiencia total", "expérience totale", "berufserfahrung"], profileKeys: ["totalExperience", "yearsOfExperience"] },
  { keys: ["referral", "referred by", "how did you hear", "referencia", "référence", "empfehlung"], profileKeys: ["referral", "referredBy", "sourceOfApplication"] } ];


// --- Choice-based fields (radio groups, selects, date pickers) --------
// Everything above only ever fills plain text/textarea inputs. Gender,
// date of birth, work-authorization, and similar questions are almost
// always a radio group or a <select>, which need option-matching instead
// of a straight value write - handled separately so the two paths never
// collide or double-fill the same field.
const GROUP_CONTEXT_RULES = [
  { keys: ["gender", "sex", "género", "sexo", "genre", "sexe", "geschlecht"], profileKeys: ["gender", "sex"] },
  { keys: ["date of birth", "dob", "birth date", "birthdate", "fecha de nacimiento", "date de naissance", "geburtsdatum"], profileKeys: ["dateOfBirth", "dob"], isDate: true },
  { keys: ["work authorization", "authorized to work", "legally authorized", "autorización de trabajo", "autorisation de travail", "arbeitserlaubnis"], profileKeys: ["workAuthorization"] },
  { keys: ["require sponsorship", "visa sponsorship", "need sponsorship", "need visa", "requiere patrocinio", "besoin de parrainage", "sponsoring"], profileKeys: ["requiresSponsorship", "needsSponsorship"] },
  { keys: ["willing to relocate", "open to relocation", "relocate", "dispuesto a reubicarse", "prêt à déménager", "umzugsbereit"], profileKeys: ["willingToRelocate"] },
  { keys: ["remote", "work from home", "hybrid", "remoto", "teletravail", "homeoffice"], profileKeys: ["remotePreference", "workLocationPreference"] },
  { keys: ["employment type", "job type", "tipo de empleo", "type d'emploi", "beschäftigungsart"], profileKeys: ["employmentType"] }
];


function normalizeOption(text) {
  return (text || "").toLowerCase().trim();
}

// A radio/select "question" almost never lives on the input itself the
// way a text field's label does - it's usually a fieldset legend or a
// preceding heading/paragraph in the surrounding container.
function groupContextText(el) {
  const fieldset = el.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend && legend.innerText) return legend.innerText.trim().slice(0, 100);
  }
  const container = el.closest("[role=radiogroup], div");
  if (container) {
    const heading = container.querySelector("label, legend, h1, h2, h3, h4, p, span");
    if (heading && heading.innerText && heading.innerText.trim().length < 100) return heading.innerText.trim();
  }
  return labelFor(el);
}

function toISODate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // DD-MM-YYYY or DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// Mirrors background.js's CONSENT_KEYWORDS (kept as a separate local copy
// since this file runs injected into the page's own execution world and
// has no access to background.js's module scope). Consent/terms/privacy
// checkboxes are deliberately left unchecked here even when a boolean
// profile value would otherwise match - agreeing to terms is a decision
// the LLM (or the human, via the pause-before-submit flow) should make
// with visibility into what's actually being agreed to, never something
// silently auto-checked by a keyword-matching heuristic.
const CHECKBOX_CONSENT_KEYWORDS = ["agree", "terms", "consent", "privacy policy", "accept", "acknowledge"];

// True/false-style checkbox profile values arrive in all sorts of shapes
// depending on how the profile was authored (a real boolean, "yes"/"no",
// "true"/"false", even "1"/"0") - this normalizes any of them into a
// clear tri-state signal instead of just checking truthiness, so a
// literal false/"no" is distinguishable from "we have no opinion, leave
// it as the page defaults it".
function coerceBooleanIntent(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeOption(String(value ?? ""));
  if (["yes", "true", "y", "1"].includes(normalized)) return true;
  if (["no", "false", "n", "0"].includes(normalized)) return false;
  return null;
}

async function smartAutofillChoices(profileData) {
  let filledCount = 0; let checkedCount2 = 0;

  // Standalone checkboxes (not part of a radio group) that map to a
  // boolean profile field - e.g. "willing to relocate", "open to remote
  // work". Every consent/terms/privacy-style checkbox is explicitly
  // skipped (see CHECKBOX_CONSENT_KEYWORDS) and left for the LLM/human
  // path, same as before this function existed.
  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
  for (const checkbox of checkboxes) {
    if (!isVisible(checkbox) || checkbox.disabled || checkbox.checked) continue;
    const context = `${groupContextText(checkbox)} ${checkbox.name || ""}`.toLowerCase();
    if (CHECKBOX_CONSENT_KEYWORDS.some((k) => context.includes(k))) continue;
    const rule = GROUP_CONTEXT_RULES.find((r) => !r.isDate && r.keys.some((k) => context.includes(k)));
    if (!rule) continue;
    const rawValue = findProfileValue(profileData, rule.profileKeys);
    if (rawValue === null) continue;
    const intent = coerceBooleanIntent(rawValue);
    // Only ever check the box - never programmatically uncheck one, since
    // an unchecked box is indistinguishable from "not yet considered" and
    // false-positive-unchecking a box the page or user already set is a
    // much worse failure mode than leaving a true-intent box unchecked
    // for the LLM to pick up a round later.
    if (intent === true) {
      checkbox.click();
      checkbox.setAttribute(FILLED_ATTR, "true");
      filledCount++;
    }
  }

  // Radio groups (gender, yes/no work-authorization, etc.)
  const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
  const seenGroups = new Set();
  for (const radio of radios) {
    if (!isVisible(radio) || radio.disabled) continue;
    const groupName = radio.name;
    if (!groupName || seenGroups.has(groupName)) continue;
    const groupRadios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`));
    if (groupRadios.some((r) => r.checked)) {
      seenGroups.add(groupName);
      continue; // already answered - never override a human/prior choice
    }

    const context = `${groupContextText(radio)} ${groupName}`.toLowerCase();
    const rule = GROUP_CONTEXT_RULES.find((r) => !r.isDate && r.keys.some((k) => context.includes(k)));
    if (!rule) continue;
    const value = findProfileValue(profileData, rule.profileKeys);
    if (!value) continue;
    const target = groupRadios.find((r) => {
      const optionText = normalizeOption(labelFor(r) || r.value);
      return optionText === normalizeOption(value) || optionText.startsWith(normalizeOption(value));
    });
    if (target) {
      target.click();
      target.setAttribute(FILLED_ATTR, "true");
      filledCount++;
    }
    seenGroups.add(groupName);
  }

  // Selects (dropdowns) - gender/work-authorization/etc where option text
  // should match a profile value, as opposed to free-text FIELD_RULES.
  const selects = Array.from(document.querySelectorAll("select"));
  for (const select of selects) {
    if (!isVisible(select) || select.disabled || select.value) continue;
    const context = `${labelFor(select)} ${select.name || ""}`.toLowerCase();
    const rule = GROUP_CONTEXT_RULES.find((r) => !r.isDate && r.keys.some((k) => context.includes(k)));
    if (!rule) continue;
    const value = findProfileValue(profileData, rule.profileKeys);
    if (!value) continue;
    const option = Array.from(select.options).find((o) => normalizeOption(o.text).includes(normalizeOption(value)));
    if (option) {
      select.focus();
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      select.setAttribute(FILLED_ATTR, "true");
      filledCount++;
    }
  }

  // Native date inputs (date of birth)
  const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
  for (const el of dateInputs) {
    if (!isVisible(el) || el.disabled || el.value) continue;
    const context = `${labelFor(el)} ${el.name || ""}`.toLowerCase();
    const rule = GROUP_CONTEXT_RULES.find((r) => r.isDate && r.keys.some((k) => context.includes(k)));
    if (!rule) continue;
    const iso = toISODate(findProfileValue(profileData, rule.profileKeys));
    if (iso) {
      el.focus();
      setNativeValue(el, iso);
      el.setAttribute(FILLED_ATTR, "true");
      filledCount++;
    }
  }

  return filledCount;
}

function findProfileValue(profileData, profileKeys) {
  for (const key of profileKeys) {
    const raw = profileData[key];
    if (raw === undefined || raw === null || raw === "") continue;
    // Real bug found from a user report: blindly doing String(raw) here
    // meant that if a profile field like "linkedin" or "github" was ever
    // stored as an object (e.g. {url: "...", verified: true} rather than
    // a plain string - a genuinely easy mistake when profile data comes
    // from various sources/imports), String({}) produces the literal text
    // "[object Object]", which then got written straight into the
    // LinkedIn/GitHub URL fields as if it were a real, resolved value.
    // Try the shapes an accidentally-nested URL value most plausibly
    // takes before falling back to treating it as unusable - never
    // stringify a bare object and hand back the "[object Object]" text.
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const nestedValue = raw.url ?? raw.value ?? raw.link ?? raw.href;
      if (typeof nestedValue === "string" && nestedValue) return nestedValue;
      continue; // no sensible string found - fall through to the LLM rather than injecting garbage
    }
    if (typeof raw === "object") continue; // an array or other non-primitive - same reasoning as above
    return String(raw);
  }
  for (const nestedKey of ["structuredProfile", "completeProfile", "learned"]) {
    const nested = profileData[nestedKey];
    if (nested && typeof nested === "object") {
      const value = findProfileValue(nested, profileKeys);
      if (value) return value;
    }
  }
  return null;
}

function learningKey(el) {
  const label = labelFor(el) || el.name || el.id || "field";
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "field";
}

let learningTimer;
document.addEventListener("change", (event) => {
  const el = event.target;
  if (agentWriteInProgress || !el || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
  if (["checkbox", "radio", "file", "hidden", "password"].includes((el.type || "").toLowerCase())) return;
  const value = String(el.value || "").trim();
  if (!value || value.length > 5000) return;
  clearTimeout(learningTimer);
  learningTimer = setTimeout(() => {
    try {
      chrome.runtime.sendMessage({
        type: "USER_FIELD_VALUE",
        candidate: { key: learningKey(el), label: labelFor(el) || el.name || "Field", value }
      }).catch(() => {});
    } catch (e) {
      // Ignore extension context invalidated errors from orphaned content scripts
    }
  }, 250);
}, true);

// --- Standardized autofill hints (Phase 10) ----------------------------
// autocomplete tokens are the browser's own standardized field-identity
// hint (WHATWG HTML spec) - unlike a label, they're unambiguous and don't
// need fuzzy keyword matching at all. Checked before FIELD_RULES since a
// real autocomplete token is more trustworthy than any label-text guess.
// Compound values like "shipping given-name" put the actual field name
// last, so only the final token is used.
const AUTOCOMPLETE_PROFILE_MAP = {
  "given-name": ["firstName", "first_name"],
  "additional-name": ["middleName", "middle_name"],
  "family-name": ["lastName", "last_name"],
  name: ["name", "fullName"],
  nickname: ["preferredName", "nickname"],
  email: ["email"],
  tel: ["phone", "phoneNumber"],
  "tel-national": ["phone", "phoneNumber"],
  url: ["portfolio", "portfolioUrl", "website"],
  "street-address": ["address", "addressLine1"],
  "address-line1": ["address", "addressLine1"],
  "address-level2": ["city"],
  "address-level1": ["state", "region"],
  country: ["country"],
  "country-name": ["country"],
  "postal-code": ["postalCode", "zipCode", "pincode"],
  bday: ["dateOfBirth", "dob"],
  organization: ["currentCompany", "currentEmployer"],
  "organization-title": ["currentTitle", "currentRole"]
};

// Last-resort fallback when neither autocomplete nor any label/name keyword
// matched anything - the input's own semantic HTML type is still a real,
// if weaker, signal (type="email" is virtually always an email address).
// Deliberately small and conservative - only types with one obvious,
// low-risk profile mapping are included.
const INPUT_TYPE_PROFILE_MAP = {
  email: ["email"],
  tel: ["phone", "phoneNumber"],
  url: ["portfolio", "portfolioUrl", "website"]
};

function autocompleteToken(el) {
  const raw = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
  if (!raw || raw === "off" || raw === "on") return "";
  return raw.split(/\s+/).pop();
}

async function smartAutofill(profileData) {
  if (!profileData || typeof profileData !== "object") return { filledCount: 0 };

  const selector = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=password]), textarea";
  const nodes = Array.from(document.querySelectorAll(selector));
  let filledCount = 0;
  let checkedCount = 0;

  for (const el of nodes) {
    if (++checkedCount % 20 === 0) await new Promise(r => setTimeout(r, 0));
    if (!isVisible(el) || el.disabled) continue;
    if (el.value && el.value.trim()) continue; // don't overwrite existing input

    let matched = false;

    const token = autocompleteToken(el);
    const autocompleteKeys = token && AUTOCOMPLETE_PROFILE_MAP[token];
    if (autocompleteKeys) {
      const value = findProfileValue(profileData, autocompleteKeys);
      if (value) {
        el.focus();
        setNativeValue(el, value);
        el.setAttribute(FILLED_ATTR, "true");
        filledCount++;
      }
      matched = true; // an explicit autocomplete hint is authoritative either way - never let a label-keyword guess override or double-fill it
    }

    if (!matched) {
      const haystack = `${labelFor(el)} ${el.name || ""} ${el.id || ""}`.toLowerCase();
      for (const rule of FIELD_RULES) {
        if (rule.keys.some((k) => haystack.includes(k))) {
          const value = findProfileValue(profileData, rule.profileKeys);
          if (value) {
            el.focus();
            setNativeValue(el, value);
            el.setAttribute(FILLED_ATTR, "true");
            filledCount++;
          }
          matched = true;
          break; // first matching rule wins, don't double-fill
        }
      }
    }

    if (!matched) {
      const inputType = (el.getAttribute("type") || "").toLowerCase();
      const typeKeys = INPUT_TYPE_PROFILE_MAP[inputType];
      if (typeKeys) {
        const value = findProfileValue(profileData, typeKeys);
        if (value) {
          el.focus();
          setNativeValue(el, value);
          el.setAttribute(FILLED_ATTR, "true");
          filledCount++;
        }
      }
    }
  }

  filledCount += await smartAutofillChoices(profileData);

  return { filledCount };
}
