// Ashby adapter (Phase 12) - the one adapter in this set backed by direct
// evidence rather than guesswork: the "remix-css-*" class prefix and
// aria-labelledby-driven combobox markup came straight from the Record-
// mode log that led to the toggle-button stagnation fix earlier in this
// project. That fix (looksLikeComboboxToggleLabel/findPairedCombobox in
// content.js) was deliberately kept GENERIC rather than moved in here,
// since nothing about "a chevron button paired with a role=combobox" is
// actually Ashby-specific - other ATSs use the same pattern. This adapter
// only covers what's genuinely specific to Ashby: recognizing the site at
// all, and pulling structured job context out of its known markup.
(function () {
  const ashbyAdapter = {
    id: "ashby",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "ashbyhq.com")) return true;
      return !!document.querySelector('[class*="remix-css-"]') && !!document.querySelector('[role="combobox"]');
    },

    // Best-effort - Ashby job postings commonly render the role title as
    // the page's <h1> and the company name in a header/brand element.
    // Returns null (not "") when nothing matches, so content.js's caller
    // knows to fall back to its own generic selector-based extraction
    // rather than treating an empty string as "confirmed nothing here."
    extractJobContext() {
      const title = document.querySelector("h1")?.innerText?.trim();
      const company = document.querySelector('[class*="company-name"], header [class*="brand"]')?.innerText?.trim();
      const description = document.querySelector('[class*="job-posting"], [class*="posting-body"], main')?.innerText
        ?.replace(/\s+/g, " ")
        .trim();
      if (!title && !company && !description) return null;
      return [title && `Title: ${title}`, company && `Company: ${company}`, description && description.slice(0, 4000)]
        .filter(Boolean)
        .join("\n");
    },

    // No Ashby-specific field/control/verification quirks confirmed beyond
    // the already-generic toggle-button handling - explicit no-ops here
    // rather than omitting the hooks, so the interface shape stays visible.
    normalizeField() {
      return null;
    },
    executeSpecialControl() {
      return null;
    },
    verifyAction() {
      return null;
    }
  };

  self.__AGENT_ADAPTERS = self.__AGENT_ADAPTERS || [];
  self.__AGENT_ADAPTERS.push(ashbyAdapter);
})();
