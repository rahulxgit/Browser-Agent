// @ts-check
const { defineConfig } = require("@playwright/test");

// Separate from the top-level playwright.config.js (which targets
// tests/fixtures - the plain-page addScriptTag scaffold) because this one
// needs a persistent context per test file, not the default
// browser-per-worker model - each spec file in tests/extension-harness
// manages its own launchWithExtension() call in beforeAll/afterAll rather
// than relying on Playwright's built-in fixtures for that.
module.exports = defineConfig({
  testDir: "./tests/extension-harness",
  fullyParallel: false, // each test launches its own full browser + extension - running them one at a time avoids port/resource contention between fixture servers
  timeout: 30000,
  reporter: "list"
});
