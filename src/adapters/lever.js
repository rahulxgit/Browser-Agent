// Lever adapter (Phase 12). Best-effort from Lever's known public posting
// markup conventions, NOT verified against a live board in this session.
(function () {
  const leverAdapter = {
    id: "lever",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "lever.co")) return true;
      return !!document.querySelector(".posting-headline, .posting-category, [class*='lever-']");
    },

    extractJobContext() {
      const title = document.querySelector(".posting-headline h2, h2[class*='posting-title']")?.innerText?.trim();
      const location = document.querySelector(".posting-category .location, [class*='posting-categories'] .location")?.innerText?.trim();
      const description = document.querySelector(".posting-page, [class*='section-wrapper']")?.innerText?.replace(/\s+/g, " ").trim();
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
  self.__AGENT_ADAPTERS.push(leverAdapter);
})();
