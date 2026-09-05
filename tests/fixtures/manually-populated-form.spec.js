// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("manually populated form (fixture 11)", () => {
  test("a field the human already typed into is marked filled:true and smartAutofill leaves it alone", async ({ page }) => {
    await page.setContent(`
      <label for="fname">First name</label>
      <input id="fname" name="firstName" type="text" />
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    // Simulate the human typing directly, not an agent fill - real
    // keystrokes via Playwright's .fill(), no data-agent-filled attribute
    // ever gets set by this.
    await page.locator("#fname").fill("Priya");

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements.find((el) => el.name === "firstName");
    // filled:true has to come from the live currentValue check, not just
    // the data-agent-filled attribute the agent's own fill sets - a field
    // it never touched must still read as "done" once it has a real value.
    expect(field.filled).toBe(true);

    await page.evaluate(() => smartAutofill({ firstName: "SomeoneElse" }));

    const value = await page.locator("#fname").inputValue();
    expect(value).toBe("Priya"); // untouched - smartAutofill's "don't overwrite existing input" guard held
  });
});
