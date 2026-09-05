# Browser fixture tests (Phase 19)

## Status: written, NOT executed in this session

The Node-runnable suite at `tests/dropdown-helpers.test.js` (81 tests as of
this phase) covers every pure decision-table piece of this codebase -
combobox retry logic, submit-detection tiers, verification rules, provider
error classification, learning-system contradiction detection, and more.
That suite genuinely runs and genuinely passes; every test result reported
alongside it in this project has been real.

These Playwright fixture files are different: they need a real Chromium
binary and a real DOM to load `content.js` into and interact with. This
sandbox has no browser binary available and no network access to
`playwright.dev`'s download CDN to install one (the allowed domains list is
scoped to package registries, not browser-binary hosts) - so **these files
have been written but never actually run**. Treat them as a real,
reasonable starting point for the 18-scenario list in the original task
spec, not as verified, passing coverage. Anything claiming these pass
without having actually run them would be exactly the kind of unverified
claim the project's own rules say not to make.

## What's here vs. the full 18-scenario list

Ten of the eighteen scenarios from the original task spec are now
scaffolded:

1. `normal-text-form.spec.js` - basic fill/verify round-trip
2. `native-select.spec.js` - native `<select>` fill + verification
3. `checkbox-consent.spec.js` - unchecked consent checkbox detection
4. `react-select-combobox.spec.js` - the toggle-button pairing fix and
   bounded-retry behavior from earlier in this session
5. `date-input.spec.js` - `<input type=date>` + `toISODate()` end-to-end
6. `dynamically-revealed-field.spec.js` - a field hidden behind
   `display:none` until another control reveals it
7. `validation-failure.spec.js` - `aria-invalid`/hint surfacing after a
   page's own client-side validation rejects a value
8. `manually-populated-form.spec.js` - a human-typed value is recognized
   as `filled:true` and never overwritten by `smartAutofill`
9. `file-upload-requirement.spec.js` - `requiresManualUpload` flagging and
   `getFormStatus()` reporting it as still-missing
10. `stale-dom.spec.js` - an element replaced by a fresh React-style
    re-render fails clearly (`No element for ...`) rather than silently

The remaining eight - searchable dropdown, submit confirmation, successful
submission, failed submission, navigation, and multi-step form, plus two of
the more elaborate ATS-specific cases - are not scaffolded. The submission-
flow ones in particular exercise `background.js`'s preflight-audit/
confirmation-token/submission-verification logic, which needs real
message-passing between a background script and a content script - the
current `page.addScriptTag` + `chrome-stub.js` approach only loads
`content.js` standalone into a plain page and can't simulate that. Testing
those properly would need `chromium.launchPersistentContext(...)` with
`--load-extension` pointed at this actual unpacked extension, which is a
meaningfully bigger harness than what's here - flagging as real, deliberate
scope, not an oversight.

## Running these for real

```bash
npm install -D @playwright/test
npx playwright install chromium
npx playwright test tests/fixtures
```

Each spec loads `src/content.js` directly via `page.addScriptTag` against
a `page.setContent(...)` fixture, then calls the same functions
(`collectInteractiveElements`, `runSingleAction`, `smartAutofill`, etc.)
this project already unit-tests in isolation - the point of these files is
confirming those functions behave the same way against a *real* browser
DOM, not re-testing the pure logic again.
