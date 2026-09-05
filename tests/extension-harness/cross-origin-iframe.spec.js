// LIVE VERIFICATION of item #3 from a prior debugging session's
// recommendations list: "cross-origin iframe submission verification is
// a structural gap - browser-enforced, no clean client-side fix." That
// claim was carried forward from an older code comment in content.js
// (collectFrameText: "This extension is only ever injected into the top
// frame") which is now STALE - ensureContentScript in background.js has
// injected with allFrames:true (and content.js grew the matching
// AGENT_REQUEST_SNAPSHOT/AGENT_IFRAME_SNAPSHOT and
// AGENT_REQUEST_OUTCOME/AGENT_IFRAME_OUTCOME postMessage protocols) for a
// while now. chrome.scripting.executeScript with allFrames genuinely
// injects into cross-origin child frames too (a browser-granted extension
// privilege, distinct from the plain-JS contentDocument access that
// remains SOP-blocked) - so the postMessage-relayed snapshot/outcome
// merging should already reach a cross-origin iframe, independent of
// collectFrameText()'s direct-DOM-access fallback which genuinely can't.
//
// Per this project's own rule ("never claim a bug is fixed without
// evidence"), that cuts both ways: a "known gap" claim needs the same
// evidence bar as a "confirmed fixed" claim. This test provides that
// evidence one way or the other, against two real HTTP servers on two
// different ports (a genuine cross-origin boundary, not a simulated one)
// - not by asserting a hoped-for outcome.
const { test, expect } = require("@playwright/test");
const { launchWithExtension } = require("./load-extension");
const { startFixtureServer } = require("./fixture-server");

test.describe("cross-origin iframe form fill + submission verification", () => {
  let context, serviceWorker, extensionId;
  let parentServer, parentBaseUrl;
  let iframeServer, iframeBaseUrl;

  test.beforeAll(async () => {
    // Two independent server instances, each on its own random port -
    // 127.0.0.1:portA and 127.0.0.1:portB differ in port, which is a
    // distinct origin per the browser's same-origin policy even though
    // the hostname is identical. That's what makes the iframe below
    // genuinely cross-origin rather than only appearing to be.
    ({ server: parentServer, baseUrl: parentBaseUrl } = await startFixtureServer());
    ({ server: iframeServer, baseUrl: iframeBaseUrl } = await startFixtureServer());
    ({ context, serviceWorker, extensionId } = await launchWithExtension());

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        provider: "gemini",
        profileData: JSON.stringify({ firstName: "Test", email: "test@example.com" }),
        pauseBeforeSubmit: true
      });
      if (chrome.storage.session) {
        await chrome.storage.session.set({ apiKey: "test-key-not-actually-called" });
      } else {
        await chrome.storage.local.set({ apiKey: "test-key-not-actually-called" });
      }
    });

    // Same stubbing approach as submission-flow.spec.js: fill whatever's
    // still unfilled in the MERGED snapshot (parent + iframe elements,
    // however content.js's frame-merge produced it), then click submit
    // once nothing's left. The stub deliberately doesn't know or care
    // whether an element came from the parent frame or the iframe - if
    // the merge is real, `elements` already contains both, indistinguishably.
    await serviceWorker.evaluate(() => {
      self.callModel = async (settings, systemPrompt, userMessage) => {
        const { elements } = JSON.parse(userMessage);
        const findUnfilled = (name) => elements.find((e) => e.name === name && !e.filled);

        const fills = [];
        for (const name of ["firstName", "email"]) {
          const el = findUnfilled(name);
          if (el) fills.push({ type: "fill", targetId: el.id, value: name === "email" ? "test@example.com" : "Test", reasoning: "test" });
        }
        if (fills.length) return JSON.stringify(fills);

        const submitBtn = elements.find((e) => (e.text || e.label || "").includes("Submit Application"));
        if (submitBtn) return JSON.stringify([{ type: "click", targetId: submitBtn.id, reasoning: "submit" }]);

        return JSON.stringify([{ type: "done", reasoning: "nothing left to do" }]);
      };
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    if (parentServer) await new Promise((resolve) => parentServer.close(resolve));
    if (iframeServer) await new Promise((resolve) => iframeServer.close(resolve));
  });

  test("fills fields and detects submission success inside a genuinely cross-origin iframe", async () => {
    const iframeSrc = `${iframeBaseUrl}/iframe-apply`;
    const formPage = await context.newPage();
    await formPage.goto(`${parentBaseUrl}/parent-with-iframe?iframeSrc=${encodeURIComponent(iframeSrc)}`);

    // Confirm the test fixture itself is genuinely cross-origin before
    // trusting anything the extension reports - if this assertion ever
    // fails, the test below would be silently exercising the SAME-origin
    // path instead and its result would be meaningless.
    const frameOrigin = new URL(iframeSrc).origin;
    const parentOrigin = new URL(parentBaseUrl).origin;
    expect(frameOrigin).not.toBe(parentOrigin);

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup.html`);
    await formPage.bringToFront();

    await popupPage.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "RUN_TASK",
        task: "Fill out this job application form completely and accurately using the profile data.",
        useSmartAutofill: false
      });
    });

    // Real evidence, not a mocked expectation: the confirm banner only
    // appears once background.js's submit-safety pause fired on the click
    // INSIDE the iframe - which can only happen if dispatchAction routed
    // the click through the composed iframe0-... id into the correct
    // cross-origin frame.
    await expect(popupPage.locator("#confirmBtn")).toBeVisible({ timeout: 15000 });
    await popupPage.locator("#confirmBtn").click();

    // The success text lives inside the cross-origin iframe's own
    // document, replacing its body via the fixture's own inline script
    // (no top-level navigation happens here, unlike submission-flow.spec's
    // /apply/success redirect - this fixture intentionally mirrors ATS
    // embeds that swap content in-place inside the iframe rather than
    // navigating the top frame). If getSubmissionOutcome()'s cross-frame
    // postMessage merge can't reach a cross-origin child, this text would
    // never be visible to the extension's own outcome check even though a
    // human looking at the page would see it plainly.
    const iframeElement = formPage.frameLocator("#appFrame");
    await expect(iframeElement.locator("h1")).toHaveText("Thank you for applying!", { timeout: 15000 });

    await expect(popupPage.locator("#statusBadge")).toHaveText("Submitted", { timeout: 15000 });
  });
});
