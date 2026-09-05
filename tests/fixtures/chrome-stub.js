// content.js is written to run as a real Chrome extension content script,
// where `chrome` is always defined. A plain Playwright page (loaded via
// page.setContent + page.addScriptTag, not a real loaded extension) has no
// `chrome` global at all - without this stub, content.js's top-level
// `chrome.runtime.onMessage.addListener(...)` call throws immediately on
// injection, before any fixture test code gets a chance to run anything.
//
// This is intentionally minimal - just enough surface area for content.js
// to finish loading and for the specific functions these fixtures call
// directly (getPageSnapshot, runSingleAction, smartAutofill) to work.
// It does NOT simulate real message passing to a background script; tests
// that need that would need the full "load as a real unpacked extension
// via launchPersistentContext" approach instead, which is a bigger lift
// than this stub and out of scope for what's scaffolded so far.
function installChromeStub() {
  window.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve({ ok: true })
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      }
    }
  };
}

async function injectAgentScripts(page) {
  const path = require("path");
  const scripts = [
    "src/lib/host-utils.js",
    "src/adapters/generic.js",
    "src/adapters/greenhouse.js",
    "src/adapters/lever.js",
    "src/adapters/workday.js",
    "src/adapters/icims.js",
    "src/adapters/taleo.js",
    "src/adapters/ashby.js",
    "src/lib/dom-helpers.js",
    "src/lib/field-detection.js",
    "src/content.js"
  ];
  for (const scriptPath of scripts) {
    await page.addScriptTag({ path: path.join(__dirname, "..", "..", scriptPath) });
  }
}

module.exports = { installChromeStub, injectAgentScripts };
