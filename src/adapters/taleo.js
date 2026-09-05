// Taleo adapter (Phase 12). Best-effort from Taleo's known public posting
// markup conventions, NOT verified against a live board in this session.
// Taleo deployments vary a lot more between customers than the other
// ATSs here (many run heavily customized skins), so matches() intentionally
// leans on the hostname pattern more than DOM fingerprinting.
(function () {
  const taleoAdapter = {
    id: "taleo",

    matches(pageContext) {
      return HostUtils.isHost(pageContext.hostname, "taleo.net");
    },

    extractJobContext() {
      const title = document.querySelector("#requisitionDescriptionInterface\\.reqTitleLinkAlt, [class*='req-title']")?.innerText?.trim();
      const description = document.querySelector("#requisitionDescriptionInterface, [class*='requisitionDescription']")?.innerText?.replace(/\s+/g, " ").trim();
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
  self.__AGENT_ADAPTERS.push(taleoAdapter);
})();
