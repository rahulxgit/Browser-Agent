// UNVERIFIED - written but not executed in this session. See README.md in
// this directory for why, and how to actually run it.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("normal text form (fixture 1)", () => {
  test("collectInteractiveElements finds a plain labeled text input, and fill+verify round-trips", async ({ page }) => {
    await page.setContent(`
      <form>
        <label for="fname">First name</label>
        <input id="fname" name="firstName" type="text" required />
      </form>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements.find((el) => el.name === "firstName");
    expect(field).toBeTruthy();
    expect(field.label).toBe("First name");
    expect(field.filled).toBeFalsy();

    const result = await page.evaluate(
      (targetId) => runSingleAction({ type: "fill", targetId, value: "Rahul" }),
      field.id
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);

    const value = await page.locator("#fname").inputValue();
    expect(value).toBe("Rahul");
  });
});
