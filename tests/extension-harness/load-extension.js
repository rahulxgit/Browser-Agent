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

  // The background service worker registers asynchronously - if it's
  // already there by the time we check (context.serviceWorkers() is
  // non-empty), use it directly; otherwise wait for the 'serviceworker'
  // event. Its URL is chrome-extension://<id>/... , which is also how the
  // extension ID itself gets discovered (nothing exposes it more directly).
  context.on('serviceworker', async worker => {
    const fs = require('fs');
    fs.appendFileSync('sw.log', 'Service worker created: ' + worker.url() + '\n');
    worker.on('console', msg => fs.appendFileSync('sw.log', 'SW log: ' + msg.text() + '\n'));
    worker.on('pageerror', err => fs.appendFileSync('sw.log', 'SW error: ' + err + '\n'));
  });

  context.on('page', page => {
    page.on('console', msg => fs.appendFileSync('sw.log', 'Page log: ' + msg.text() + '\n'));
    page.on('pageerror', err => fs.appendFileSync('sw.log', 'Page error: ' + err + '\n'));
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }

  const fs = require('fs');
  fs.appendFileSync('sw.log', 'SW found: ' + serviceWorker.url() + '\n');
  serviceWorker.on('console', msg => fs.appendFileSync('sw.log', 'SW log: ' + msg.text() + '\n'));
  serviceWorker.on('pageerror', err => fs.appendFileSync('sw.log', 'SW error: ' + err + '\n'));
  
  const extensionId = serviceWorker.url().split("/")[2];

  return { context, serviceWorker, extensionId };
}

module.exports = { launchWithExtension, EXTENSION_PATH };
