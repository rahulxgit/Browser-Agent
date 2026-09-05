// This is the correct tool for testing background.js <-> content.js
// message-passing, which the earlier tests/fixtures/*.spec.js files
// (page.addScriptTag + a chrome-stub) explicitly could NOT reach - those
// only ever loaded content.js standalone into a plain page. Here, the
// ACTUAL unpacked extension is loaded, so chrome.runtime.sendMessage,
// chrome.scripting.executeScript, chrome.storage, and the real MV3
// service worker are all genuinely present, not stubbed.
const path = require("path");
const { chromium } = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, "..", "..");

async function launchWithExtension() {
  // MV3 extensions need a persistent context, not the default
  // browser.newContext() - Playwright's ordinary launch() doesn't load
  // unpacked extensions at all. Headless Chromium (Chrome 116+, "the new
  // headless") does support extensions, but --headless=new must be
  // explicit - the default headless:true in some Playwright/Chromium
  // combinations still uses the old headless mode, which does NOT load
  // extensions and would fail silently (no service worker ever appears).
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });

  // Logging straight to console.log (not a local sw.log file) on purpose:
  // sw.log is gitignored and invisible in CI, which is exactly why the
  // first two CI runs of the extension-harness suite gave zero insight
  // into WHY every test failed identically (RUN_TASK visibly doing
  // nothing at all, not just doing it slowly - confirmed by bumping the
  // timeout from 15s to 25s with literally zero change in outcome).
  // console.log here lands directly in the CI job's own log output.
  context.on('serviceworker', async worker => {
    console.log('[sw] Service worker created: ' + worker.url());
    worker.on('console', msg => console.log('[sw console] ' + msg.text()));
    worker.on('pageerror', err => console.log('[sw error] ' + err));
  });

  context.on('page', page => {
    console.log('[page] opened: ' + page.url());
    page.on('console', msg => console.log('[page console] ' + msg.text()));
    page.on('pageerror', err => console.log('[page error] ' + err));
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }

  console.log('[sw] SW found: ' + serviceWorker.url());
  serviceWorker.on('console', msg => console.log('[sw console] ' + msg.text()));
  serviceWorker.on('pageerror', err => console.log('[sw error] ' + err));

  const extensionId = serviceWorker.url().split("/")[2];

  return { context, serviceWorker, extensionId };
}

module.exports = { launchWithExtension, EXTENSION_PATH };
