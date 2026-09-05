const autofillBtn = document.getElementById("autofillBtn");
const stopBtn = document.getElementById("stopBtn");
const reviewBtn = document.getElementById("reviewBtn");
const advancedToggle = document.getElementById("advancedToggle");
const advancedSection = document.getElementById("advancedSection");
const taskInput = document.getElementById("task");
const runBtn = document.getElementById("run");
const log = document.getElementById("log");
const pauseBanner = document.getElementById("pauseBanner");
const pauseElementLabel = document.getElementById("pauseElementLabel");
const pauseReasoning = document.getElementById("pauseReasoning");
const confirmBtn = document.getElementById("confirmBtn");
const cancelBtn = document.getElementById("cancelBtn");
const askBanner = document.getElementById("askBanner");
const askQuestion = document.getElementById("askQuestion");
const askInput = document.getElementById("askInput");
const submitAnswerBtn = document.getElementById("submitAnswerBtn");
const skipAnswerBtn = document.getElementById("skipAnswerBtn");
const learnBanner = document.getElementById("learnBanner");
const learnField = document.getElementById("learnField");
const learnValue = document.getElementById("learnValue");
const learnWarning = document.getElementById("learnWarning");
const learnBtn = document.getElementById("learnBtn");
const dismissLearnBtn = document.getElementById("dismissLearnBtn");
const statusBadge = document.getElementById("statusBadge");

let activeRunId = null;
let activeAnswerRunId = null;
let currentTaskRunId = null;

// --- Run-state badge (Phase 20) ------------------------------------------
// One explicit state at a time, mapped only from signals that are
// actually true right now - never set optimistically ahead of the real
// event that confirms it. In particular "Submitted" is ONLY ever reached
// from a real submission-verified:true event, never from "the confirm
// button was clicked" or "the run finished without an error" - those are
// "Submitting" and (if nothing was ever submitted) back to "Idle"
// respectively, exactly to avoid the misleading-success-state problem.
const STATUS_STYLES = {
  Idle: "status-idle",
  Discovering: "status-active",
  Autofilling: "status-active",
  Thinking: "status-active",
  Executing: "status-active",
  "Waiting for user": "status-waiting",
  "Ready to submit": "status-waiting",
  Submitting: "status-active",
  Submitted: "status-submitted",
  Failed: "status-failed",
  Stopped: "status-stopped"
};

function setState(state) {
  statusBadge.textContent = state;
  statusBadge.className = `status-badge ${STATUS_STYLES[state] || "status-idle"}`;
}

// --- Dashboard counters (Phase 20 remainder) ------------------------------
// Every counter here is sourced from a real event, not estimated or
// inferred - "Remaining" in particular starts at "—" rather than 0
// specifically to avoid claiming "nothing left to do" before any check
// has actually run (0 would be a misleading success state exactly like
// the one this project's own rules warn against for the status badge).
const statEls = {
  site: document.getElementById("statSite"),
  completed: document.getElementById("statCompleted"),
  remaining: document.getElementById("statRemaining"),
  failed: document.getElementById("statFailed"),
  questions: document.getElementById("statQuestions"),
  warnings: document.getElementById("statWarnings"),
  llmCalls: document.getElementById("statLlmCalls"),
  recoveries: document.getElementById("statRecoveries")
};

let stats = { completed: 0, failed: 0, questions: 0, warnings: 0, llmCalls: 0, recoveries: 0 };

function resetStats() {
  stats = { completed: 0, failed: 0, questions: 0, warnings: 0, llmCalls: 0, recoveries: 0 };
  statEls.remaining.textContent = "—";
  renderStats();
}

function renderStats() {
  statEls.completed.textContent = stats.completed;
  statEls.failed.textContent = stats.failed;
  statEls.questions.textContent = stats.questions;
  statEls.warnings.textContent = stats.warnings;
  statEls.llmCalls.textContent = stats.llmCalls;
  statEls.recoveries.textContent = stats.recoveries;
}

async function refreshCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    statEls.site.textContent = tab?.url ? new URL(tab.url).hostname : "—";
  } catch {
    statEls.site.textContent = "—";
  }
}
refreshCurrentSite();

function addLogEntry(text, cls) {
  const div = document.createElement("div");
  div.className = cls ? `step ${cls}` : "step";
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showPauseBanner({ runId, elementLabel, action, preflightAudit }) {
  activeRunId = runId;
  currentTaskRunId = runId;
  pauseElementLabel.textContent = elementLabel || (action && action.targetId) || "";
  pauseReasoning.textContent = (action && action.reasoning) || "";
  pauseBanner.style.display = "block";
  setRunning(true); // a paused run is still "active" - Stop should still work
  setState("Ready to submit");

  // Phase 8 preflight audit - shown as log lines rather than new banner
  // markup, so this doesn't require popup.html layout changes to land.
  // "Application Review" style summary before the human decides.
  if (preflightAudit) {
    addLogEntry("── Application Review ──");
    if (preflightAudit.requiredMissing.length === 0) {
      addLogEntry("✓ All native required fields completed");
    } else {
      addLogEntry(`✗ Still missing: ${preflightAudit.requiredMissing.join(", ")}`);
    }
    if (preflightAudit.invalidFields.length) {
      addLogEntry(`⚠ Failing validation: ${preflightAudit.invalidFields.join(", ")}`);
    }
    if (preflightAudit.unresolvedQuestions.length) {
      addLogEntry(`⚠ Unchecked consent/agreement: ${preflightAudit.unresolvedQuestions.join(", ")}`);
    }
    if (preflightAudit.pendingUploads.length) {
      addLogEntry(`⚠ Needs manual upload: ${preflightAudit.pendingUploads.join(", ")}`);
    }
    addLogEntry(preflightAudit.ready ? "Ready to submit." : "Not fully ready - review before confirming.");
  }
}

function hidePauseBanner() {
  activeRunId = null;
  pauseBanner.style.display = "none";
}

function showAskBanner({ runId, question }) {
  activeAnswerRunId = runId;
  currentTaskRunId = runId;
  askQuestion.textContent = question || "It needs more information.";
  askInput.value = "";
  askBanner.style.display = "block";
  askInput.focus();
  setRunning(true);
  setState("Waiting for user");
  stats.questions += 1;
  renderStats();
}

function hideAskBanner() {
  activeAnswerRunId = null;
  askBanner.style.display = "none";
}

function showLearningBanner(candidate) {
  learnField.textContent = candidate.label || "New profile value";
  learnValue.textContent = candidate.value || "";
  // Phase 15 - surface the two cases that used to be invisible: a
  // cautious category (salary, DOB, visa status) and a genuine
  // contradiction with something already learned for this same field.
  const warnings = [];
  if (candidate.sensitive) warnings.push("This is a sensitive field - double check before saving it for reuse on future applications.");
  if (candidate.contradicts) warnings.push(`This conflicts with a previously learned value: "${candidate.previousValue}". Saving will replace it.`);
  learnWarning.textContent = warnings.join(" ");
  learnWarning.style.display = warnings.length ? "block" : "none";
  learnBanner.style.display = "block";
}

function hideLearningBanner() {
  learnBanner.style.display = "none";
}

function setRunning(isRunning) {
  autofillBtn.disabled = isRunning;
  runBtn.disabled = isRunning;
  autofillBtn.textContent = isRunning ? "Running…" : "⚡ Autofill this application";
  stopBtn.style.display = isRunning ? "block" : "none";
}

// On open, check if a run is sitting paused waiting for input from a
// previous popup/side-panel session that got closed - without this, a
// paused run would just look like nothing is happening, with no way to
// tell it's actually stuck waiting on you.
async function rehydratePendingAction() {
  try {
    const pending = await chrome.runtime.sendMessage({ type: "GET_PENDING_ACTION" });
    if (pending && pending.kind === "confirm") {
      addLogEntry("Reopened — a paused run is still waiting for your confirmation.");
      showPauseBanner(pending);
    } else if (pending && pending.kind === "ask") {
      addLogEntry("Reopened — a paused run is still waiting for an answer.");
      showAskBanner(pending);
    }
  } catch {
    // Background not reachable yet - fine, just skip rehydration this time.
  }
  try {
    const candidate = await chrome.runtime.sendMessage({ type: "GET_PENDING_LEARNING" });
    if (candidate) showLearningBanner(candidate);
  } catch {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TASK_EVENT") {
    handleTaskEvent(msg);
  }

  if (msg.type === "TASK_PAUSED") {
    addLogEntry("Paused before a submit-like click — waiting for your confirmation.");
    showPauseBanner(msg);
  }

  if (msg.type === "TASK_NEEDS_ANSWER") {
    addLogEntry(`Asking: "${msg.question}"`);
    showAskBanner(msg);
  }

  if (msg.type === "TASK_LEARNING_SUGGESTION") {
    showLearningBanner(msg.candidate || {});
  }

  if (msg.type === "PROFILE_DATA_SYNCED") {
    addLogEntry("Profile data synced — the next Autofill uses your latest saved values.", "autofill");
  }
});

learnBtn.addEventListener("click", async () => {
  const { next } = await chrome.runtime.sendMessage({ type: "CONFIRM_LEARN_VALUE" });
  addLogEntry("Saved to your structured profile for future applications.", "autofill");
  // Phase 15 fix: approving one queued suggestion used to silently drop
  // any others waiting behind it (pendingLearning was a single object,
  // not a queue) - now the next one (if any) shows immediately instead of
  // vanishing.
  if (next) showLearningBanner(next);
  else hideLearningBanner();
});

dismissLearnBtn.addEventListener("click", async () => {
  const { next } = await chrome.runtime.sendMessage({ type: "DISMISS_LEARN_VALUE" });
  if (next) showLearningBanner(next);
  else hideLearningBanner();
});

function handleTaskEvent(msg) {
  if (msg.kind === "started") {
    currentTaskRunId = msg.runId;
    setState("Discovering");
    return;
  }
  if (msg.kind === "autofill") {
    addLogEntry(`⚡ Instantly filled ${msg.filledCount} field(s) from your profile — no AI call needed.`, "autofill");
    setState("Autofilling");
    stats.completed += msg.filledCount || 0;
    renderStats();
    return;
  }
  if (msg.kind === "remembered") {
    addLogEntry(`🧠 Reused remembered answer for "${msg.fieldLabel}": ${msg.value}`, "autofill");
    return;
  }
  if (msg.kind === "skip-llm") {
    addLogEntry(`⚡ ${msg.reason}`, "autofill");
    return;
  }
  if (msg.kind === "action-rejected") {
    addLogEntry(`🛑 Rejected an invalid action (${msg.action?.type || "?"}${msg.action?.targetId ? " " + msg.action.targetId : ""}): ${msg.reason}`);
    stats.warnings += 1;
    renderStats();
    return;
  }
  if (msg.kind === "thinking") {
    setState("Thinking");
    stats.llmCalls += 1;
    renderStats();
    return;
  }
  if (msg.kind === "self-correct") {
    addLogEntry(`↻ ${msg.reason}`);
    return;
  }
  if (msg.kind === "dropdown") {
    const status = msg.verified ? "✅ selected" : "↻ not yet resolved";
    addLogEntry(`⌵ ${msg.field.split("|")[0] || "dropdown"} — attempt ${msg.attempt}: ${status}`, msg.verified ? "autofill" : undefined);
    return;
  }
  if (msg.kind === "blocked-placeholder") {
    addLogEntry(`🛑 ${msg.reasoning} — field left blank, fill it manually.`);
    stats.warnings += 1;
    renderStats();
    return;
  }
  if (msg.kind === "verify-failed") {
    const attemptNote = msg.exhausted ? ` (tried ${msg.attempts} strategies, all failed)` : "";
    addLogEntry(`⚠ ${msg.targetId || "action"} didn't verify: ${msg.reason || "unexpected result"}${attemptNote}`);
    // Not counted toward Completed/Failed here - "round-results" below is
    // the single source of truth for those two totals, precisely to
    // avoid double-counting the same underlying result against two
    // different counters. A non-exhausted failure (still mid-recovery)
    // is a soft warning, not a final failure yet.
    if (!msg.exhausted) {
      stats.warnings += 1;
      renderStats();
    }
    return;
  }
  if (msg.kind === "recovered") {
    addLogEntry(`↻ ${msg.targetId || "action"} succeeded on retry (attempt ${msg.attempts})`, "autofill");
    stats.recoveries += 1;
    renderStats();
    return;
  }
  if (msg.kind === "round-results") {
    stats.completed += msg.verifiedCount || 0;
    stats.failed += msg.failedCount || 0;
    renderStats();
    return;
  }
  if (msg.kind === "submission-verified") {
    addLogEntry(
      msg.verified ? "✅ Submission verified - the page confirms it went through." : "⚠ Submission attempted, but success could not be verified - check the page directly.",
      msg.verified ? "autofill" : undefined
    );
    // The ONLY place "Submitted" is ever set - straight from a verified
    // outcome, never from clicking Confirm or a run simply finishing
    // without an error. An unverified attempt maps to "Failed" here
    // rather than a softer in-between state, since the badge only has
    // the states in the original spec to work with - the nuanced "could
    // not be verified, check manually" wording still lives in the log
    // line above, nothing is lost, just not repeated in two words.
    setState(msg.verified ? "Submitted" : "Failed");
    return;
  }
  if (msg.kind === "round" && Array.isArray(msg.actions)) {
    setState("Executing");
    for (const action of msg.actions) {
      addLogEntry(
        `Round ${msg.round + 1}: ${action.type}${action.targetId ? " " + action.targetId : ""} — ${action.reasoning || ""}`
      );
    }
  }
  // These three kinds existed in background.js's onEvent calls but had no
  // matching branch here at all - not a crash (an unmatched kind is just
  // silently ignored), but real diagnostic signal that only ever reached
  // the exported record log, never the live popup a person is actually
  // watching during a run.
  if (msg.kind === "done-rejected") {
    addLogEntry(`↻ ${msg.reason}`);
    stats.warnings += 1;
    renderStats();
    return;
  }
  if (msg.kind === "transition") {
    if (msg.timedOut) {
      addLogEntry(`⚠ Clicked Continue/Next but no page change was detected within the wait window.`);
      stats.warnings += 1;
      renderStats();
    } else if (msg.urlChanged || msg.domChanged) {
      addLogEntry(`→ Page transition detected${msg.urlChanged ? " (URL changed)" : " (new fields loaded)"}.`, "autofill");
    }
    return;
  }
  if (msg.kind === "low-confidence") {
    for (const a of msg.actions || []) {
      addLogEntry(`⚠ Low-confidence fill on ${a.targetId} (${Math.round((a.confidence || 0) * 100)}%): ${a.reasoning || ""}`);
    }
    return;
  }
}

submitAnswerBtn.addEventListener("click", async () => {
  if (!activeAnswerRunId) return;
  const value = askInput.value.trim();
  if (!value) return;
  await chrome.runtime.sendMessage({ type: "ANSWER_PROVIDED", runId: activeAnswerRunId, value });
  addLogEntry(`Answered — continuing.`);
  hideAskBanner();
});

skipAnswerBtn.addEventListener("click", async () => {
  if (!activeAnswerRunId) return;
  await chrome.runtime.sendMessage({ type: "SKIP_ANSWER", runId: activeAnswerRunId });
  addLogEntry(`Skipped that field — continuing.`);
  hideAskBanner();
});

askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAnswerBtn.click();
});

confirmBtn.addEventListener("click", async () => {
  if (!activeRunId) return;
  await chrome.runtime.sendMessage({ type: "RESUME_TASK", runId: activeRunId });
  addLogEntry("Confirmed — continuing.");
  hidePauseBanner();
  // "Submitting" is honest here - it reflects "the confirmed click is now
  // running," not "it succeeded." The badge only ever advances to
  // Submitted/Failed once the real submission-verified event arrives.
  setState("Submitting");
});

cancelBtn.addEventListener("click", async () => {
  if (!activeRunId) return;
  await chrome.runtime.sendMessage({ type: "CANCEL_TASK", runId: activeRunId });
  addLogEntry("Stopped — nothing was submitted.");
  hidePauseBanner();
  setRunning(false);
  setState("Stopped");
});

stopBtn.addEventListener("click", async () => {
  if (!currentTaskRunId) return;
  await chrome.runtime.sendMessage({ type: "STOP_TASK", runId: currentTaskRunId });
  addLogEntry("Stop requested — finishing the current step and halting.");
  hidePauseBanner();
  hideAskBanner();
  setRunning(false);
  setState("Stopped");
});

async function reviewRequiredFields() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_FORM_STATUS" });
    if (status.error) return;
    statEls.remaining.textContent = status.count ?? "—";
    if (!status.count) {
      addLogEntry("No empty native required fields detected.", "autofill");
      return;
    }
    const labels = status.missing.slice(0, 6).map((field) => field.label).join(" · ");
    const suffix = status.count > 6 ? ` (+${status.count - 6} more)` : "";
    addLogEntry(`Review: ${status.count} required field(s) still need attention — ${labels}${suffix}`);
  } catch {
    // Advisory only: do not hide the actual run result if a site blocks inspection.
  }
}

async function runTask(task) {
  log.innerHTML = "";
  hidePauseBanner();
  hideAskBanner();
  setRunning(true);
  setState("Discovering");
  resetStats();
  refreshCurrentSite();

  try {
    const result = await chrome.runtime.sendMessage({ type: "RUN_TASK", task, useSmartAutofill: true });
    const callsNote =
      result.llmCallsMade !== undefined
        ? ` (${result.llmCallsMade} LLM call${result.llmCallsMade === 1 ? "" : "s"} used)`
        : "";
    await reviewRequiredFields();
    addLogEntry(result.ok ? `✅ Done: ${result.summary}${callsNote}` : `Stopped: ${result.summary}${callsNote}`);
    // A run can finish "ok" without ever submitting anything (autofill
    // completed, nothing left to do, no submit-like button was ever
    // encountered) - that's a real, good outcome, but it is NOT
    // "Submitted." Only the submission-verified event (handled in
    // handleTaskEvent above) is allowed to set that state. Everything
    // else lands back on a neutral Idle rather than borrowing a state
    // that would overclaim what actually happened.
    if (result.submitted === undefined) setState(result.ok ? "Idle" : "Failed");
  } catch (err) {
    addLogEntry(`Error: ${err.message}`);
    setState("Failed");
  } finally {
    setRunning(false);
    hidePauseBanner();
    hideAskBanner();
    currentTaskRunId = null;
  }
}

reviewBtn.addEventListener("click", reviewRequiredFields);

autofillBtn.addEventListener("click", () => {
  runTask("Fill out this job application form completely and accurately using the profile data.");
});

runBtn.addEventListener("click", () => {
  const task = taskInput.value.trim();
  if (!task) return;
  runTask(task);
});

advancedToggle.addEventListener("click", () => {
  const isOpen = advancedSection.style.display === "block";
  advancedSection.style.display = isOpen ? "none" : "block";
  advancedToggle.textContent = isOpen ? "Custom instruction instead ▾" : "Custom instruction instead ▴";
});

document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const recordModeCheckbox = document.getElementById("recordMode");

async function loadRecordModeState() {
  const { recordMode } = await chrome.storage.local.get(["recordMode"]);
  recordModeCheckbox.checked = !!recordMode;
}

recordModeCheckbox.addEventListener("change", async () => {
  await chrome.storage.local.set({ recordMode: recordModeCheckbox.checked });
});

document.getElementById("exportLog").addEventListener("click", async () => {
  const recordLog = await chrome.runtime.sendMessage({ type: "GET_RECORD_LOG" });
  if (!recordLog || recordLog.length === 0) {
    addLogEntry("Nothing recorded yet — turn on Record mode and run a task first.");
    return;
  }
  const blob = new Blob([JSON.stringify(recordLog, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `browser-agent-log-${Date.now()}.json` }, () => {
    URL.revokeObjectURL(url);
  });
});

document.getElementById("clearLog").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_RECORD_LOG" });
  addLogEntry("Record log cleared.");
});

loadRecordModeState();
rehydratePendingAction();

const exportTrackerBtn = document.getElementById("export-tracker-btn");
if (exportTrackerBtn) {
  exportTrackerBtn.addEventListener("click", async () => {
    const { appliedJobs = [] } = await chrome.storage.local.get(["appliedJobs"]);
    if (appliedJobs.length === 0) {
      addLogEntry("No applications tracked yet.", "autofill");
      return;
    }
    let csv = "Date,Company,Title,URL\n";
    for (const job of appliedJobs) {
      csv += `"${job.date}","${job.company}","${job.title}","${job.url}"\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url: url,
      filename: "job_applications.csv",
      saveAs: true
    });
  });
}
