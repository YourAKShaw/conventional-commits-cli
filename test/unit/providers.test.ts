import { describe, expect, it } from "vitest";
import { buildMessagesBody, parseMessagesOutput } from "../../src/providers/anthropic.js";
import { classifyHttpError, extractError } from "../../src/providers/classify.js";
import { resolveEffort } from "../../src/providers/effort.js";
import { buildInteractionBody, parseInteractionOutput } from "../../src/providers/gemini.js";
import { joinUrl, parseRetryAfter, postJson } from "../../src/providers/http.js";
import { ADAPTERS } from "../../src/providers/index.js";
import { buildResponsesBody, parseResponsesOutput } from "../../src/providers/openai.js";
import { type CallSettings, ProviderError } from "../../src/providers/types.js";

const request = {
  system: "SYS",
  user: "USER",
  schema: { type: "object" },
  schemaName: "s",
  structured: true,
};
const settings: CallSettings = {
  apiKey: "k",
  model: "m",
  effort: "low",
  maxOutputTokens: 100,
  timeoutMs: 5000,
  baseUrl: "http://x",
};

describe("request bodies match the documented shapes", () => {
  it("OpenAI / xAI Responses API", () => {
    expect(buildResponsesBody(request, settings)).toEqual({
      model: "m",
      input: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      max_output_tokens: 100,
      store: false,
      reasoning: { effort: "low" },
      text: {
        format: { type: "json_schema", name: "s", schema: { type: "object" }, strict: true },
      },
    });
    const plain = buildResponsesBody(
      { ...request, structured: false },
      { ...settings, effort: null },
    );
    expect(plain).not.toHaveProperty("reasoning");
    expect(plain).not.toHaveProperty("text");
  });

  it("Anthropic Messages API (effort and format share output_config)", () => {
    expect(buildMessagesBody(request, settings)).toEqual({
      model: "m",
      max_tokens: 100,
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(
      buildMessagesBody({ ...request, structured: false }, { ...settings, effort: null }),
    ).not.toHaveProperty("output_config");
  });

  it("Gemini Interactions API", () => {
    expect(buildInteractionBody(request, { ...settings, effort: "minimal" })).toEqual({
      model: "m",
      system_instruction: "SYS",
      input: "USER",
      store: false,
      generation_config: { max_output_tokens: 100, thinking_level: "minimal" },
      response_format: { type: "text", mime_type: "application/json", schema: { type: "object" } },
    });
  });
});

describe("response parsing", () => {
  it("reads OpenAI output text and usage, and maps incomplete/refusal", () => {
    const ok = parseResponsesOutput("openai", {
      status: "completed",
      model: "gpt",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(ok).toMatchObject({
      text: '{"a":1}',
      model: "gpt",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(() =>
      parseResponsesOutput("openai", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toThrow(expect.objectContaining({ kind: "truncated" }));
    expect(() =>
      parseResponsesOutput("openai", {
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      }),
    ).toThrow(expect.objectContaining({ kind: "refusal" }));
    expect(() => parseResponsesOutput("xai", { output: [] })).toThrow(
      expect.objectContaining({ kind: "invalid_response", provider: "xai" }),
    );
  });

  it("reads Anthropic text blocks and stop reasons", () => {
    expect(
      parseMessagesOutput({ content: [{ type: "thinking" }, { type: "text", text: "hi" }] }).text,
    ).toBe("hi");
    expect(() => parseMessagesOutput({ stop_reason: "max_tokens", content: [] })).toThrow(
      expect.objectContaining({ kind: "truncated" }),
    );
    expect(() => parseMessagesOutput({ stop_reason: "refusal", content: [] })).toThrow(
      expect.objectContaining({ kind: "refusal" }),
    );
  });

  it("reads Gemini steps, output_text and the legacy outputs shape", () => {
    expect(
      parseInteractionOutput({
        status: "completed",
        steps: [
          { type: "thought" },
          {
            type: "model_output",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      }).text,
    ).toBe("ab");
    expect(parseInteractionOutput({ output_text: "x" }).text).toBe("x");
    expect(parseInteractionOutput({ outputs: [{ type: "text", text: "legacy" }] }).text).toBe(
      "legacy",
    );
    expect(() => parseInteractionOutput({ status: "incomplete" })).toThrow(
      expect.objectContaining({ kind: "truncated" }),
    );
    expect(() =>
      parseInteractionOutput({ status: "failed", errors: [{ code: "safety" }] }),
    ).toThrow(expect.objectContaining({ kind: "refusal" }));
  });
});

describe("classifyHttpError", () => {
  const ctx = { hasRetryAfter: false };
  it.each([
    [
      "openai",
      429,
      {
        error: {
          code: "credit_balance_exhausted",
          type: "insufficient_quota",
          message: "no credits",
        },
      },
      "quota",
    ],
    ["openai", 429, { error: { code: "project_spend_limit_exceeded" } }, "quota"],
    ["openai", 429, { error: { code: "slow_down", type: "rate_limit_error" } }, "rate_limit"],
    ["openai", 503, { error: { code: "server_is_overloaded" } }, "overloaded"],
    ["openai", 401, { error: { message: "Incorrect API key" } }, "auth"],
    ["openai", 400, { error: { message: "bad param" } }, "config"],
    ["anthropic", 402, { type: "error", error: { type: "billing_error", message: "x" } }, "quota"],
    [
      "anthropic",
      400,
      {
        error: {
          type: "invalid_request_error",
          message: "You have reached your specified workspace spend limit",
        },
      },
      "quota",
    ],
    ["anthropic", 529, { error: { type: "overloaded_error" } }, "overloaded"],
    ["anthropic", 404, { error: { type: "not_found_error", message: "model: x" } }, "config"],
    ["gemini", 402, { error: { code: "payment_required" } }, "quota"],
    ["gemini", 429, { error: { code: "quota_exceeded" } }, "quota"],
    ["gemini", 429, { error: { code: "rate_limit_exceeded" } }, "rate_limit"],
    ["gemini", 404, { error: { code: "model_not_found" } }, "config"],
    ["xai", 429, { code: "x", error: "Your team has run out of credits" }, "quota"],
    ["xai", 429, { error: "Too many requests" }, "rate_limit"],
    ["xai", 403, { error: "API key blocked" }, "auth"],
  ] as const)("%s %i → %s", (provider, status, body, kind) => {
    const hasRetryAfter = provider === "anthropic" ? true : ctx.hasRetryAfter;
    expect(classifyHttpError(provider, status, body, { hasRetryAfter }).kind).toBe(kind);
  });

  it("treats an Anthropic 429 without retry-after as a usage cap (heuristic quota)", () => {
    const e = classifyHttpError(
      "anthropic",
      429,
      { error: { type: "rate_limit_error" } },
      { hasRetryAfter: false },
    );
    expect(e.kind).toBe("quota");
    expect(e.heuristic).toBe(true);
    expect(
      classifyHttpError("anthropic", 429, {}, { hasRetryAfter: true, retryAfterMs: 2000 }),
    ).toMatchObject({ kind: "rate_limit", retryAfterMs: 2000 });
  });

  it("extracts messages from each error shape", () => {
    expect(extractError("plain")).toEqual({ message: "plain" });
    expect(extractError({ error: { message: "m", status: "RESOURCE_EXHAUSTED" } })).toEqual({
      message: "m",
      type: "RESOURCE_EXHAUSTED",
    });
    expect(extractError({ code: "c", error: "e" })).toEqual({ message: "e", code: "c" });
  });
});

describe("resolveEffort", () => {
  it("passes supported values, omits auto and lowers unsupported values", () => {
    expect(resolveEffort("anthropic", "claude-haiku-5-5", "low")).toEqual({ value: "low" });
    expect(resolveEffort("anthropic", "claude-haiku-5-5", "auto")).toEqual({ value: null });
    const lowered = resolveEffort("openai", "gpt-5.6-luna", "minimal");
    expect(lowered.value).toBe("none");
    expect(lowered.warning).toMatch(/does not support/);
    expect(resolveEffort("anthropic", "claude-haiku-5-5", "minimal").value).toBe("low");
    expect(resolveEffort("xai", "grok-4.5", "max").value).toBe("high");
    expect(resolveEffort("openai", "some-future-model", "ultra")).toEqual({ value: "ultra" });
  });
});

describe("postJson", () => {
  const fakeFetch = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers,
      })) as typeof fetch;

  it("returns JSON and the request id", async () => {
    const r = await postJson(
      "openai",
      "http://x/responses",
      {},
      {},
      { ...settings, fetch: fakeFetch(200, { ok: 1 }, { "x-request-id": "req_1" }) },
    );
    expect(r).toMatchObject({ status: 200, json: { ok: 1 }, requestId: "req_1" });
  });

  it("classifies HTTP errors with Retry-After", async () => {
    await expect(
      postJson(
        "openai",
        "http://x",
        {},
        {},
        {
          ...settings,
          fetch: fakeFetch(429, { error: { code: "slow_down" } }, { "retry-after": "2" }),
        },
      ),
    ).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 2000 });
  });

  it("maps network errors, timeouts, cancellation and invalid JSON", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      postJson("openai", "http://x", {}, {}, { ...settings, fetch: failing }),
    ).rejects.toMatchObject({ kind: "network" });

    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      )) as typeof fetch;
    await expect(
      postJson("openai", "http://x", {}, {}, { ...settings, timeoutMs: 50, fetch: hanging }),
    ).rejects.toMatchObject({ kind: "timeout" });

    const controller = new AbortController();
    const pending = postJson(
      "openai",
      "http://x",
      {},
      {},
      { ...settings, signal: controller.signal, fetch: hanging },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });

    await expect(
      postJson("openai", "http://x", {}, {}, { ...settings, fetch: fakeFetch(200, "not json") }),
    ).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("helpers", () => {
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(joinUrl("http://a/v1/", "/responses")).toBe("http://a/v1/responses");
  });

  it("each adapter calls its documented endpoint with its auth header", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const capture = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    for (const adapter of Object.values(ADAPTERS)) {
      await expect(
        adapter.generate(request, { ...settings, baseUrl: adapter.defaultBaseUrl, fetch: capture }),
      ).rejects.toBeInstanceOf(ProviderError);
    }
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.anthropic.com/v1/messages",
      "https://api.x.ai/v1/responses",
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    ]);
    expect(seen[0]?.headers.authorization).toBe("Bearer k");
    expect(seen[1]?.headers["x-api-key"]).toBe("k");
    expect(seen[1]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[3]?.headers["x-goog-api-key"]).toBe("k");
  });
});
