// UNVERIFIED - written but not executed in this session. See README.md.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { installChromeStub, injectAgentScripts } = require("./chrome-stub");


test.describe("stale DOM (fixture 16)", () => {
  test("an element replaced by a fresh node (React-style re-render) between snapshot and action fails clearly instead of silently doing nothing", async ({ page }) => {
    await page.setContent(`
      <div id="container">
        <label for="city">City</label>
        <input id="city" name="city" type="text" />
      </div>
    `);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    const snapshot = await page.evaluate(() => getPageSnapshot());
    const field = snapshot.elements.find((el) => el.name === "city");
    expect(field).toBeTruthy();

    // Simulate a real re-render: the original node (and its data-agent-id
    // attribute) is gone, replaced by a brand new element with no memory
    // of the agent's earlier snapshot at all.
    await page.evaluate(() => {
      document.getElementById("container").innerHTML =
        '<label for="city">City</label><input id="city" name="city" type="text" />';
    });

    // findElement() re-queries by data-agent-id every time rather than
    // holding a stale JS reference, so the OLD id genuinely no longer
    // resolves to anything - this must throw a clear "No element for"
    // error, not silently succeed against a detached/nonexistent node.
    await expect(
      page.evaluate((targetId) => runSingleAction({ type: "fill", targetId, value: "Boston" }), field.id)
    ).rejects.toThrow(/No element for/);
  });

  test("a fresh snapshot after the re-render finds the new node under a new id and can act on it normally", async ({ page }) => {
    await page.setContent(`<input id="city" name="city" type="text" />`);
    await page.evaluate(installChromeStub);
    await injectAgentScripts(page);

    await page.evaluate(() => {
      document.body.innerHTML = '<input id="city" name="city" type="text" />';
    });

    const freshSnapshot = await page.evaluate(() => getPageSnapshot());
    const field = freshSnapshot.elements.find((el) => el.name === "city");
    expect(field).toBeTruthy();

    const result = await page.evaluate(
      (targetId) => runSingleAction({ type: "fill", targetId, value: "Boston" }),
      field.id
    );
    expect(result.ok).toBe(true);
  });
});
