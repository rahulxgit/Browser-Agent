// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("native select (fixture 3)", () => {
  test("select action lands on the requested option and verifies", async ({ page }) => {
    await page.setContent(`
      <form>
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">Select...</option>
          <option value="IN">India</option>
          <option value="US">United States</option>
        </select>
      </form>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements.find((el) => el.name === "country");
    expect(field.options.map((o) => o.value)).toEqual(["", "IN", "US"]);

    const result = await page.evaluate(
      (targetId) => runSingleAction({ type: "select", targetId, value: "IN" }),
      field.id
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);

    const value = await page.locator("#country").inputValue();
    expect(value).toBe("IN");
  });

  test("requesting an option value that doesn't exist throws rather than silently landing on the wrong one", async ({ page }) => {
    await page.setContent(`
      <select id="s" name="s"><option value="a">A</option></select>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);
    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements[0];

    await expect(
      page.evaluate((targetId) => runSingleAction({ type: "select", targetId, value: "does-not-exist" }), field.id)
    ).rejects.toBeTruthy();
  });
});
