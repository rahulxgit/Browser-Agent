// SAP SuccessFactors adapter (Phase 29). Best-effort from SuccessFactors'
// known public posting markup conventions, NOT verified against a live
// board in this session - same honesty caveat as every sibling adapter
// in this directory. Added to close a named gap alongside smartrecruiters.js
// (see that file's comment for the reasoning).
(function () {
  const successFactorsAdapter = {
    id: "successfactors",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "successfactors.com") || HostUtils.isHost(pageContext.hostname, "successfactors.eu")) return true;
      return !!document.querySelector("[id*='successfactors'], .jobsFor, #jobReqId");
    },

    extractJobContext() {
      const title = document.querySelector("h1[class*='job'], .job-title, h1")?.innerText?.trim();
      const location = document.querySelector("[class*='job-location'], .location")?.innerText?.trim();
      const description = document
        .querySelector("[class*='job-description'], #jobDescription, .jobDescriptionContent")
        ?.innerText?.replace(/\s+/g, " ")
        .trim();
      if (!title && !location && !description) return null;
      return [title && `Title: ${title}`, location && `Location: ${location}`, description && description.slice(0, 4000)]
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
  self.__AGENT_ADAPTERS.push(successFactorsAdapter);
})();
