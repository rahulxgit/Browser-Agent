// SmartRecruiters adapter (Phase 29). Best-effort from SmartRecruiters'
// known public posting markup conventions, NOT verified against a live
// board in this session - same honesty caveat as every sibling adapter
// in this directory. Added to close a named gap: the platform list this
// codebase was asked to support explicitly named SmartRecruiters, and it
// previously had no adapter at all (falling through to generic, which
// still works, just without the job-context extraction a real board
// would otherwise get).
(function () {
  const smartRecruitersAdapter = {
    id: "smartrecruiters",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "smartrecruiters.com")) return true;
      return !!document.querySelector("[class*='smartrecruiters'], #job, .job-sections");
    },

    extractJobContext() {
      const title = document.querySelector("h1[class*='job-title'], .job-title h1, h1")?.innerText?.trim();
      const company = document.querySelector("[class*='company-name'], .company-name")?.innerText?.trim();
      const description = document
        .querySelector(".job-sections, [class*='job-description'], #job-description")
        ?.innerText?.replace(/\s+/g, " ")
        .trim();
      if (!title && !company && !description) return null;
      return [title && `Title: ${title}`, company && `Company: ${company}`, description && description.slice(0, 4000)]
        .filter(Boolean)
        .join("\n");
    },

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
  self.__AGENT_ADAPTERS.push(smartRecruitersAdapter);
})();
