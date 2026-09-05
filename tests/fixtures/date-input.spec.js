// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("date input (fixture 6)", () => {
  test("smartAutofill converts a DD-MM-YYYY profile value to ISO for a native <input type=date>", async ({ page }) => {
    await page.setContent(`
      <label for="dob">Date of birth</label>
      <input id="dob" name="dob" type="date" />
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    await page.evaluate(() => smartAutofill({ dateOfBirth: "15-08-1998" }));

    const value = await page.locator("#dob").inputValue();
    // <input type=date>.value is always ISO (yyyy-mm-dd) regardless of the
    // profile source format - this is the actual toISODate() conversion
    // already unit-tested in isolation, confirmed here against a real
    // date input's value semantics.
    expect(value).toBe("1998-08-15");
  });

  test("a garbage date string does not crash smartAutofill and simply leaves the field untouched", async ({ page }) => {
    await page.setContent(`<input id="dob" name="dob" type="date" />`);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    await page.evaluate(() => smartAutofill({ dateOfBirth: "not-a-real-date" }));

    const value = await page.locator("#dob").inputValue();
    expect(value).toBe("");
  });
});
