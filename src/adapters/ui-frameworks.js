// UI Frameworks adapter (Phase 13). Provides native support for popular
// custom combobox/dropdown implementations like Material UI, Ant Design,
// and Select2. These frameworks often hide the native <select> (or don't
// use one at all) and render an interactive <div> that needs a specific
// click sequence to open, type a search, and select an option.
(function () {
  const uiAdapter = {
    id: "ui-frameworks",

    matches() {
      // Always matches - this adapter acts globally as a progressive
      // enhancement on top of the generic logic. If a specific UI component
      // isn't found, it simply returns null and lets other adapters
      // or the generic fallback handle it.
      return true;
    },

    normalizeField(el, entry) {
      const idOrClass = `${el.id || ""} ${el.className || ""}`;
      
      // Material UI Select
      if (idOrClass.includes("MuiSelect-select") || idOrClass.includes("MuiInputBase-root")) {
        // If it's a combobox, tag it as one
        if (el.getAttribute("role") === "combobox" || el.getAttribute("role") === "button") {
          entry.isCombobox = true;
          return entry;
        }
      }
      
      // Ant Design Select
      if (idOrClass.includes("ant-select-selector")) {
        entry.isCombobox = true;
        return entry;
      }
      
      // Select2
      if (idOrClass.includes("select2-selection")) {
        entry.isCombobox = true;
        return entry;
      }
      
      return null;
    },

    executeSpecialControl(type, el, action) {
      if (type !== "select") return null;
      
      const idOrClass = `${el.id || ""} ${el.className || ""}`;
      const isMui = idOrClass.includes("MuiSelect-select") || idOrClass.includes("MuiInputBase-root");
      const isAntd = idOrClass.includes("ant-select-selector");
      const isSelect2 = idOrClass.includes("select2-selection");
      
      if (!isMui && !isAntd && !isSelect2) return null;
      
      // We implement a custom execution sequence for these known frameworks
      return new Promise((resolve) => {
        el.scrollIntoView({ block: "center" });
        el.click();
        
        // Wait for the overlay to render
        setTimeout(() => {
          // If we have an option text we want to select
          const targetValue = String(action.value || "").toLowerCase().trim();
          if (!targetValue) {
            resolve({ ok: false, error: "No value provided to select" });
            return;
          }
          
          // These frameworks typically append their dropdowns to the document body
          // We look for all options currently visible on the page
          const options = Array.from(document.querySelectorAll('[role="option"], li, .ant-select-item-option'));
          const targetOption = options.find(opt => {
             if (!opt.innerText) return false;
             // Must be visible
             const rect = opt.getBoundingClientRect();
             if (rect.width === 0 || rect.height === 0) return false;
             const style = window.getComputedStyle(opt);
             if (style.visibility === "hidden" || style.display === "none") return false;
             
             return opt.innerText.toLowerCase().trim().includes(targetValue);
          });
          
          if (targetOption) {
            targetOption.click();
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `Could not find option matching: ${targetValue}` });
          }
        }, 300);
      });
    },

    verifyAction() {
      // Let the generic verifier run since we updated the DOM normally
      return null;
    }
  };

  self.__AGENT_ADAPTERS = self.__AGENT_ADAPTERS || [];
  self.__AGENT_ADAPTERS.unshift(uiAdapter); // Add to front so it gets priority
})();
