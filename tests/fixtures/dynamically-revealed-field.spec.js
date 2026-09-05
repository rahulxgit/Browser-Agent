// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("dynamically revealed field (fixture 9)", () => {
  test("a field hidden behind display:none is absent from the snapshot until revealed", async ({ page }) => {
    await page.setContent(`
      <label><input type="checkbox" id="hasOtherName" /> I have used a different name before</label>
      <div id="otherNameSection" style="display:none">
        <label for="otherName">Previous name</label>
        <input id="otherName" name="otherName" type="text" />
      </div>
      <script>
        document.getElementById("hasOtherName").addEventListener("change", (e) => {
          document.getElementById("otherNameSection").style.display = e.target.checked ? "block" : "none";
        });
      </script>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const before = await page.evaluate(() => getPageSnapshot());
    // isVisible() checks computed style, not just presence in the DOM - a
    // display:none field must not appear as an actionable target the
    // model could try (and fail) to fill.
    expect(before.elements.some((el) => el.name === "otherName")).toBe(false);

    await page.locator("#hasOtherName").check();

    const after = await page.evaluate(() => getPageSnapshot());
    const revealed = after.elements.find((el) => el.name === "otherName");
    expect(revealed).toBeTruthy();
    expect(revealed.filled).toBeFalsy();
  });
});
