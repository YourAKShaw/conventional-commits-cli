import { joinUrl, postJson } from "./http.js";
import {
  type CallSettings,
  type GenerateRequest,
  type GenerateResult,
  type ProviderAdapter,
  ProviderError,
} from "./types.js";

export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Messages API body. Effort and the JSON schema share `output_config`:
 * https://platform.claude.com/docs/en/build-with-claude/effort and
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs (checked 2026-10-17).
 */
export function buildMessagesBody(
  request: GenerateRequest,
  settings: CallSettings,
): Record<string, unknown> {
  const outputConfig: Record<string, unknown> = {};
  if (settings.effort) outputConfig.effort = settings.effort;
  if (request.structured) outputConfig.format = { type: "json_schema", schema: request.schema };
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: settings.maxOutputTokens,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
  };
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
  return body;
}

export function parseMessagesOutput(
  json: unknown,
  requestId?: string,
): Omit<GenerateResult, "latencyMs"> {
  const obj = (json ?? {}) as {
    model?: string;
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const details = requestId === undefined ? {} : { requestId };
  if (obj.stop_reason === "max_tokens") {
    throw new ProviderError("anthropic", "truncated", "Output was cut off by max_tokens.", details);
  }
  if (obj.stop_reason === "refusal") {
    throw new ProviderError("anthropic", "refusal", "The model declined to answer.", details);
  }
  const text = (obj.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text)
    throw new ProviderError(
      "anthropic",
      "invalid_response",
      "The response contained no text block.",
      details,
    );
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof obj.usage?.input_tokens === "number") usage.inputTokens = obj.usage.input_tokens;
  if (typeof obj.usage?.output_tokens === "number") usage.outputTokens = obj.usage.output_tokens;
  return { text, model: obj.model ?? "", usage, ...details };
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  displayName: "Anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  async generate(request, settings) {
    const response = await postJson(
      "anthropic",
      joinUrl(settings.baseUrl, "v1/messages"),
      { "x-api-key": settings.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      buildMessagesBody(request, settings),
      settings,
    );
    const parsed = parseMessagesOutput(response.json, response.requestId);
    return { ...parsed, model: parsed.model || settings.model, latencyMs: response.latencyMs };
  },
};
