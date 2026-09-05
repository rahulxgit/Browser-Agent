// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("file upload requirement (fixture 12)", () => {
  test("a resume upload input is flagged requiresManualUpload, never treated as a fillable text field", async ({ page }) => {
    await page.setContent(`
      <label for="resume">Resume</label>
      <input id="resume" name="resume" type="file" required />
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements.find((el) => el.name === "resume");

    expect(field.requiresManualUpload).toBe(true);
    // A "fill" attempt on a file input must be explicitly rejected, not
    // silently do nothing and get misread as a successful no-op fill.
    await expect(
      page.evaluate((targetId) => runSingleAction({ type: "fill", targetId, value: "resume.pdf" }), field.id)
    ).rejects.toBeTruthy();
  });

  test("getFormStatus() reports a required file input as missing until a real file is attached", async ({ page }) => {
    await page.setContent(`<input id="resume" name="resume" type="file" required />`);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const status = await page.evaluate(() => getFormStatus());
    expect(status.count).toBeGreaterThan(0);
    expect(status.missing.some((m) => m.type === "file")).toBe(true);
  });
});
