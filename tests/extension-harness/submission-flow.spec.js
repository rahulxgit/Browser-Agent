// UNVERIFIED - written but not executed in this session (no Chromium
// binary available in this sandbox - see tests/fixtures/README.md for the
// same caveat on the earlier, simpler scaffold). This file is the
// corrected tool for the job, though: it loads the REAL unpacked
// extension via a persistent context, so background.js <-> content.js
// message-passing, chrome.storage, and the real MV3 service worker are
// all genuinely present - none of that was reachable from the earlier
// addScriptTag-into-a-plain-page approach, which is exactly why the
// submission-flow scenarios were left out of that scaffold.
const { test, expect } = require("@playwright/test");
const { launchWithExtension } = require("./load-extension");
const { startFixtureServer } = require("./fixture-server");

test.describe("submission confirmation flow (extension harness)", () => {
  let context, serviceWorker, extensionId, server, baseUrl;

  test.beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer());
    ({ context, serviceWorker, extensionId } = await launchWithExtension());

    // Seed profile data and settings directly into chrome.storage - this
    // bypasses the options-page UI on purpose, since this test is about
    // the run/submission flow, not settings-page form-filling (that's a
    // separate, much simpler concern this harness doesn't need to
    // re-verify here).
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        provider: "gemini",
        profileData: JSON.stringify({ firstName: "Test", lastName: "User", email: "test@example.com" }),
        pauseBeforeSubmit: true,
      });
      if (chrome.storage.session) {
        await chrome.storage.session.set({ apiKey: "test-key-not-actually-called" });
      } else {
        await chrome.storage.local.set({ apiKey: "test-key-not-actually-called" });
      }
    });

    // Stub the LLM call entirely rather than hitting a real provider (no
    // reliable network/API key in this sandbox, and a deterministic
    // scripted response is what makes this test reproducible anyway).
    // callModel is a plain function declaration loaded via importScripts
    // into this same service worker's global scope (Phase 21) -
    // reassigning self.callModel overrides it for every future call,
    // since runTaskInner calls it as a bare identifier resolved at call
    // time, not a reference captured at import time.
    await serviceWorker.evaluate(() => {
      self.callModel = async (settings, systemPrompt, userMessage) => {
        console.log("Mock callModel invoked!");
        const { elements } = JSON.parse(userMessage);
        const findUnfilled = (name) => elements.find((e) => e.name === name && !e.filled);

        const fills = [];
        for (const name of ["firstName", "lastName", "email"]) {
          const el = findUnfilled(name);
          if (el)
            fills.push({
              type: "fill",
              targetId: el.id,
              value: name === "email" ? "test@example.com" : "Test",
              reasoning: "test",
            });
        }
        if (fills.length) return JSON.stringify(fills);

        // Nothing left to fill (heuristic autofill or a previous round
        // may have already handled it) - click the submit button. This
        // deliberately reads the REAL current snapshot rather than
        // hardcoding a targetId, since data-agent-id assignment order
        // isn't something a test should need to hardcode against.
        const submitBtn = elements.find((e) => (e.text || e.label || "").includes("Submit Application"));
        if (submitBtn) return JSON.stringify([{ type: "click", targetId: submitBtn.id, reasoning: "submit" }]);

        return JSON.stringify([{ type: "done", reasoning: "nothing left to do" }]);
      };
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("autofill -> preflight pause -> confirm -> real submit -> verified outcome", async () => {
    // The real fixture form, served over real HTTP - not a data: page,
    // specifically so the eventual submit navigation and the resulting
    // URL/body-text check in getSubmissionOutcome() are testing real
    // browser navigation semantics, not a simulation of them.
    const formPage = await context.newPage();
    await formPage.goto(`${baseUrl}/apply`);

    // Drive the actual popup UI, not a direct background message - this
    // is what makes the test "real": the same click a person would make.
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup.html`);

    // RUN_TASK resolves its target via chrome.tabs.query({active:true}) -
    // opening popup.html with context.newPage() makes it a REAL tab
    // (unlike a genuine popup-icon click, which never steals tab
    // activity), so without this it could itself become the "active"
    // tab and RUN_TASK would run against the popup page instead of the
    // form. Playwright can still dispatch clicks on popupPage regardless
    // of which page has OS-level focus, so this doesn't block anything
    // that follows.
    await formPage.bringToFront();
    await formPage.evaluate(() => console.log("FORM PAGE URL: " + location.href));
    await popupPage.evaluate(() => console.log("POPUP PAGE URL: " + location.href));

    await popupPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log("ACTIVE TAB URL: " + (tabs[0] ? tabs[0].url : "NONE"));
      document.getElementById("autofillBtn").click();
    });

    // The confirm button only appears once background.js's
    // isLikelySubmitAction (Phase 7) has paused on the "Submit
    // Application" click and broadcast TASK_PAUSED, which showPauseBanner
    // (Phase 20) renders by unhiding #pauseBanner - waiting for it here is
    // the real assertion that the multi-layer submit-safety pause
    // actually fired, not just that *some* click happened.
    await expect(popupPage.locator("#confirmBtn")).toBeVisible({ timeout: 15000 });
    await popupPage.locator("#confirmBtn").click();

    await formPage.waitForURL(/\/apply\/success/, { timeout: 15000 });

    await expect(popupPage.locator("#statusBadge")).toHaveText("Submitted", { timeout: 15000 });
  });
});
