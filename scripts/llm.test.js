/**
 * @fileoverview Unit pins for scripts/lib/llm.js -- the repo's shared LLM
 * client, tested on its own rather than through whichever bot happens to call
 * it first.
 *
 * Every branch is driven through an injected `fetchImpl` and an injected
 * `sleep`, so this suite opens no socket, needs no API key, and takes
 * milliseconds. That matters more than usual here: the behaviour under test is
 * exactly the behaviour nobody can observe locally, because it only happens
 * when a provider rate-limits, times out, or retires a model id in the middle
 * of an unattended run.
 *
 * The four things asserted that a bot's own suite would not cover:
 *   - a 429 is retried and a 404 is not, on the same code path;
 *   - a retired pinned model falls through to the alias EXACTLY once and is
 *     never probed again in the same run;
 *   - the fallback is reported in words a maintainer can act on;
 *   - the per-run call cap is a distinguishable error, not a generic failure,
 *     so a caller can stop cleanly instead of treating it as a crash.
 *
 * Run: node scripts/llm.test.js
 */

const llm = require("./lib/llm.js");

let passed = 0;
let failed = 0;
function ok(label) {
  passed++;
  void label;
}
function fail(label, detail) {
  failed++;
  console.error("  ✗ " + label + (detail ? "\n      " + detail : ""));
}
function assert(condition, label, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}
function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    label,
    "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
  );
}

console.log("Running llm client pins...\n");

const SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object" } } },
  required: ["items"],
  additionalProperties: false
};

function spec() {
  return {
    system: "s",
    user: JSON.stringify({ locale: "es", items: [{ id: "a", text: "hi" }] }),
    schema: SCHEMA,
    schemaName: "test"
  };
}

function reply(items) {
  return {
    ok: true,
    json: async function () {
      return { choices: [{ message: { content: JSON.stringify({ items: items }) } }] };
    }
  };
}

function errorReply(status) {
  return {
    ok: false,
    status: status,
    text: async function () {
      return "error body";
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Configuration: options beat environment, environment beats the preset.
// ---------------------------------------------------------------------------
{
  const def = llm.resolveConfig({}, {});
  assertEqual(def.provider, "gemini", "gemini is the default provider");
  assertEqual(def.models[0], "gemini-3.8-flash", "the pinned model is first in the default list");
  assertEqual(
    def.models[def.models.length - 1],
    "gemini-flash-latest",
    "the rolling alias is last, as the survival path"
  );
  assertEqual(def.maxCalls, llm.DEFAULT_MAX_CALLS, "the call cap has a default");
  assertEqual(
    def.maxCalls,
    Infinity,
    "and that default is no cap at all (owner decision 2026-09-04)"
  );
  assert(
    llm.backoffMs(0, 503) > llm.backoffMs(0, 429),
    "a 503 waits longer than other retryable statuses"
  );

  assertEqual(
    llm.resolveConfig({}, { LLM_MODELS: "one, two ,three" }).models.join("|"),
    "one|two|three",
    "LLM_MODELS is one comma-separated list"
  );
  assertEqual(
    llm.resolveConfig({ models: "mine" }, { LLM_MODELS: "theirs" }).models.join("|"),
    "mine",
    "an explicit option beats the environment"
  );
  assertEqual(
    llm.resolveConfig({}, { LLM_MAX_CALLS: "7" }).maxCalls,
    7,
    "LLM_MAX_CALLS is read as a number"
  );
  assertEqual(
    llm.resolveConfig({ maxCalls: 3 }, { LLM_MAX_CALLS: "7" }).maxCalls,
    3,
    "and an explicit cap beats it"
  );

  const groq = llm.resolveConfig({ provider: "groq" }, { GROQ_API_KEY: "k" });
  assert(groq.base.indexOf("api.groq.com") !== -1, "groq resolves to its own base URL");
  assertEqual(groq.apiKey, "k", "groq reads GROQ_API_KEY");
  assertEqual(
    llm.resolveConfig({}, { GEMINI_API_KEY: "g" }).apiKey,
    "g",
    "gemini reads GEMINI_API_KEY"
  );
  assertEqual(
    llm.resolveConfig({}, { LLM_BASE_URL: "https://example.test/v1/" }).base,
    "https://example.test/v1",
    "a base URL override loses its trailing slash"
  );

  let threw = false;
  try {
    llm.resolveConfig({ provider: "nope" }, {});
  } catch {
    threw = true;
  }
  assert(threw, "an unknown provider is refused rather than silently defaulted");

  threw = false;
  try {
    llm.createClient({ provider: "gemini" }, {});
  } catch {
    threw = true;
  }
  assert(threw, "a keyless real provider refuses to start rather than failing mid-run");

  const mock = llm.createClient({ provider: "mock" }, {});
  assertEqual(mock.telemetry.provider, "mock", "the mock provider needs no key");
  assertEqual(mock.fallbackWarning(), null, "a clean run carries no model warning");
  assertEqual(llm.isRetryableStatus(429), true, "429 is retryable");
  assertEqual(llm.isRetryableStatus(503), true, "503 is retryable");
  assertEqual(llm.isRetryableStatus(404), false, "404 is not");
  assertEqual(llm.isRetryableStatus(400), false, "400 is not");
  assert(llm.backoffMs(3) > llm.backoffMs(1), "backoff grows with the attempt number");
  assert(
    llm.backoffMs(20) < 60000,
    "and is capped rather than unbounded -- an uncapped 2^20 seconds would be 12 days",
    String(llm.backoffMs(20))
  );
}

async function main() {
  // -------------------------------------------------------------------------
  // 2. Retries.
  // -------------------------------------------------------------------------
  {
    let calls = 0;
    let lastBody = null;
    const client = llm.createClient(
      {
        provider: "gemini",
        apiKey: "x",
        sleep: async function () {},
        fetchImpl: async function (url, init) {
          calls++;
          lastBody = JSON.parse(init.body);
          if (calls < 3) return errorReply(429);
          return reply([{ id: "a", text: "hola" }]);
        }
      },
      {}
    );
    const out = await client.completeJSON(spec());
    assertEqual(out.items[0].text, "hola", "a 429 is retried with backoff and then succeeds");
    assertEqual(
      lastBody.reasoning_effort,
      "high",
      "the OpenAI-style transport asks for high reasoning"
    );
    assertEqual(client.telemetry.retries, 2, "both retries are counted");
    assertEqual(client.telemetry.model, "gemini-3.8-flash", "the pinned model produced the answer");
    assertEqual(client.fallbackWarning(), null, "retrying the pinned model is not a fallback");
  }

  {
    let sent = 0;
    const client = llm.createClient(
      {
        provider: "gemini",
        apiKey: "x",
        models: "only-one",
        maxRetries: 2,
        sleep: async function () {},
        fetchImpl: async function () {
          sent++;
          return errorReply(503);
        }
      },
      {}
    );
    let threw = false;
    try {
      await client.completeJSON(spec());
    } catch (err) {
      threw = err.message.indexOf("503") !== -1;
    }
    assert(threw, "a provider that never recovers throws, naming the status");
    assertEqual(sent, 3, "and stops after maxRetries rather than looping into the rate limit");
  }

  // -------------------------------------------------------------------------
  // 2a. The Vertex transport: native generateContent, key in a header.
  // -------------------------------------------------------------------------
  {
    const seen = [];
    const client = llm.createClient(
      {
        provider: "vertex",
        apiKey: "cloud-key",
        sleep: async function () {},
        fetchImpl: async function (url, init) {
          seen.push({ url: String(url), init: init });
          return {
            ok: true,
            json: async function () {
              return {
                candidates: [
                  {
                    content: {
                      parts: [{ text: JSON.stringify({ items: [{ id: "a", text: "hola" }] }) }]
                    }
                  }
                ]
              };
            }
          };
        }
      },
      {}
    );
    const out = await client.completeJSON(spec());
    assertEqual(
      out.items[0].text,
      "hola",
      "a Vertex reply is read out of candidates[0].content.parts"
    );
    assertEqual(
      seen[0].url,
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent",
      "the express-mode URL: no project, no location, model in the path"
    );
    assertEqual(
      seen[0].init.headers["x-goog-api-key"],
      "cloud-key",
      "the key rides in x-goog-api-key"
    );
    assert(!("Authorization" in seen[0].init.headers), "and not as a Bearer token");
    const body = JSON.parse(seen[0].init.body);
    assertEqual(
      body.systemInstruction.parts[0].text,
      "s",
      "the system prompt is a systemInstruction"
    );
    assertEqual(body.contents[0].role, "user", "the payload is the user turn");
    assertEqual(
      body.generationConfig.responseMimeType,
      "application/json",
      "structured output via generationConfig"
    );
    assert(body.generationConfig.responseSchema, "with a responseSchema");
    assert(
      JSON.stringify(body.generationConfig.responseSchema).indexOf("additionalProperties") === -1,
      "that has had the OpenAI-only keys stripped"
    );
    assert(!("model" in body), "and no model field in the body -- it is in the path");
    assertEqual(
      body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel,
      "high",
      "Gemini 3.x thinking runs at high by default (owner decision 2026-09-04)"
    );
  }
  {
    const noThink = llm.resolveConfig(
      { provider: "vertex", apiKey: "k" },
      { LLM_THINKING: "none" }
    );
    assertEqual(noThink.thinking, "none", "LLM_THINKING=none is honoured");
    assertEqual(
      llm.resolveConfig({ provider: "gemini", apiKey: "k" }, {}).thinking,
      "high",
      "and the default is high on every provider"
    );
  }
  assertEqual(
    JSON.stringify(
      llm.toGeminiSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          a: { type: "array", items: { type: "string" }, additionalProperties: false }
        },
        required: ["a"]
      })
    ),
    JSON.stringify({
      type: "object",
      properties: { a: { type: "array", items: { type: "string" } } },
      required: ["a"]
    }),
    "toGeminiSchema drops additionalProperties at every depth and keeps the rest in order"
  );

  // -------------------------------------------------------------------------
  // 2b. A key the provider refuses outright: stop calling, say so once.
  // -------------------------------------------------------------------------
  {
    let sent = 0;
    const client = llm.createClient(
      {
        provider: "gemini",
        apiKey: "x",
        models: "gemini-3.8-flash,gemini-flash-latest",
        maxRetries: 1,
        sleep: async function () {},
        fetchImpl: async function () {
          sent++;
          return {
            ok: false,
            status: 403,
            text: async function () {
              return JSON.stringify([
                {
                  error: {
                    code: 403,
                    message: "Requests to this API generativelanguage.googleapis.com are blocked.",
                    status: "PERMISSION_DENIED",
                    details: [
                      {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        reason: "API_KEY_SERVICE_BLOCKED"
                      }
                    ]
                  }
                }
              ]);
            }
          };
        }
      },
      {}
    );
    let first = null;
    try {
      await client.completeJSON(spec());
    } catch (err) {
      first = err;
    }
    assert(first && first.status === 403, "a blocked key surfaces as the 403 it is");
    assert(
      first.message.indexOf("PERMISSION_DENIED (API_KEY_SERVICE_BLOCKED)") !== -1 &&
        first.message.indexOf("{") === -1,
      "the error body is folded to status, reason and message, never raw JSON",
      first.message
    );
    assert(client.fallbackWarning() !== null, "the alias was tried before giving up, and reported");
    const sentAfterFirst = sent;
    let second = null;
    try {
      await client.completeJSON(spec());
    } catch (err) {
      second = err;
    }
    assertEqual(
      second && second.code,
      "LLM_PROVIDER_UNAVAILABLE",
      "the next call is refused by the client itself"
    );
    assertEqual(sent, sentAfterFirst, "without touching the network again");
    assert(client.unavailable() !== null, "unavailable() names the refusal");
  }

  // -------------------------------------------------------------------------
  // 3. The model fallback, which must be permanent and loud.
  // -------------------------------------------------------------------------
  {
    const seen = [];
    const client = llm.createClient(
      {
        provider: "gemini",
        apiKey: "x",
        sleep: async function () {},
        fetchImpl: async function (url, init) {
          const model = JSON.parse(init.body).model;
          seen.push(model);
          if (model === "gemini-3.8-flash") return errorReply(404);
          return reply([{ id: "a", text: "hola" }]);
        }
      },
      {}
    );
    await client.completeJSON(spec());
    assertEqual(
      client.telemetry.modelFallbacks.length,
      1,
      "the fallback is recorded, not swallowed"
    );
    assertEqual(client.telemetry.model, "gemini-flash-latest", "the alias produced the answer");
    const warning = client.fallbackWarning();
    assert(
      warning.indexOf("gemini-3.8-flash failed") !== -1 && warning.indexOf("re-pin") !== -1,
      "the warning names the dead pin and says to re-pin",
      warning
    );
    assertEqual(
      seen.filter(function (m) {
        return m === "gemini-3.8-flash";
      }).length,
      1,
      "a 404 is not retried on the same model"
    );
    await client.completeJSON(spec());
    assertEqual(
      seen.filter(function (m) {
        return m === "gemini-3.8-flash";
      }).length,
      1,
      "and a model that fell through is never probed again in the same run"
    );
  }

  {
    const client = llm.createClient(
      {
        provider: "groq",
        apiKey: "x",
        sleep: async function () {},
        fetchImpl: async function () {
          return errorReply(500);
        }
      },
      {}
    );
    let threw = false;
    try {
      await client.completeJSON(spec());
    } catch {
      threw = true;
    }
    assert(threw, "a single-model provider with nothing to fall back to throws");
    assertEqual(
      client.telemetry.modelFallbacks.length,
      0,
      "and records no fallback it did not make"
    );
  }

  // -------------------------------------------------------------------------
  // 4. Malformed answers are errors, not silent empties.
  // -------------------------------------------------------------------------
  {
    const client = llm.createClient(
      {
        provider: "gemini",
        apiKey: "x",
        models: "only-one",
        maxRetries: 0,
        sleep: async function () {},
        fetchImpl: async function () {
          return {
            ok: true,
            json: async function () {
              return { choices: [{ message: { content: "not json at all" } }] };
            }
          };
        }
      },
      {}
    );
    let threw = false;
    try {
      await client.completeJSON(spec());
    } catch {
      threw = true;
    }
    assert(threw, "content that is not JSON throws rather than returning undefined");
  }

  // -------------------------------------------------------------------------
  // 5. The call cap: a distinguishable stop, not a crash.
  // -------------------------------------------------------------------------
  {
    const client = llm.createClient(
      {
        provider: "gemini",
        apiKey: "x",
        maxCalls: 2,
        sleep: async function () {},
        fetchImpl: async function () {
          return reply([{ id: "a", text: "hola" }]);
        }
      },
      {}
    );
    assertEqual(client.callsRemaining(), 2, "the budget starts full");
    await client.completeJSON(spec());
    await client.completeJSON(spec());
    assertEqual(client.callsRemaining(), 0, "and is spent by successful calls");
    let code = null;
    try {
      await client.completeJSON(spec());
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, "LLM_CALL_CAP", "the cap raises an error a caller can recognise");
  }

  // -------------------------------------------------------------------------
  // 6. The mock provider, and its corruption hook.
  // -------------------------------------------------------------------------
  {
    const terms = ["Bourbon Beard Salve"];
    const text = "Enlarge photo of {product} -- Bourbon Beard Salve";
    const good = llm.mockTranslate(text, "de", terms, {});
    assert(good.indexOf("{product}") !== -1, "the mock preserves placeholders");
    assert(good.indexOf("Bourbon Beard Salve") !== -1, "the mock preserves protected terms");
    assertEqual(good.indexOf("[de]"), 0, "mock output is unmistakably not a translation");
    const broken = llm.mockTranslate(text, "de", terms, { LLM_MOCK_CORRUPT: "Enlarge" });
    assert(
      broken.indexOf("Bourbon Beard Salve") === -1,
      "the corruption hook drops the protected term"
    );
    assertEqual(
      llm.mockTranslate(text, "de", terms, { LLM_MOCK_CORRUPT: "nowhere" }),
      good,
      "and leaves everything else alone"
    );

    const client = llm.createClient({ provider: "mock" }, {});
    const out = await client.completeJSON({
      system: "s",
      user: JSON.stringify({ locale: "ja", items: [{ id: "k", text: "Home" }] }),
      schema: SCHEMA,
      protectedTerms: terms
    });
    assertEqual(out.items[0].id, "k", "the mock answers with the ids it was given");
    assertEqual(out.items[0].text, "[ja] Home", "and a deterministic, locale-tagged value");
    assertEqual(client.telemetry.calls, 1, "and counts against the same call budget");

    const custom = llm.createClient(
      {
        provider: "mock",
        mockResponder: function () {
          return { items: [{ id: "z", text: "custom" }] };
        }
      },
      {}
    );
    const customOut = await custom.completeJSON(spec());
    assertEqual(customOut.items[0].text, "custom", "a caller can supply its own mock shape");
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  console.error("suite crashed: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
