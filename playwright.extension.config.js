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
  // 60s, not 30s: a shared CI runner is measurably slower than a local
  // desktop machine at extension load + tab-activation timing (the whole
  // reason for the CI stabilization waits added to each spec file) - the
  // per-assertion 15000ms timeouts inside each test already account for
  // some of this, but the overall per-test timeout needs matching room.
  timeout: 60000,
  reporter: "list"
});
