import { describe, expect, it, vi } from "vitest";
import { type Candidate, routeGenerate } from "../../src/ai/router.js";
import { memoryProviderState } from "../../src/ai/state.js";
import { CancelledError, CliError } from "../../src/errors.js";
import {
  type CallSettings,
  type ProviderAdapter,
  ProviderError,
  type ProviderId,
} from "../../src/providers/types.js";

type Step = ProviderError | string | ((s: CallSettings) => ProviderError | string);

function scripted(
  id: ProviderId,
  steps: Step[],
  calls: Array<{ id: ProviderId; settings: CallSettings }>,
): ProviderAdapter {
  return {
    id,
    displayName: id,
    defaultBaseUrl: "http://x",
    async generate(_req, settings) {
      calls.push({ id, settings });
      const step = steps.shift();
      const value = typeof step === "function" ? step(settings) : step;
      if (value === undefined) throw new Error("no more steps");
      if (value instanceof ProviderError) throw value;
      return { text: value, model: settings.model, latencyMs: 1 };
    },
  };
}

const candidate = (adapter: ProviderAdapter): Candidate => ({
  id: adapter.id,
  adapter,
  structured: true,
  settings: {
    apiKey: "k",
    model: `${adapter.id}-model`,
    effort: "low",
    maxOutputTokens: 1000,
    timeoutMs: 1000,
    baseUrl: "http://x",
  },
});
const req = { system: "s", user: "u", schema: {}, schemaName: "x" };
const err = (
  id: ProviderId,
  kind: ProviderError["kind"],
  extra: { retryAfterMs?: number; heuristic?: boolean } = {},
) => new ProviderError(id, kind, `${id} ${kind}`, extra);
const noSleep = async () => {};

describe("routeGenerate", () => {
  it("falls back immediately when the primary has no credits, and remembers it", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    const state = memoryProviderState();
    const events: string[] = [];
    const out = await routeGenerate(
      [
        candidate(scripted("openai", [err("openai", "quota")], calls)),
        candidate(scripted("anthropic", ["ok"], calls)),
      ],
      req,
      { state, budgetMs: 10_000, sleep: noSleep, onEvent: (e) => events.push(e.type) },
    );
    expect(out.result.text).toBe("ok");
    expect(out.candidate.id).toBe("anthropic");
    expect(calls.map((c) => c.id)).toEqual(["openai", "anthropic"]);
    expect(state.isExhausted("openai")).toBe(true);
    expect(events).toContain("fallback");

    // Next run skips the exhausted provider.
    const calls2: Array<{ id: ProviderId; settings: CallSettings }> = [];
    await routeGenerate(
      [
        candidate(scripted("openai", ["never"], calls2)),
        candidate(scripted("anthropic", ["ok"], calls2)),
      ],
      req,
      { state, budgetMs: 10_000, sleep: noSleep },
    );
    expect(calls2.map((c) => c.id)).toEqual(["anthropic"]);
  });

  it("still tries providers when all are marked exhausted", async () => {
    const state = memoryProviderState();
    state.markExhausted("openai", 60_000, "x");
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    const out = await routeGenerate([candidate(scripted("openai", ["ok"], calls))], req, {
      state,
      budgetMs: 10_000,
      sleep: noSleep,
    });
    expect(out.result.text).toBe("ok");
    expect(state.isExhausted("openai")).toBe(false);
  });

  it("retries once for short rate limits and transient errors, then falls back", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    const sleep = vi.fn(noSleep);
    await routeGenerate(
      [
        candidate(
          scripted("openai", [err("openai", "rate_limit", { retryAfterMs: 2000 }), "ok"], calls),
        ),
      ],
      req,
      { state: memoryProviderState(), budgetMs: 10_000, sleep },
    );
    expect(sleep).toHaveBeenCalledWith(2000, undefined);

    const calls2: Array<{ id: ProviderId; settings: CallSettings }> = [];
    const out = await routeGenerate(
      [
        candidate(
          scripted("openai", [err("openai", "overloaded"), err("openai", "overloaded")], calls2),
        ),
        candidate(scripted("gemini", ["ok"], calls2)),
      ],
      req,
      { state: memoryProviderState(), budgetMs: 10_000, sleep: noSleep },
    );
    expect(calls2.map((c) => c.id)).toEqual(["openai", "openai", "gemini"]);
    expect(out.candidate.id).toBe("gemini");
  });

  it("does not wait for long Retry-After values", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    const sleep = vi.fn(noSleep);
    await routeGenerate(
      [
        candidate(
          scripted("openai", [err("openai", "rate_limit", { retryAfterMs: 60_000 })], calls),
        ),
        candidate(scripted("xai", ["ok"], calls)),
      ],
      req,
      { state: memoryProviderState(), budgetMs: 10_000, sleep },
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(calls.map((c) => c.id)).toEqual(["openai", "xai"]);
  });

  it("doubles the output limit after truncation", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    await routeGenerate(
      [candidate(scripted("openai", [err("openai", "truncated"), "ok"], calls))],
      req,
      {
        state: memoryProviderState(),
        budgetMs: 10_000,
        sleep: noSleep,
      },
    );
    expect(calls.map((c) => c.settings.maxOutputTokens)).toEqual([1000, 2000]);
  });

  it("does not retry auth or config errors, and reports every failure with hints", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    const promise = routeGenerate(
      [
        candidate(scripted("openai", [err("openai", "auth")], calls)),
        candidate(scripted("anthropic", [err("anthropic", "config")], calls)),
      ],
      req,
      { state: memoryProviderState(), budgetMs: 10_000, sleep: noSleep },
    );
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/openai auth — check the key/);
    expect(calls).toHaveLength(2);
  });

  it("stops on cancellation and when the time budget is spent", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    await expect(
      routeGenerate([candidate(scripted("openai", [err("openai", "cancelled")], calls))], req, {
        state: memoryProviderState(),
        budgetMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(CancelledError);

    let t = 0;
    await expect(
      routeGenerate([candidate(scripted("openai", ["ok"], calls))], req, {
        state: memoryProviderState(),
        budgetMs: 100,
        now: () => (t += 1000),
      }),
    ).rejects.toThrow(/Gave up after/);
  });

  it("passes the remaining budget as the request timeout", async () => {
    const calls: Array<{ id: ProviderId; settings: CallSettings }> = [];
    await routeGenerate([candidate(scripted("openai", ["ok"], calls))], req, {
      state: memoryProviderState(),
      budgetMs: 300,
    });
    expect(calls[0]?.settings.timeoutMs).toBeLessThanOrEqual(300);
  });
});
