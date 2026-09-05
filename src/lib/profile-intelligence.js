// --- Job description + profile intelligence (Phases 13-14), extracted
// from background.js (Phase 21) --------------------------------------
// Loaded via importScripts() into background.js's global scope - see the
// comment at the top of lib/providers.js for why that's the correct,
// zero-call-site-change way to split a classic (non-module) MV3 service
// worker. Pure functions only, no dependency on run-loop state.

// --- Job description intelligence (Phase 14) ----------------------------
// extractJobContext() (content.js) already hands over a raw text blob -
// useful as grounding for the LLM, but forces it to re-derive the same
// handful of structured facts (remote policy, employment type, years of
// experience, salary range) from scratch every single round. Regex-based,
// deliberately conservative: every field is either a clean, unambiguous
// pattern match or explicitly left out entirely - "never invent facts"
// means a field that isn't confidently detected is omitted, not guessed.
// Sponsorship/work-authorization are treated differently on purpose: those
// sentences directly affect what an applicant should be told, so instead
// of collapsing them to a guessed true/false, the actual sentence they
// came from is quoted verbatim and left for the model (and ultimately the
// person) to interpret in context.
function parseJobContext(rawText, adapterHints = "") {
  const text = `${adapterHints}\n${rawText || ""}`;
  if (!text.trim()) return null;

  const result = {};

  const titleLine = text.match(/^Title:\s*(.+)$/m);
  if (titleLine) result.title = titleLine[1].trim().slice(0, 120);
  const companyLine = text.match(/^Company:\s*(.+)$/m);
  if (companyLine) result.company = companyLine[1].trim().slice(0, 120);
  const locationLine = text.match(/^Location:\s*(.+)$/m);
  if (locationLine) result.location = locationLine[1].trim().slice(0, 120);

  if (/\bremote\b/i.test(text)) result.remotePolicy = "remote";
  else if (/\bhybrid\b/i.test(text)) result.remotePolicy = "hybrid";
  else if (/\bon[\s-]?site\b|\bin[\s-]?office\b/i.test(text)) result.remotePolicy = "on-site";

  if (/\bfull[\s-]?time\b/i.test(text)) result.employmentType = "full-time";
  else if (/\bpart[\s-]?time\b/i.test(text)) result.employmentType = "part-time";
  else if (/\binternship\b/i.test(text)) result.employmentType = "internship";
  else if (/\bcontract(or)?\b/i.test(text)) result.employmentType = "contract";
  else if (/\btemporary\b/i.test(text)) result.employmentType = "temporary";

  const experienceMatch = text.match(/(\d+)\s*(?:\+|to|-)\s*(\d+)?\+?\s*years?/i);
  if (experienceMatch) {
    result.experience = experienceMatch[2] ? `${experienceMatch[1]}-${experienceMatch[2]} years` : `${experienceMatch[1]}+ years`;
  }

  const salaryMatch = text.match(/[$£₹€]\s?[\d][\d,]*(?:\.\d+)?(?:\s?-\s?[$£₹€]?\s?[\d][\d,]*(?:\.\d+)?)?(?:\s?\/?\s?(?:year|yr|hour|hr|annum|month))?/i);
  if (salaryMatch) result.salary = salaryMatch[0].trim().slice(0, 60);

  // Sponsorship/work-authorization: quote the actual sentence, don't
  // classify it. One bad regex classification of "does/doesn't sponsor"
  // would be an invented fact; a verbatim quote never is.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const sponsorshipSentence = sentences.find((s) => /sponsor/i.test(s));
  if (sponsorshipSentence) result.sponsorshipNote = sponsorshipSentence.trim().slice(0, 240);
  const workAuthSentence = sentences.find((s) => /(work authorization|authorized to work|eligible to work|visa)/i.test(s));
  if (workAuthSentence) result.workAuthorizationNote = workAuthSentence.trim().slice(0, 240);

  // Deliberately no "skills" extraction here - a keyword list good enough
  // to avoid false positives across arbitrary job postings doesn't exist
  // without an LLM call, and a bad one actively invents facts. The full
  // raw text is still passed through separately for the model to read
  // directly, which is the safer place for that particular judgment.

  return Object.keys(result).length ? result : null;
}

// --- Profile intelligence (Phase 13) -------------------------------------
// buildMergedProfile() below merges complete/learned/structured profile
// data as a flat object spread - last writer wins silently, with no record
// of which source a value actually came from or whether two sources
// disagree. Fine when a value only ever exists in one place; not fine per
// the doc's explicit instruction: "If two sources contradict each other,
// do not silently choose one when the difference matters - ask the user."
// resolveProfileFields() is what actually detects those contradictions
// rather than letting object-spread precedence quietly paper over them.
const PROFILE_FIELD_ALIASES = {
  firstName: ["firstname", "first_name", "fname", "givenname"],
  lastName: ["lastname", "last_name", "lname", "familyname", "surname"],
  email: ["email", "emailaddress", "email_address", "contactemail"],
  phone: ["phone", "phonenumber", "phone_number", "mobile", "mobilenumber", "contactnumber"],
  city: ["city", "town"],
  country: ["country", "nationality", "countryofresidence"],
  currentCompany: ["currentcompany", "currentemployer", "employer", "company"],
  currentTitle: ["currenttitle", "currentrole", "jobtitle", "title"]
};

function findAliasedValue(source, aliases) {
  if (!source || typeof source !== "object") return undefined;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === "") continue;
    if (aliases.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

// Confidence is a fixed weight per source tier, not derived from anything
// dynamic - a value the person typed directly into their own structured
// profile is simply more trustworthy than the bundled example dataset or
// something auto-captured from a previous run's learned-answer flow.
const SOURCE_CONFIDENCE = { profile: 0.98, learned: 0.75, complete: 0.5 };

function resolveProfileFields({ structured, learned, complete }) {
  const resolved = {};
  for (const [normalizedKey, aliases] of Object.entries(PROFILE_FIELD_ALIASES)) {
    const candidates = [
      { source: "profile", value: findAliasedValue(structured, aliases) },
      { source: "learned", value: findAliasedValue(learned, aliases) },
      { source: "complete", value: findAliasedValue(complete, aliases) }
    ].filter((c) => c.value !== undefined);

    if (candidates.length === 0) continue;

    // Values that only differ by case/surrounding whitespace aren't a
    // real contradiction ("India" vs "india ") - normalize before
    // comparing so trivial formatting differences don't trigger a false
    // "ask the user" for something that was never actually in conflict.
    const normalize = (v) => String(v).trim().toLowerCase();
    const distinctValues = new Set(candidates.map((c) => normalize(c.value)));
    const contradicts = distinctValues.size > 1;

    // Highest-confidence source wins as the tentative value even when
    // there's a contradiction - the model still needs something to work
    // with this round - but contradicts:true is what tells the system
    // prompt to treat it as unconfirmed rather than settled fact.
    const best = candidates.reduce((a, b) => (SOURCE_CONFIDENCE[a.source] >= SOURCE_CONFIDENCE[b.source] ? a : b));

    resolved[normalizedKey] = {
      value: best.value,
      source: best.source,
      confidence: SOURCE_CONFIDENCE[best.source],
      contradicts,
      allValues: contradicts ? candidates : undefined
    };
  }
  return resolved;
}
