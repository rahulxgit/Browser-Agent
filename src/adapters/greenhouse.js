// Greenhouse adapter (Phase 12). Fingerprint and selectors are best-effort
// from Greenhouse's known public markup conventions, NOT verified against
// a live board in this session (no browser available here) - treat the
// extractJobContext selectors as a reasonable starting point to confirm
// against a real Greenhouse posting, not a guarantee.
(function () {
  const greenhouseAdapter = {
    id: "greenhouse",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "greenhouse.io")) return true;
      return !!document.querySelector("#grnhse_app, [class*='greenhouse'], #application_form");
    },

    extractJobContext() {
      const title = document.querySelector("h1.app-title, h1[class*='job-title'], .job__title h1, #header h1")?.innerText?.trim();
      const company =
        document.querySelector("header img[alt]")?.getAttribute("alt") ||
        document.querySelector(".company-name, [class*='company-name']")?.innerText?.trim();
      const description = document
        .querySelector("#content, .job__description, [class*='job-description']")
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
  self.__AGENT_ADAPTERS.push(greenhouseAdapter);
})();
