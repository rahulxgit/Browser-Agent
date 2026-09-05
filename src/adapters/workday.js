// Workday adapter (Phase 12). Fingerprint uses Workday's well-known
// data-automation-id attribute convention, present on virtually every
// interactive element in a Workday career site - a strong, low-risk
// signal even without knowing the exact page structure. extractJobContext
// selectors are best-effort and NOT verified against a live Workday
// deployment in this session.
//
// A Workday application form embedded via <iframe> IS reachable: this
// adapter's own files are injected into every frame of the tab, not just
// the top one (background.js's ensureContentScript uses allFrames: true
// specifically so a Workday iframe gets its own independent copy of this
// adapter, matching against that frame's own location.hostname). An
// earlier version of this comment claimed otherwise - that was true only
// before allFrames injection existed and is corrected here so it doesn't
// mislead a future reader into re-solving an already-solved problem.
(function () {
  const workdayAdapter = {
    id: "workday",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "myworkdayjobs.com")) return true;
      return !!document.querySelector("[data-automation-id]");
    },

    extractJobContext() {
      const title = document.querySelector("[data-automation-id='jobPostingHeader']")?.innerText?.trim();
      const location = document.querySelector("[data-automation-id='locations']")?.innerText?.trim();
      const description = document.querySelector("[data-automation-id='jobPostingDescription']")?.innerText?.replace(/\s+/g, " ").trim();
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
  self.__AGENT_ADAPTERS.push(workdayAdapter);
})();
