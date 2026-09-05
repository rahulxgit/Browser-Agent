const modeSelect = document.getElementById("mode");
const anthropicFields = document.getElementById("anthropicFields");
const geminiFields = document.getElementById("geminiFields");
const gatewayFields = document.getElementById("gatewayFields");
const modelSection = document.getElementById("modelSection");
const apiKeyAnthropicInput = document.getElementById("apiKeyAnthropic");
const apiKeyGeminiInput = document.getElementById("apiKeyGemini");
const gatewayUrlInput = document.getElementById("gatewayUrl");
const taskTypeSelect = document.getElementById("taskType");
const modelInput = document.getElementById("model");
const modelHint = document.getElementById("modelHint");
const profileDataInput = document.getElementById("profileData");
const completeDatasetInput = document.getElementById("completeDataset");
const learnedProfileInput = document.getElementById("learnedProfile");
const pauseBeforeSubmitCheckbox = document.getElementById("pauseBeforeSubmit");
const status = document.getElementById("status");

const MODEL_DEFAULTS = {
  gemini: {
    placeholder: "gemini-3.5-flash-lite",
    hint: "Free tier. gemini-3.5-flash-lite is the fastest/cheapest and fits this kind of step-by-step automation well; gemini-3.6-flash is stronger if it struggles on a page."
  },
  anthropic: {
    placeholder: "claude-sonnet-4-6",
    hint: "Paid per token via your Anthropic account."
  }
};

function toggleFields() {
  const mode = modeSelect.value;
  anthropicFields.style.display = mode === "anthropic" ? "block" : "none";
  geminiFields.style.display = mode === "gemini" ? "block" : "none";
  gatewayFields.style.display = mode === "gateway" ? "block" : "none";
  // Gateway routes by taskType, not a model string, so the model field
  // isn't relevant there at all - hide it instead of showing a dead field.
  modelSection.style.display = mode === "gateway" ? "none" : "block";

  if (mode !== "gateway") {
    const defaults = MODEL_DEFAULTS[mode];
    modelInput.placeholder = defaults.placeholder;
    modelHint.textContent = defaults.hint;
    modelHint.classList.remove("warning");
  }
  checkReasoningModelWarning();
}

// Reasoning/"thinking" models frequently narrate their reasoning in prose
// ("Let me analyze the task...") instead of returning bare JSON, which
// this extension's action-batch parser can't use - it burns the self-
// correction retries and can fail the whole run (seen live against a
// reasoning model in a captured record log). This can't be fixed
// server-side since it's inherent to how those models respond, so the
// most honest fix is warning the person before they hit it, not silently
// eating the failure at runtime. Matched by name pattern only - a soft,
// non-blocking warning, not a hard block, since some reasoning models do
// follow strict-JSON instructions fine and the self-correction retry may
// still recover it.
const REASONING_MODEL_PATTERN = /(^|[-_.])(thinking|reasoning|o1|o3|o4)([-_.]|$)/i;

function checkReasoningModelWarning() {
  const mode = modeSelect.value;
  if (mode === "gateway") return; // gateway routes by taskType, not a model string - nothing to check
  const typed = modelInput.value.trim();
  if (!typed) return; // still on the placeholder default, not a real concern
  if (REASONING_MODEL_PATTERN.test(typed)) {
    modelHint.textContent =
      "⚠ This looks like a reasoning/\"thinking\" model. Those often narrate their answer as prose " +
      "instead of returning plain JSON, which can make autofill fail or need extra retries. " +
      `A non-thinking model (e.g. ${MODEL_DEFAULTS[mode].placeholder}) is more reliable for this step-by-step task.`;
    modelHint.classList.add("warning");
  } else {
    modelHint.textContent = MODEL_DEFAULTS[mode].hint;
    modelHint.classList.remove("warning");
  }
}

modelInput.addEventListener("input", checkReasoningModelWarning);

modeSelect.addEventListener("change", toggleFields);

async function load() {
  const stored = await chrome.storage.local.get([
    "provider",
    "gatewayUrl",
    "model",
    "taskType",
    "profileData",
    "pauseBeforeSubmit"
  ]);
  const session = await (chrome.storage.session || chrome.storage.local).get(["apiKey"]);

  const provider = stored.provider || "gemini";
  modeSelect.value = provider;

  if (provider === "anthropic") {
    apiKeyAnthropicInput.value = session.apiKey || "";
  } else if (provider === "gemini") {
    apiKeyGeminiInput.value = session.apiKey || "";
  }

  gatewayUrlInput.value = stored.gatewayUrl || "";
  taskTypeSelect.value = stored.taskType || "reasoning";
  modelInput.value = stored.model || "";
  profileDataInput.value = stored.profileData || "";
  try {
    const completeDataset = await chrome.runtime.sendMessage({ type: "GET_COMPLETE_DATASET" });
    completeDatasetInput.value = JSON.stringify(completeDataset, null, 2);
  } catch {
    completeDatasetInput.value = "";
  }
  // Default ON - only respect an explicit false, matching background.js.
  pauseBeforeSubmitCheckbox.checked = stored.pauseBeforeSubmit !== false;
  try {
    const learnedProfile = await chrome.runtime.sendMessage({ type: "GET_LEARNED_PROFILE" });
    learnedProfileInput.value = JSON.stringify(learnedProfile || {}, null, 2);
  } catch {
    learnedProfileInput.value = "";
  }
  toggleFields();
}

function readJsonObjectField(textarea, fieldName) {
  const raw = textarea.value.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed;
}

function flashStatus(text, isError) {
  status.textContent = text;
  status.classList.toggle("error", !!isError);
  if (!isError) setTimeout(() => (status.textContent = ""), 2000);
}

document.getElementById("saveCompleteDataset").addEventListener("click", async () => {
  try {
    const value = readJsonObjectField(completeDatasetInput, "Complete profile dataset");
    completeDatasetInput.classList.remove("invalid");
    await chrome.runtime.sendMessage({ type: "SAVE_COMPLETE_DATASET", value });
    flashStatus("Dataset saved.");
  } catch (err) {
    completeDatasetInput.classList.add("invalid");
    flashStatus(`Complete profile dataset isn't valid JSON: ${err.message}`, true);
  }
});

document.getElementById("resetCompleteDataset").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "RESET_COMPLETE_DATASET" });
  completeDatasetInput.value = JSON.stringify(result.value || {}, null, 2);
  completeDatasetInput.classList.remove("invalid");
  flashStatus("Reset to the packaged default.");
});

document.getElementById("saveLearnedProfile").addEventListener("click", async () => {
  try {
    const value = readJsonObjectField(learnedProfileInput, "Learned profile data");
    learnedProfileInput.classList.remove("invalid");
    await chrome.runtime.sendMessage({ type: "SAVE_LEARNED_PROFILE", value });
    flashStatus("Learned data saved.");
  } catch (err) {
    learnedProfileInput.classList.add("invalid");
    flashStatus(`Learned profile data isn't valid JSON: ${err.message}`, true);
  }
});

document.getElementById("exportAll").addEventListener("click", async () => {
  const data = await chrome.runtime.sendMessage({ type: "EXPORT_ALL_PROFILE_DATA" });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `browser-agent-profile-backup-${Date.now()}.json` }, () => {
    URL.revokeObjectURL(url);
  });
  flashStatus("Exported.");
});

document.getElementById("importFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await chrome.runtime.sendMessage({ type: "IMPORT_ALL_PROFILE_DATA", value: data });
    flashStatus("Imported - reloading fields.");
    await load();
  } catch (err) {
    flashStatus(`Could not import that file: ${err.message}`, true);
  } finally {
    event.target.value = "";
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.learnedProfile) return;
  learnedProfileInput.value = JSON.stringify(changes.learnedProfile.newValue || {}, null, 2);
});

document.getElementById("save").addEventListener("click", async () => {
  const mode = modeSelect.value;
  const rawProfileData = profileDataInput.value.trim();

  let profileDataToStore = "";
  if (rawProfileData) {
    try {
      const parsed = JSON.parse(rawProfileData);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Profile data must be a JSON object");
      }
      profileDataToStore = JSON.stringify(parsed, null, 2);
    } catch (err) {
      profileDataInput.classList.add("invalid");
      status.textContent = `Profile data isn't valid JSON: ${err.message}`;
      status.classList.add("error");
      return;
    }
  }
  profileDataInput.classList.remove("invalid");


  let apiKey = "";
  if (mode === "anthropic") apiKey = apiKeyAnthropicInput.value.trim();
  if (mode === "gemini") apiKey = apiKeyGeminiInput.value.trim();

  if (mode !== "gateway" && !apiKey) {
    status.textContent = "Add your API key before saving.";
    status.classList.add("error");
    return;
  }
  if (mode === "gateway" && !gatewayUrlInput.value.trim()) {
    status.textContent = "Add your gateway URL before saving.";
    status.classList.add("error");
    return;
  }
  if (mode === "gateway" && !/^https?:\/\//i.test(gatewayUrlInput.value.trim())) {
    status.textContent = "Gateway URL must start with http:// or https://";
    status.classList.add("error");
    gatewayUrlInput.classList.add("invalid");
    return;
  }
  gatewayUrlInput.classList.remove("invalid");

  if (mode === "gateway") {
    const gateway = new URL(gatewayUrlInput.value.trim());
    const originPattern = `${gateway.protocol}//${gateway.hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      status.textContent = "Allow access to this gateway to use it.";
      status.classList.add("error");
      return;
    }
  }

  await chrome.storage.local.set({
    provider: mode,
    gatewayUrl: mode === "gateway" ? gatewayUrlInput.value.trim().replace(/\/+$/, "") : "",
    taskType: taskTypeSelect.value,
    model: modelInput.value.trim(),
    profileData: profileDataToStore,
    pauseBeforeSubmit: pauseBeforeSubmitCheckbox.checked
  });
  await (chrome.storage.session || chrome.storage.local).set({ apiKey: mode === "gateway" ? "" : apiKey });

  status.classList.remove("error");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});

profileDataInput.addEventListener("input", () => {
  profileDataInput.classList.remove("invalid");
  if (status.classList.contains("error")) status.textContent = "";
});


load();
