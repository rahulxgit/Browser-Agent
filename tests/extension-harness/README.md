# Extension-harness tests (the real thing)

## What this is, and how it's different from tests/fixtures/

`tests/fixtures/*.spec.js` loads `content.js` standalone into a plain
Playwright page via `page.addScriptTag` + a hand-rolled `chrome.*` stub.
That's the right, lightweight tool for testing content.js's own DOM logic
in isolation, but it structurally CANNOT reach anything that needs real
`background.js` <-> `content.js` message-passing - which is exactly why
submission-flow, navigation, and multi-step-form scenarios were explicitly
left out of that scaffold rather than faked.

This directory is the correct tool for those: `chromium.launchPersistentContext(...)`
with `--load-extension` pointed at the actual unpacked extension
(`load-extension.js`), so `chrome.runtime.sendMessage`, `chrome.storage`,
`chrome.scripting.executeScript`, and the real MV3 service worker are all
genuinely present - not stubbed.

## Status: written, NOT executed in this session

Same honest caveat as `tests/fixtures/`: no Chromium binary available in
this sandbox. One complete scenario is here -
`submission-flow.spec.js` - covering autofill -> preflight audit ->
human confirmation -> the real submit click -> submission verification,
against a real local HTTP fixture server (`fixture-server.js`) with real
page navigation, not simulated. It stubs the LLM call itself
(`self.callModel = ...` reassigned directly on the service worker's
global scope) rather than requiring a real API key/network access, since
that's the one piece genuinely impossible to make deterministic and
runnable without a live provider.

## A real bug found while writing this test, not by running it

Tracing through exactly what would happen when the stubbed LLM fills every
field in one round surfaced a genuine, pre-existing issue:
`hasFillableWork()` only knows about fields, not about a submit button
still sitting unclicked - the round loop returned "done" the instant every
field was filled, without ever calling the LLM again, even though the
system prompt explicitly tells the model to defer the submit click to a
"later round" rather than bundling it with the last fill. That later round
never arrived. Fixed in `background.js` (see the `gaveSubmitChance`/
`onSubmitChanceRound` comments there) and pinned with three new unit tests
in `tests/dropdown-helpers.test.js` - this is a good, concrete example of
why building even an unexecuted test is worth doing: the trace itself
found something a code review alone hadn't caught across many earlier
phases of this project.

## Running these for real

```bash
npm install -D @playwright/test
npx playwright install chromium
npx playwright test --config=playwright.extension.config.js
```

Headless Chromium extension support needs `--headless=new` explicitly
(older default headless modes don't load extensions at all - the service
worker would simply never register, and `launchWithExtension()` would
time out waiting for it). If a real run hangs or fails at that
`waitForEvent("serviceworker")` step specifically, that flag is the first
thing to check.

## What's not here

Navigation-heavy and multi-step-form scenarios from the original 18-item
list still aren't scaffolded - `submission-flow.spec.js` is one complete,
carefully-traced example of the pattern, not the full set. Extending it to
more scenarios is mostly a matter of adding more fixture-server routes and
more scripted `callModel` stub sequences, following the same shape.
