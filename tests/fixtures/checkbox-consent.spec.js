// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("checkbox / consent (fixture 4)", () => {
  test("an unchecked consent checkbox is flagged unfilled, and a click checks + verifies it", async ({ page }) => {
    await page.setContent(`
      <label>
        <input type="checkbox" id="consent" name="consent" required />
        I agree to the privacy policy and terms
      </label>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const before = await page.evaluate(() => getPageSnapshot());
    const field = before.elements.find((el) => el.name === "consent");
    expect(field.filled).toBeFalsy();

    const result = await page.evaluate((targetId) => runSingleAction({ type: "click", targetId }), field.id);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true); // Phase 5 - a checkbox click is verified against .checked, not assumed

    const checked = await page.locator("#consent").isChecked();
    expect(checked).toBe(true);
  });
});
