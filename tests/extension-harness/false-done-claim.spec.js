// LIVE VERIFICATION (executed for real - Chromium is present in this
// environment, unlike the sandbox tests/fixtures/README.md and this
// directory's own README previously had to caveat). This is the one
// scenario per the project's own notes that had only ever been unit-
// tested against copy-pasted logic (hasFillableWorkCopy in
// dropdown-helpers.test.js), never exercised against a real background.js
// <-> content.js round-trip on a real DOM.
//
// Reproduces the exact failure mode from the user's real record-mode log
// (browser-agent-log-1788433649025.json, run
// run-1788345432341-a194a806-76a5-4deb-b0a0-67ef728093c2): a run that
// ended with "No interactive elements found on the page to fill out."
// while a required field was still empty. Phase 24 traced that summary to
// the model's own unverified {"type":"done"} claim being accepted without
// cross-checking the deterministic snapshot. This test proves that
// cross-check actually fires against a real page, not just a plain object
// literal handed to a copied function.
const { test, expect } = require("@playwright/test");
const { launchWithExtension } = require("./load-extension");
const { startFixtureServer } = require("./fixture-server");

test.describe("false 'done' claim cross-check (Phase 24, live extension harness)", () => {
  let context, serviceWorker, extensionId, server, baseUrl;

  test.beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer());
    ({ context, serviceWorker, extensionId } = await launchWithExtension());

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        provider: "gemini",
        profileData: JSON.stringify({ firstName: "Test", country: "India" }),
        pauseBeforeSubmit: true
      });
      if (chrome.storage.session) {
        await chrome.storage.session.set({ apiKey: "test-key-not-actually-called" });
      } else {
        await chrome.storage.local.set({ apiKey: "test-key-not-actually-called" });
      }
    });

    // Round 1: incorrectly claim "done" even though the real DOM still has
    // an empty required <select>. This is the exact wrong claim the real
    // provider made in the field - hand-scripted here so the test is
    // deterministic and needs no live API key/network.
    // Round 2 (only reachable if the cross-check correctly rejects round
    // 1 and re-prompts): actually resolve the missed field.
    // Round 3+: hasFillableWork() is false - the round loop stops calling
    // the LLM at all from here, so no further stub logic is needed.
    await serviceWorker.evaluate(() => {
      self.__falseDoneCallCount = 0;
      self.callModel = async (settings, systemPrompt, userMessage) => {
        self.__falseDoneCallCount++;
        const { elements } = JSON.parse(userMessage);
        if (self.__falseDoneCallCount === 1) {
          return JSON.stringify([{ type: "done", reasoning: "nothing left to fill (WRONG - country is still empty)" }]);
        }
        const countryEl = elements.find((e) => e.name === "country" && !e.filled);
        if (countryEl) {
          return JSON.stringify([{ type: "select", targetId: countryEl.id, value: "IN", reasoning: "select country" }]);
        }
        return JSON.stringify([{ type: "done", reasoning: "genuinely done now" }]);
      };
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("a wrong 'done' claim on round 0 is rejected against the real DOM, not accepted", async () => {
    const formPage = await context.newPage();
    await formPage.goto(`${baseUrl}/false-done`);

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup.html`);

    // Make the form tab the active tab RUN_TASK will resolve against -
    // same reasoning as submission-flow.spec.js.
    await formPage.bringToFront();

    // Sent directly rather than via the Autofill button click: the button
    // always requests useSmartAutofill:true, and the heuristic pre-pass
    // could otherwise resolve "country" from profileData before the LLM
    // is ever called, never exercising the false-"done" cross-check this
    // test exists to verify. popup.js's chrome.runtime.onMessage listener
    // still renders every broadcast TASK_EVENT into the visible #log
    // regardless of what triggered RUN_TASK, so this is still the real
    // rendering path, not a shortcut around it.
    await popupPage.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "RUN_TASK",
        task: "Fill out this job application form completely and accurately using the profile data.",
        useSmartAutofill: false
      });
    });

    // The real, user-visible evidence that the cross-check fired: popup.js
    // renders every "done-rejected" TASK_EVENT as a "↻ ..." log line
    // (see handleTaskEvent in popup.js). Waiting for this text in the
    // actual rendered popup log - not a mocked event array - is the live
    // verification: it can only appear if runTaskInner() genuinely called
    // hasFillableWork() against the real snapshot from the real page and
    // found the real, still-empty <select id="country">.
    await expect(popupPage.locator("#log")).toContainText(/still unfilled/i, { timeout: 15000 });

    // And the run must not have ended there - it corrects itself, selects
    // the real option in round 2, then genuinely completes in round 3
    // (popup.js's own "✅ Done: ..." wrapper only prints when RUN_TASK is
    // awaited through its local runTask() helper - bypassed above on
    // purpose so useSmartAutofill:false could be forced - so the
    // completion signal to check here is the "round"-kind event log line
    // instead, which fires regardless of how RUN_TASK was invoked).
    await expect(popupPage.locator("#log")).toContainText(/genuinely done now/i, { timeout: 15000 });

    const countryValue = await formPage.locator("#country").inputValue();
    expect(countryValue).toBe("IN");

    // Sanity check on the stub itself: this proves round 0's wrong claim
    // was really rejected and a second LLM call really happened, rather
    // than the test passing for an unrelated reason.
    const callCount = await serviceWorker.evaluate(() => self.__falseDoneCallCount);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
