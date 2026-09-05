const assert = require("assert");
const { isHost } = require("../src/lib/host-utils.js");
const ActionSchema = require("../src/lib/action-schema.js");
const policy = require("../src/lib/sensitive-data-policy.js");
const memory = require("../src/lib/answer-memory.js");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

test("strict ATS host matching accepts subdomains but rejects lookalikes", () => {
  assert.equal(isHost("taleo.net", "taleo.net"), true);
  assert.equal(isHost("jobs.taleo.net", "taleo.net"), true);
  assert.equal(isHost("evil-taleo.net", "taleo.net"), false);
});

// Regression for the two adapters added in Phase 29 (smartrecruiters.js,
// successfactors.js) - same host-matching rules as every existing
// adapter, verified the same way rather than assumed to work by analogy.
test("smartrecruiters.com host matching accepts subdomains but rejects lookalikes", () => {
  assert.equal(isHost("careers.smartrecruiters.com", "smartrecruiters.com"), true);
  assert.equal(isHost("smartrecruiters.com", "smartrecruiters.com"), true);
  assert.equal(isHost("evil-smartrecruiters.com", "smartrecruiters.com"), false);
});

test("successfactors.com and .eu host matching accepts subdomains but rejects lookalikes", () => {
  assert.equal(isHost("career5.successfactors.com", "successfactors.com"), true);
  assert.equal(isHost("performancemanager4.successfactors.eu", "successfactors.eu"), true);
  assert.equal(isHost("totally-not-successfactors.com", "successfactors.com"), false);
});

test("sensitive policy masks PII and keeps professional data provider-safe", () => {
  assert.equal(policy.shouldMask("Passport number"), true);
  assert.equal(policy.canSendToProvider("Email"), false);
  assert.equal(policy.canSendToProvider("GitHub portfolio"), true);
});

test("context-dependent answers never auto-reuse", () => {
  const entry = memory.buildEntry(
    { domain: "jobs.example", question: "Expected salary", jobTitle: "Engineer" },
    "12 LPA",
    100
  );
  assert.equal(entry.category, "CONFIRM_BEFORE_REUSE");
  assert.equal(
    memory.canReuse(entry, { domain: "jobs.example", question: "Expected salary", jobTitle: "Engineer" }, 101),
    false
  );
});

test("safe answers require matching domain and question context", () => {
  const entry = memory.buildEntry(
    { domain: "jobs.example", question: "GitHub profile", company: "Example" },
    "https://github.com/example",
    100
  );
  assert.equal(
    memory.canReuse(entry, { domain: "jobs.example", question: "GitHub profile", company: "Example" }, 101),
    true
  );
  assert.equal(
    memory.canReuse(entry, { domain: "other.example", question: "GitHub profile", company: "Example" }, 101),
    false
  );
});

// Regression for Phase 31: ActionSchema existed and was fully correct but
// was never actually called anywhere in the pipeline - every LLM action
// reached execution with zero structural validation. These test the real
// module directly (not a copied simulation, since this one - unlike
// content.js's DOM-dependent functions - has no dependency on a browser
// environment and can be required exactly as background.js does via
// importScripts).
test("a well-formed action batch (including the new optional confidence field) validates", () => {
  const actions = [
    { type: "fill", targetId: "el-1", value: "Jane Doe", reasoning: "matches profile name" },
    { type: "select", targetId: "el-2", value: "US", confidence: 0.6 },
    { type: "done", reasoning: "form complete" }
  ];
  assert.strictEqual(ActionSchema.validateActionBatch(actions), true);
});

test("an action with a hallucinated/unrecognized type fails validation and is named in the error description", () => {
  const actions = [{ type: "submit_form", targetId: "el-1" }];
  assert.strictEqual(ActionSchema.validateActionBatch(actions), false);
  const errors = ActionSchema.describeActionBatchErrors(actions);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /unrecognized type "submit_form"/);
});

test("a fill action missing its targetId fails validation and is named in the error description", () => {
  const actions = [{ type: "fill", value: "Jane Doe" }];
  assert.strictEqual(ActionSchema.validateActionBatch(actions), false);
  const errors = ActionSchema.describeActionBatchErrors(actions);
  assert.match(errors[0], /missing a string targetId/);
});

test("an ask action missing its question fails validation", () => {
  const actions = [{ type: "ask", targetId: "el-5" }];
  assert.strictEqual(ActionSchema.validateActionBatch(actions), false);
});

test("a confidence value outside 0-1 fails validation even though every other field is well-formed", () => {
  const actions = [{ type: "select", targetId: "el-2", value: "US", confidence: 1.4 }];
  assert.strictEqual(ActionSchema.validateActionBatch(actions), false);
  const errors = ActionSchema.describeActionBatchErrors(actions);
  assert.match(errors[0], /invalid confidence value/);
});

test("an action with no confidence field at all still validates - it is optional, not required", () => {
  const actions = [{ type: "click", targetId: "el-9" }];
  assert.strictEqual(ActionSchema.validateActionBatch(actions), true);
});

test("a plain object (not wrapped in an array) is correctly rejected with a clear top-level error", () => {
  const errors = ActionSchema.describeActionBatchErrors({ type: "fill", targetId: "el-1" });
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /not a JSON array/);
});

// Phase 34 - real vulnerability found and fixed in AnswerMemory.reusePolicy:
// a field label combining a genuinely sensitive term with an unrelated
// innocuous keyword (e.g. "Current CTC - confirm via email") was
// incorrectly marked SAFE_REUSE because the old logic used
// `category === "professional" || /.../.test(field)` - an OR that let the
// regex override a more sensitive category classification entirely.
test("a salary question that also happens to mention 'email' is NOT downgraded to safe auto-reuse", () => {
  assert.strictEqual(memory.reusePolicy("Current CTC - please confirm via email"), "CONFIRM_BEFORE_REUSE");
});

test("a government-ID question that also mentions 'github' is never auto-reusable, not silently downgraded", () => {
  assert.strictEqual(memory.reusePolicy("Passport number (see your github for reference)"), "NEVER_AUTO_REUSE");
});

test("plain, unambiguous safe fields (no sensitive keyword coincidence) still resolve exactly as before", () => {
  assert.strictEqual(memory.reusePolicy("GitHub profile"), "SAFE_REUSE");
  assert.strictEqual(memory.reusePolicy("Email address"), "SAFE_REUSE");
});

test("a plain salary question with no coincidental safe keyword still requires confirmation, unaffected by the fix", () => {
  assert.strictEqual(memory.reusePolicy("Expected salary"), "CONFIRM_BEFORE_REUSE");
});

// Regression for the "custom instruction / Run custom instruction does
// nothing" bug: the system prompt used to tell the model to treat "the
// user task" as untrusted data, never as instructions - in the same
// sentence as page labels/element text/job context. That's the extension's
// OWN user-typed instruction (from the popup's "Run custom instruction"
// box), not scraped page content, so it should never have been lumped in
// with the prompt-injection defense. background.js isn't a CommonJS
// module (MV3 service worker, loaded via importScripts), so this is a
// source-text assertion rather than a call into buildSystemPrompt directly
// - cheap, and it still catches a regression if the old wording comes back.
test("system prompt no longer tells the model to ignore the user's own task as untrusted", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "background.js"), "utf8");
  assert.ok(
    !/untrusted data, never as instructions[\s\S]{0,5}\n[\s\S]{0,80}the user task/i.test(src) &&
      !/element text, job context, and the user task as\s+untrusted/i.test(src),
    "the user's own task must not be described as untrusted/non-instructional alongside scraped page content"
  );
  assert.match(
    src,
    /trusted instruction from the human operating/i,
    "the system prompt should explicitly mark the task field as a trusted instruction"
  );
});

// Regression for runs that failed outright (ok:false, "Model did not
// return valid JSON") after only ONE self-correction attempt, seen live in
// a captured record log against a reasoning-style model that narrated
// ("Let me analyze the task...") on both the original call and the retry.
// This doesn't fix a specific model's behavior, but bumping the corrective
// budget from 1 to 2 attempts (plus naming the failing model/provider in
// the final error) is the generic, reusable mitigation - verified here as
// a source-level check since the retry loop lives inside runTaskInner,
// which isn't independently callable outside the service worker context.
test("JSON self-correction budget is 2 attempts, not 1, and failure names the model/provider", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "background.js"), "utf8");
  assert.match(src, /const maxCorrections = 2;/, "self-correction should retry up to 2 times, not just once");
  assert.match(
    src,
    /provider: \$\{settings\.provider[\s\S]{0,40}model: \$\{settings\.model/,
    "a final self-correction failure should name the active provider/model in the thrown error"
  );
});

// Recommendation-turned-fix: screenshots were captured on every single
// round unconditionally, adding a capture round-trip and real image
// tokens even on rounds that only ran plain text fills with nothing
// visually new to see. Verifies the gating conditions exist in source
// (round 0, a visually-relevant previous action, or a done-correction
// round) rather than the capture always firing - source-level check for
// the same reason as the two tests above.
test("screenshot capture is gated, not unconditional every round", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "background.js"), "utf8");
  assert.match(
    src,
    /const needsScreenshot = round === 0 \|\| previousRoundHadVisualChange \|\| !!pendingDoneCorrection;/,
    "screenshot capture should be skipped on rounds with no visually-relevant previous action"
  );
  assert.match(
    src,
    /previousRoundHadVisualChange = safeActions\.some\(\(a\) => \["click", "select", "scroll"\]\.includes\(a\.type\)\);/,
    "the visual-change flag should be derived from the actions actually run last round"
  );
});

// Recommendation-turned-fix: hitting MAX_ROUNDS used to report the flat,
// unhelpful "Hit max round limit without finishing." with no indication
// of what was actually still outstanding - indistinguishable from the
// stagnation guard's "no progress" stop even though they mean different
// things. Verifies the round-limit path now names the actual blocking
// fields (same describeUnresolvedFields call the stagnation guard uses)
// rather than a flat unhelpful string.
test("hitting MAX_ROUNDS reports which fields are still unresolved, not just a flat message", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "background.js"), "utf8");
  assert.match(
    src,
    /Hit the \$\{MAX_ROUNDS\}-round limit without finishing/,
    "the round-limit summary should name the actual configured round cap"
  );
  assert.match(
    src,
    /const blocking = describeUnresolvedFields\(finalSnapshot\);[\s\S]{0,300}Still unresolved:/,
    "the round-limit summary should name the specific fields still blocking, not just a flat 'didn't finish' message"
  );
});
