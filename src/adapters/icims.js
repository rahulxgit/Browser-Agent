// iCIMS adapter (Phase 12). Best-effort from iCIMS's known public posting
// markup conventions, NOT verified against a live board in this session.
(function () {
  const icimsAdapter = {
    id: "icims",

    matches(pageContext) {
      if (HostUtils.isHost(pageContext.hostname, "icims.com")) return true;
      return !!document.querySelector("#iCIMS_JobHeader, [class*='iCIMS_']");
    },

    extractJobContext() {
      const title = document.querySelector("#iCIMS_JobHeaderText, [class*='iCIMS_Header_Text']")?.innerText?.trim();
      const description = document.querySelector("#iCIMS_JobContent, [class*='iCIMS_InfoMsg_Job']")?.innerText?.replace(/\s+/g, " ").trim();
      if (!title && !description) return null;
      return [title && `Title: ${title}`, description && description.slice(0, 4000)].filter(Boolean).join("\n");
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
  self.__AGENT_ADAPTERS.push(icimsAdapter);
})();
