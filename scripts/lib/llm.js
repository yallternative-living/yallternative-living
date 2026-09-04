/**
 * @fileoverview The shared LLM client for this repo's automation bots. One
 * `fetch` against an OpenAI-shaped `/chat/completions` endpoint with
 * JSON-schema structured output, plus the four things every unattended caller
 * needs and nobody should write twice: retries with backoff, a pinned-model to
 * rolling-alias fallback that reports itself loudly, a per-run call cap, and a
 * deterministic offline `mock` provider.
 *
 * THE API, which is deliberately small:
 *
 *   const client = llm.createClient({ provider, models, apiKey, baseUrl,
 *                                     maxCalls, timeoutMs, maxRetries });
 *   const obj = await client.completeJSON({ system, user, schema, schemaName,
 *                                           temperature });
 *   client.callsRemaining();   // integer; 0 means the cap is spent
 *   client.fallbackWarning();  // null, or the sentence a human must read
 *   client.telemetry;          // {provider, model, calls, retries, modelFallbacks}
 *
 * `completeJSON` returns the PARSED object the schema describes, or throws.
 * The one error a caller must handle specially carries `code === "LLM_CALL_CAP"`:
 * it means the run has spent its budget and should stop at a clean boundary,
 * not that anything went wrong.
 *
 * ENVIRONMENT. Provider defaults come from `LLM_PROVIDER`, `LLM_MODELS`,
 * `LLM_BASE_URL`, `LLM_MAX_CALLS`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, and the
 * key from the provider's own variable (`GEMINI_API_KEY`, `GROQ_API_KEY`). The
 * names are neutral because more than one bot uses this; a caller with its own
 * convention (the i18n bot reads `I18N_MODELS`) passes the value as an option
 * and the environment is only the fallback.
 *
 * WHY ONE WRAPPER FOR TWO VENDORS. Google exposes Gemini through an
 * OpenAI-compatible endpoint (https://generativelanguage.googleapis.com/v1beta/openai/,
 * `Authorization: Bearer`, chat completions plus `response_format`), and Groq's
 * API is OpenAI-shaped natively. So switching vendors is a base URL and a model
 * id -- two environment variables -- rather than a second client.
 *
 * MODELS ARE A LIST, NOT A STRING. The first entry is the one we mean: today
 * `gemini-3.8-flash`, pinned, because a pinned id is the only way to know what
 * produced a given commit. The last entry is the rolling alias
 * `gemini-flash-latest`, which Google documents as "the latest release for a
 * specific model variation ... hot-swapped with every new release". The alias
 * exists for exactly one purpose: the day the pinned id is retired, the bot
 * keeps working instead of dying on a 404.
 *
 * The alias is NOT a free upgrade, and this file treats it as a degraded mode.
 * It can be hot-swapped to a preview release whose register and length
 * behaviour differ from whatever the current output was authored against, so
 * every fallback is recorded in `telemetry.modelFallbacks` and
 * `fallbackWarning()` renders it in the imperative: re-pin. Callers are
 * expected to print it in their run summary and put it on their tracking issue.
 * Deterministic post-checks are the safety net either way -- they do not care
 * which model wrote the string.
 *
 * FAILURE HANDLING, and the reasoning behind each choice:
 *
 *   - 429, 408 and 5xx are retried with exponential backoff and jitter. They
 *     are transient by definition, and these workloads are tens of requests a
 *     run -- orders of magnitude inside either free tier.
 *   - Any other 4xx is NOT retried against the same model. A 400/404 on a model
 *     id means that id is gone or misspelled; retrying it burns the run. The
 *     next model in the list is tried instead, and if it works the run
 *     continues on it and says so.
 *   - A model that has fallen through stays fallen through for the rest of the
 *     run. Re-probing a retired id 50 times turns one clear failure into 50
 *     slow ones.
 *   - The key is never logged, never interpolated into a URL and never echoed
 *     in an error. GitHub's secret masking is explicitly best-effort ("because
 *     there are multiple ways a secret value can be transformed, this redaction
 *     is not guaranteed") and a Gemini/Groq key is not on its auto-redaction
 *     list, so the only safe assumption is that anything printed is public.
 *
 * THE MOCK PROVIDER is not a stub for tests to nod at: it runs a caller's whole
 * pipeline end to end with no key and no network, which is how the CI dry run
 * and the offline proof runs work. Its default responder handles the
 * batch-of-strings shape (`{locale, items:[{id, text}]}` in, `{items:[{id,
 * text}]}` out) and marks every value "[locale] ..." so a mock result can never
 * be mistaken for a shippable one in a diff. A caller with a different payload
 * shape passes its own `mockResponder`.
 */

const PROVIDERS = {
  gemini: {
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.8-flash", "gemini-flash-latest"],
    keyEnv: "GEMINI_API_KEY"
  },
  groq: {
    base: "https://api.groq.com/openai/v1",
    models: ["qwen/qwen3.8-27b"],
    keyEnv: "GROQ_API_KEY"
  },
  /* Vertex AI in express mode: a Google Cloud API key (restricted to the
     Vertex AI API) on a billing-enabled project, so usage lands on the Cloud
     bill where Google Cloud credits apply -- AI Studio keys bill through a
     separate pipeline those credits cannot touch (Gemini API billing docs,
     2026-09-04). No project or location in the path; the key rides in the
     x-goog-api-key header. Speaks the native generateContent API rather than
     an OpenAI shim, so structured output is generationConfig.responseSchema. */
  vertex: {
    base: "https://aiplatform.googleapis.com/v1",
    models: ["gemini-3.8-flash", "gemini-3.5-flash"],
    keyEnv: "VERTEX_API_KEY",
    transport: "gemini-native"
  },
  mock: {
    base: null,
    models: ["mock-deterministic"],
    keyEnv: null
  }
};

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 3;
/* No cap by default (owner decision 2026-09-04: a real run needs ~50 calls
   and a retry storm should be bounded by the circuit breaker in the caller,
   not by a number that also stops honest work). Set LLM_MAX_CALLS /
   I18N_MAX_CALLS to put one back. */
const DEFAULT_MAX_CALLS = Infinity;

function splitList(value) {
  return String(value || "")
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

function firstNumber(values, fallback) {
  for (let i = 0; i < values.length; i++) {
    const n = Number(values[i]);
    if (values[i] !== undefined && values[i] !== null && values[i] !== "" && !Number.isNaN(n)) {
      return n;
    }
  }
  return fallback;
}

/**
 * The subset of JSON Schema that Vertex's `responseSchema` accepts: type,
 * properties, required, items, enum, description, nullable. Everything an
 * OpenAI-style strict schema adds (additionalProperties, $schema, strict) is
 * dropped rather than rejected by the API. Pure; the input is not mutated.
 */
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  Object.keys(schema).forEach(function (key) {
    if (key === "additionalProperties" || key === "$schema" || key === "strict") return;
    const value = schema[key];
    if (key === "properties" && value && typeof value === "object") {
      out.properties = {};
      Object.keys(value).forEach(function (name) {
        out.properties[name] = toGeminiSchema(value[name]);
      });
      return;
    }
    out[key] = key === "items" ? toGeminiSchema(value) : value;
  });
  return out;
}

/** Resolve provider id, base URL, model list and limits from options then env. */
function resolveConfig(options, env) {
  const opts = options || {};
  const e = env || {};
  const id = String(opts.provider || e.LLM_PROVIDER || "gemini").toLowerCase();
  const preset = PROVIDERS[id];
  if (!preset) {
    throw new Error(
      "Unknown provider " +
        JSON.stringify(id) +
        " -- expected one of " +
        Object.keys(PROVIDERS).join(", ")
    );
  }
  const requested = splitList(opts.models || e.LLM_MODELS);
  return {
    provider: id,
    base: String(opts.baseUrl || e.LLM_BASE_URL || preset.base || "").replace(/\/+$/, ""),
    models: requested.length ? requested : preset.models.slice(),
    keyEnv: preset.keyEnv,
    transport: preset.transport || "openai",
    apiKey: preset.keyEnv ? opts.apiKey || e[preset.keyEnv] || "" : "",
    maxCalls: firstNumber([opts.maxCalls, e.LLM_MAX_CALLS], DEFAULT_MAX_CALLS),
    timeoutMs: firstNumber([opts.timeoutMs, e.LLM_TIMEOUT_MS], DEFAULT_TIMEOUT_MS),
    maxRetries: firstNumber([opts.maxRetries, e.LLM_MAX_RETRIES], DEFAULT_MAX_RETRIES),
    /* Gemini 3.x thinking level: minimal | low | medium | high (the model's
       own default is medium). "high" by owner decision 2026-09-04 -- these
       are a few hundred short strings a month, and a translation that
       weighs a claim word is worth the thinking tokens. Set LLM_THINKING to
       "none" to send no thinking field at all. */
    thinking: String(opts.thinking || e.LLM_THINKING || "high").toLowerCase()
  };
}

function isRetryableStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** Exponential backoff with deterministic jitter, in milliseconds. */
function backoffMs(attempt, status) {
  const base = Math.min(30000, 1000 * Math.pow(2, attempt)) + attempt * 137;
  /* 503 "high demand" from Gemini's free tier clears in tens of seconds, not
     in one: wait noticeably longer before each retry of that one status. */
  return status === 503 ? base + 5000 * (attempt + 1) : base;
}

function defaultSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * The mock transform for one string. Deterministic, offline, and deliberately
 * conspicuous: it leaves every {placeholder} and every protected term exactly
 * where it found them, so its output satisfies the same literal-parity rules a
 * real translation has to. That is the point -- the mock proves the pipeline,
 * the post-checks and the writers, not the wording.
 *
 * LLM_MOCK_CORRUPT is a test hook and nothing else. When the source contains
 * that substring the mock drops the protected terms it was told to keep, which
 * is how a caller's reject-and-drop path is PROVED offline rather than asserted.
 */
function mockTranslate(text, locale, protectedTerms, env) {
  const corrupt = (env && (env.LLM_MOCK_CORRUPT || env.I18N_MOCK_CORRUPT)) || "";
  if (corrupt && String(text).indexOf(corrupt) !== -1) {
    let broken = String(text);
    (protectedTerms || [])
      .slice()
      .sort(function (a, b) {
        return String(b).length - String(a).length;
      })
      .forEach(function (term) {
        if (term && broken.indexOf(term) !== -1) broken = broken.split(term).join("XXX");
      });
    return "[" + locale + "] " + broken;
  }
  return "[" + locale + "] " + String(text);
}

/** The default mock responder: the batch-of-strings shape. */
function defaultMockResponder(spec, env) {
  const payload = JSON.parse(spec.user);
  return {
    items: (payload.items || []).map(function (item) {
      return {
        id: item.id,
        text: mockTranslate(item.text, payload.locale, spec.protectedTerms, env)
      };
    })
  };
}

function callCapError(maxCalls) {
  const err = new Error(
    "Per-run call cap of " +
      maxCalls +
      " reached -- stopping cleanly and leaving the rest for the next run."
  );
  err.code = "LLM_CALL_CAP";
  return err;
}

/**
 * Builds the client.
 *
 * @param {Object=} options provider / models / apiKey / baseUrl / maxCalls /
 *     timeoutMs / maxRetries, plus `fetchImpl`, `sleep` and `mockResponder` so
 *     a unit suite can drive every branch with no network and no real delay.
 * @param {Object=} env process.env by default.
 */
function createClient(options, env) {
  const environment = env || process.env;
  const cfg = resolveConfig(options, environment);
  const opts = options || {};
  const doFetch = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const sleep = opts.sleep || defaultSleep;
  const mockResponder = opts.mockResponder || defaultMockResponder;

  const telemetry = {
    provider: cfg.provider,
    model: cfg.models[0],
    calls: 0,
    retries: 0,
    modelFallbacks: []
  };
  let modelIndex = 0;
  let unavailable = null;

  if (cfg.provider !== "mock") {
    if (!cfg.apiKey) {
      throw new Error(
        "No API key: set " +
          cfg.keyEnv +
          " (or use provider 'mock', which needs no key and writes obviously-fake strings)."
      );
    }
    if (!doFetch) throw new Error("No global fetch available -- Node 18+ is required.");
    if (!cfg.base) throw new Error("No base URL resolved for provider " + cfg.provider);
  }

  /** The request for one transport: URL, headers and body. */
  function buildRequest(model, spec) {
    if (cfg.transport === "gemini-native") {
      return {
        url: cfg.base + "/publishers/google/models/" + model + ":generateContent",
        headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
        body: {
          systemInstruction: { parts: [{ text: spec.system }] },
          contents: [{ role: "user", parts: [{ text: spec.user }] }],
          generationConfig: Object.assign(
            {
              temperature: spec.temperature === undefined ? 0.2 : spec.temperature,
              responseMimeType: "application/json",
              responseSchema: toGeminiSchema(spec.schema)
            },
            cfg.thinking && cfg.thinking !== "none"
              ? { thinkingConfig: { thinkingLevel: cfg.thinking } }
              : {}
          )
        }
      };
    }
    return {
      url: cfg.base + "/chat/completions",
      headers: {
        "Content-Type": "application/json",
        /* The key rides in a header, never in the URL: a URL turns up in
           logs, redirects and error text that nothing masks. */
        Authorization: "Bearer " + cfg.apiKey
      },
      body: Object.assign(
        cfg.thinking && cfg.thinking !== "none" ? { reasoning_effort: cfg.thinking } : {},
        {
          model: model,
          messages: [
            { role: "system", content: spec.system },
            { role: "user", content: spec.user }
          ],
          temperature: spec.temperature === undefined ? 0.2 : spec.temperature,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: spec.schemaName || "structured_output",
              strict: true,
              schema: spec.schema
            }
          }
        }
      )
    };
  }

  /** The model's text out of either transport's response shape. */
  function contentOf(json) {
    if (cfg.transport === "gemini-native") {
      const cand = json && json.candidates && json.candidates[0];
      const parts = cand && cand.content && cand.content.parts;
      return Array.isArray(parts)
        ? parts
            .map(function (p) {
              return p && typeof p.text === "string" ? p.text : "";
            })
            .join("")
        : null;
    }
    return json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : null;
  }

  /** One HTTP attempt. Throws errors carrying {status, retryable}. */
  async function requestOnce(model, spec) {
    const req = buildRequest(model, spec);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(function () {
          controller.abort();
        }, cfg.timeoutMs)
      : null;
    try {
      const res = await doFetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) {
        /* The body may name the model or the quota, which is exactly what a
           maintainer needs, and never contains the key -- but truncate it so a
           provider that echoes the request cannot paste one into a log. */
        let detail = "";
        try {
          detail = String(await res.text()).slice(0, 400);
        } catch {
          detail = "";
        }
        /* A Google-style error body is {error:{status, message, details:[{reason}]}}.
           Fold it into one line -- "PERMISSION_DENIED (API_KEY_SERVICE_BLOCKED):
           Requests to this API ... are blocked." -- so a log, an issue row and a
           test assertion all get the reason without the raw JSON. */
        let compact = detail;
        let reason = "";
        try {
          const parsed = JSON.parse(detail);
          const e = Array.isArray(parsed) ? parsed[0] && parsed[0].error : parsed && parsed.error;
          if (e && (e.status || e.message)) {
            const info = (e.details || []).find(function (d) {
              return d && d.reason;
            });
            reason = info ? String(info.reason) : "";
            compact =
              String(e.status || "error") +
              (reason ? " (" + reason + ")" : "") +
              (e.message ? ": " + String(e.message).slice(0, 200) : "");
          }
        } catch {
          /* not JSON -- keep the truncated text */
        }
        const err = new Error(
          "HTTP " +
            res.status +
            " from " +
            cfg.provider +
            "/" +
            model +
            (compact ? ": " + compact : "")
        );
        err.status = res.status;
        err.reason = reason;
        err.retryable = isRetryableStatus(res.status);
        throw err;
      }
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One structured-output completion.
   *
   * @param {{system: string, user: string, schema: !Object,
   *          schemaName: (string|undefined), temperature: (number|undefined)}} spec
   * @return {!Promise<!Object>} the parsed object the schema describes.
   */
  async function completeJSON(spec) {
    /* A key that the provider has refused outright (401/403) will refuse the
       next call too. Burning the rest of the run's budget on it -- 51 calls,
       990 identical failures, one unreadable issue (dry run 2026-09-04) --
       helps nobody, so after every model has been refused the client stops
       calling and says so with one code the caller can act on. */
    if (unavailable) {
      const e = new Error("provider unavailable: " + unavailable.message);
      e.code = "LLM_PROVIDER_UNAVAILABLE";
      e.cause = unavailable;
      throw e;
    }
    if (telemetry.calls >= cfg.maxCalls) throw callCapError(cfg.maxCalls);

    if (cfg.provider === "mock") {
      telemetry.calls++;
      return mockResponder(spec, environment);
    }

    let lastError = null;
    while (modelIndex < cfg.models.length) {
      const model = cfg.models[modelIndex];
      for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        if (telemetry.calls >= cfg.maxCalls) throw callCapError(cfg.maxCalls);
        telemetry.calls++;
        try {
          const json = await requestOnce(model, spec);
          const content = contentOf(json);
          if (!content) throw new Error("Response carried no message content");
          telemetry.model = model;
          return JSON.parse(content);
        } catch (err) {
          lastError = err;
          const retryable = err && (err.retryable || err.name === "AbortError" || !err.status);
          if (retryable && attempt < cfg.maxRetries) {
            telemetry.retries++;
            await sleep(backoffMs(attempt, err && err.status));
            continue;
          }
          break;
        }
      }
      /* Out of retries on this model. If there is another id in the list, fall
         through to it permanently and record it loudly -- see the file header
         on why the rolling alias is a degraded mode, not an upgrade. */
      if (modelIndex + 1 < cfg.models.length) {
        telemetry.modelFallbacks.push({
          from: model,
          to: cfg.models[modelIndex + 1],
          error: lastError && lastError.message ? lastError.message : String(lastError)
        });
        modelIndex++;
        continue;
      }
      if (lastError && (lastError.status === 401 || lastError.status === 403)) {
        unavailable = lastError;
      }
      throw lastError || new Error("Provider request failed with no error recorded");
    }
    throw lastError || new Error("No models configured");
  }

  return {
    config: cfg,
    telemetry: telemetry,
    completeJSON: completeJSON,
    callsRemaining: function () {
      return Math.max(0, cfg.maxCalls - telemetry.calls);
    },
    /** Human-readable warning when a non-pinned model produced this run. */
    /** @return {?Error} the 401/403 that made the client stop calling, or null. */
    unavailable: function () {
      return unavailable;
    },
    fallbackWarning: function () {
      if (!telemetry.modelFallbacks.length) return null;
      return telemetry.modelFallbacks
        .map(function (f) {
          return (
            "pinned model " +
            f.from +
            " failed: " +
            f.error +
            "; used " +
            f.to +
            " -- re-pin the model list (I18N_MODELS in .github/workflows/i18n-bot.yml)"
          );
        })
        .join(" | ");
    }
  };
}

module.exports = {
  PROVIDERS: PROVIDERS,
  DEFAULT_MAX_CALLS: DEFAULT_MAX_CALLS,
  resolveConfig: resolveConfig,
  isRetryableStatus: isRetryableStatus,
  toGeminiSchema: toGeminiSchema,
  backoffMs: backoffMs,
  mockTranslate: mockTranslate,
  defaultMockResponder: defaultMockResponder,
  createClient: createClient
};
