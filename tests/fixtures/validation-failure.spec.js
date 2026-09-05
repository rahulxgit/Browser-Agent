// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("validation failure (fixture 10)", () => {
  test("a field the page flags aria-invalid after a fill is surfaced as invalid, with its hint text, even though it's also filled:true", async ({ page }) => {
    await page.setContent(`
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" aria-describedby="email-error" />
      <span id="email-error"></span>
      <script>
        // Stand-in for a real page's own client-side validation: flips
        // aria-invalid + populates the error text once the field has a
        // value that doesn't look like a real work email.
        document.getElementById("email").addEventListener("blur", (e) => {
          const el = e.target;
          const bad = el.value && !el.value.includes("@company.com");
          el.setAttribute("aria-invalid", String(bad));
          document.getElementById("email-error").textContent = bad ? "Please use your company email address." : "";
        });
      </script>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    await page.locator("#email").fill("someone@gmail.com");
    await page.locator("#email").blur();

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements.find((el) => el.name === "email");

    // Direct regression for the hasFillableWork() fix from earlier in this
    // project: a field must never be treated as fully resolved just
    // because it's non-empty - "invalid" has to independently surface so
    // the run doesn't report success on a field the page itself rejected.
    expect(field.invalid).toBe(true);
    expect(field.hint).toMatch(/company email/i);
  });
});
