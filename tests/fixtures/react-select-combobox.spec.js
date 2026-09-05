// UNVERIFIED - written but not executed in this session. See README.md.
//
// This is the highest-value fixture in this set: it recreates, as closely
// as a static HTML fixture reasonably can, the actual production bug this
// project traced from a real Record-mode log earlier in this session - an
// Ashby-style combobox where the real click target for opening the menu
// is a sibling <button aria-label="Toggle flyout">, not the role=combobox
// input itself. A regression here would silently reintroduce the exact
// toggle-storm stagnation bug that was already found and fixed once.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


const FIXTURE_HTML = `
  <div class="select-control">
    <input
      role="combobox"
      aria-expanded="false"
      aria-labelledby="pronouns-label"
      id="pronouns-input"
      readonly
    />
    <span id="pronouns-label" style="display:none">Pronouns</span>
    <button type="button" aria-label="Toggle flyout" id="pronouns-toggle"></button>
    <ul role="listbox" id="pronouns-listbox" hidden>
      <li role="option" id="opt-he" data-value="He/Him">He/Him</li>
      <li role="option" id="opt-she" data-value="She/Her">She/Her</li>
    </ul>
  </div>
  <script>
    // Minimal fixture behavior standing in for the real widget's JS: the
    // toggle button flips aria-expanded and listbox visibility, an option
    // click sets the input's displayed value and closes the menu.
    document.getElementById("pronouns-toggle").addEventListener("click", () => {
      const input = document.getElementById("pronouns-input");
      const listbox = document.getElementById("pronouns-listbox");
      const isOpen = input.getAttribute("aria-expanded") === "true";
      input.setAttribute("aria-expanded", String(!isOpen));
      listbox.hidden = isOpen;
    });
    for (const opt of document.querySelectorAll("[role=option]")) {
      opt.addEventListener("click", () => {
        const input = document.getElementById("pronouns-input");
        input.value = opt.dataset.value;
        input.setAttribute("aria-expanded", "false");
        document.getElementById("pronouns-listbox").hidden = true;
      });
    }
  </script>
`;

test.describe("React-Select-style combobox with a separate toggle button (fixture 7/8)", () => {
  test("the toggle button is paired with its combobox and inherits isCombobox tracking", async ({ page }) => {
    await page.setContent(FIXTURE_HTML);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const toggleEntry = snapshot.elements.find((el) => el.id && el.text === undefined && el.label === "Pronouns");
    // The toggle button's entry should have inherited the paired
    // combobox's label via aria-labelledby resolution + findPairedCombobox
    // - if this ever stops matching, the bounded-retry protection in
    // background.js silently stops applying to it again.
    expect(toggleEntry).toBeTruthy();
  });

  test("clicking the toggle opens the menu, then clicking an option selects it and verifies", async ({ page }) => {
    await page.setContent(FIXTURE_HTML);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot1 = await page.evaluate(() => getPageSnapshot());
    const toggle = snapshot1.elements.find((el) => el.tag === "button" && el.label === "Pronouns");

    const openResult = await page.evaluate((targetId) => runSingleAction({ type: "click", targetId }), toggle.id);
    expect(openResult.ok).toBe(true);
    await expect(page.locator("#pronouns-listbox")).not.toBeHidden();

    const snapshot2 = await page.evaluate(() => getPageSnapshot());
    const option = snapshot2.elements.find((el) => el.text === "He/Him" || el.role === "option");
    expect(option).toBeTruthy();

    const selectResult = await page.evaluate((targetId) => runSingleAction({ type: "click", targetId }), option.id);
    expect(selectResult.ok).toBe(true);
    expect(selectResult.verified).toBe(true);

    const value = await page.locator("#pronouns-input").inputValue();
    expect(value).toBe("He/Him");
  });

  // Direct regression for the actual production bug: clicking the SAME
  // toggle button twice in a row (opening, then closing without ever
  // selecting an option) must be reported as a verification failure with
  // an actionable reason - not a silent ok:true that lets a caller keep
  // re-clicking it forever.
  test("re-clicking the toggle while already open is flagged as closing an open menu, not a silent success", async ({ page }) => {
    await page.setContent(FIXTURE_HTML);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const toggle = snapshot.elements.find((el) => el.tag === "button" && el.label === "Pronouns");

    await page.evaluate((targetId) => runSingleAction({ type: "click", targetId }), toggle.id); // open
    const secondClick = await page.evaluate((targetId) => runSingleAction({ type: "click", targetId }), toggle.id); // close

    expect(secondClick.verified).toBe(false);
    expect(secondClick.reason).toMatch(/closed an already-open menu/);
  });
});
