// --- Provider layer (Phase 16), extracted from background.js (Phase 21) ---
// Loaded into background.js's global scope via importScripts() at the top
// of that file - this is a classic (non-module) MV3 service worker, so
// importScripts is the correct, zero-risk way to split it: every function
// declared here becomes directly callable from background.js exactly as
// if it were still in that file, with no call-site changes needed anywhere.
// Self-contained on purpose - no dependency on background.js's run-loop
// state (abortedRuns, pendingConfirmations, etc), only on its own inputs.

// --- Provider layer (Phase 16) ------------------------------------------
// Previously: one retry helper that retried EVERYTHING blindly (including
// a 401 bad API key or a 400 malformed request - retrying those three
// times just burns three round-trips to fail exactly the same way every
// time), no request timeout at all (a hung fetch would block the whole
// round indefinitely), and no way to cancel an in-flight call when the
// user hits Stop mid-request - abortRun() only took effect at the top of
// the NEXT round. All three fixed here, plus a single consistent
// generate({systemPrompt, userMessage, model, signal, timeoutMs})
// interface across all three providers instead of three different
// call signatures.

// Combines an external cancellation signal (tied to the run's Stop button)
// with an internal timeout into one AbortSignal fetch can use. Written by
// hand rather than relying on AbortSignal.any() - that's Chrome 116+, and
// this extension's manifest floor is Chrome 114.
function combineSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    wasTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  };
}

// Classifies an HTTP error response into retryable vs not, and reads
// Retry-After when the server provided one instead of guessing our own
// backoff for something the server already told us the wait time for.
// Auth/malformed-request errors are explicitly NOT retryable - the doc's
// "do NOT blindly retry authentication errors or invalid requests" as a
// hard rule, not a suggestion: retrying a bad API key three times just
// delays reporting the real problem by three round-trips.
async function classifyHttpError(res, providerName) {
  const bodyText = await res.text().catch(() => "");
  const err = new Error(`${providerName} API error ${res.status}: ${bodyText.slice(0, 300)}`);
  err.status = res.status;

  if (res.status === 401 || res.status === 403) {
    err.retryable = false;
    err.message = `${providerName} authentication failed (${res.status}) - check the API key in settings. Not retrying.`;
  } else if (res.status === 400 || res.status === 404 || res.status === 422) {
    err.retryable = false;
    err.message = `${providerName} rejected the request (${res.status}) - this looks like a malformed request, not a transient issue: ${bodyText.slice(0, 200)}`;
  } else if (res.status === 429) {
    err.retryable = true;
    const retryAfter = res.headers.get("retry-after");
    const parsedSeconds = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(parsedSeconds)) err.retryAfterMs = parsedSeconds * 1000;
    err.message = `${providerName} rate limit hit (429).`;
  } else if (res.status >= 500) {
    err.retryable = true;
    err.message = `${providerName} server error (${res.status}) - likely transient.`;
  } else {
    err.retryable = true; // unrecognized status - default to retryable rather than silently giving up early
  }
  return err;
}

async function withRetry(fn, { retries = 4, baseDelayMs = 1500, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = normalizeFetchError(err);
      // A cancelled run must stop immediately, not retry into a 4th
      // attempt after the person already clicked Stop.
      if (lastError.cancelled) throw lastError;
      // retryable defaults to true for anything that didn't go through
      // classifyHttpError (e.g. a raw network TypeError) - only an
      // explicit false (auth/malformed-request) skips retrying.
      if (attempt >= retries || lastError.retryable === false) {
        // Previously the final thrown error kept whatever bare message
        // classifyHttpError/normalizeFetchError produced (e.g. just
        // "Request timed out."), giving no indication in the record log
        // of whether this was the FIRST attempt failing outright (likely
        // a config problem - bad key, wrong URL) or the LAST of several
        // retries (a genuinely overloaded/slow provider). Both looked
        // identical in the run_end summary. This appends exactly how many
        // attempts were actually made so the two cases are distinguishable
        // without needing Record mode's full round-by-round detail.
        const attemptsMade = attempt + 1;
        if (attemptsMade > 1) {
          lastError.message = `${lastError.message} (failed after ${attemptsMade} attempts)`;
        }
        throw lastError;
      }
      const delay = lastError.retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);
      // Previously this whole loop was silent - a slow/overloaded
      // provider (the exact case behind a "Request timed out." run_end)
      // could leave the UI showing nothing at all for minutes while up to
      // 4 attempts x 60s timeouts plus backoff ran in the background. The
      // person had no way to tell "still working" from "hung". This
      // surfaces each retry as it happens so the record log and any
      // listening UI can show real progress instead of dead air.
      onRetry?.({ attempt: attempt + 1, maxAttempts: retries + 1, delayMs: delay, reason: lastError.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function normalizeFetchError(err) {
  if (err?.name === "AbortError") {
    // Distinguishes "the run was cancelled" from "our own timeout fired" -
    // the caller needs to know which, since a cancellation should stop
    // the whole run outright while a timeout is just a retryable failure.
    const timedOut = err.__timedOut === true;
    const normalized = new Error(timedOut ? "Request timed out." : "Request cancelled.");
    normalized.retryable = timedOut;
    normalized.cancelled = !timedOut;
    return normalized;
  }
  if (err instanceof TypeError && /failed to fetch/i.test(err.message)) {
    const normalized = new Error(
      "Network request failed before getting a response. Common causes: " +
        "the server is asleep/cold-starting (Render free tier sleeps after " +
        "inactivity - try opening the URL directly in a tab first to wake it), " +
        "the URL is wrong, or there's no internet connection."
    );
    normalized.retryable = true;
    return normalized;
  }
  return err;
}

const DEFAULT_TIMEOUT_MS = 60000;

async function callGemini({ apiKey, model, systemPrompt, userMessage, signal, screenshot, timeoutMs = DEFAULT_TIMEOUT_MS, onRetry }) {
  const geminiModel = model && model.trim() ? model.trim() : "gemini-1.5-pro-latest";

  return withRetry(async () => {
    const combined = combineSignal(signal, timeoutMs);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: screenshot ? [{ text: userMessage }, { inline_data: { mime_type: "image/jpeg", data: screenshot.split(",")[1] } }] : [{ text: userMessage }] }],
            generationConfig: { maxOutputTokens: 1200 }
          }),
          signal: combined.signal
        }
      ).catch((err) => {
        if (err.name === "AbortError") err.__timedOut = combined.wasTimeout();
        throw err;
      });

      if (!res.ok) throw await classifyHttpError(res, "Gemini");

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const err = new Error(`Unrecognized Gemini response shape: ${JSON.stringify(data).slice(0, 200)}`);
        err.retryable = false; // a malformed-but-200 response won't fix itself on retry
        throw err;
      }
      return text;
    } finally {
      combined.cleanup();
    }
  }, { onRetry });
}

async function callAnthropic({ apiKey, model, systemPrompt, userMessage, signal, timeoutMs = DEFAULT_TIMEOUT_MS, onRetry }) {
  return withRetry(async () => {
    const combined = combineSignal(signal, timeoutMs);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }]
        }),
        signal: combined.signal
      }).catch((err) => {
        if (err.name === "AbortError") err.__timedOut = combined.wasTimeout();
        throw err;
      });

      if (!res.ok) throw await classifyHttpError(res, "Anthropic");

      const data = await res.json();
      const textBlock = data.content.find((b) => b.type === "text");
      return textBlock ? textBlock.text : "";
    } finally {
      combined.cleanup();
    }
  }, { onRetry });
}

async function callGateway({ gatewayUrl, taskType, systemPrompt, userMessage, signal, timeoutMs = DEFAULT_TIMEOUT_MS, onRetry }) {
  return withRetry(async () => {
    const combined = combineSignal(signal, timeoutMs);
    try {
      const res = await fetch(`${gatewayUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: taskType || "reasoning",
          messages: [{ role: "user", content: `${systemPrompt}\n\n---\n\n${userMessage}` }]
        }),
        signal: combined.signal
      }).catch((err) => {
        if (err.name === "AbortError") err.__timedOut = combined.wasTimeout();
        throw err;
      });

      if (!res.ok) throw await classifyHttpError(res, "Gateway");

      const data = await res.json();
      if (typeof data.content !== "string") {
        const err = new Error(`Unrecognized gateway response shape: ${JSON.stringify(data).slice(0, 200)}`);
        err.retryable = false;
        throw err;
      }
      return data.content;
    } finally {
      combined.cleanup();
    }
  }, { onRetry });
}

// One consistent entry point regardless of provider - callModel no longer
// needs to know each provider's distinct argument order, just this shape.
async function callModel(settings, systemPrompt, userMessage, signal, screenshot, onRetry) {
  const request = { systemPrompt, userMessage, signal, screenshot, timeoutMs: settings.llmTimeoutMs || DEFAULT_TIMEOUT_MS, onRetry };
  if (settings.provider === "gateway") {
    return callGateway({ ...request, gatewayUrl: settings.gatewayUrl, taskType: settings.taskType });
  }
  if (settings.provider === "gemini") {
    return callGemini({ ...request, apiKey: settings.apiKey, model: settings.model });
  }
  return callAnthropic({ ...request, apiKey: settings.apiKey, model: settings.model });
}
