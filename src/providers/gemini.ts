import { joinUrl, postJson } from "./http.js";
import {
  type CallSettings,
  type GenerateRequest,
  type GenerateResult,
  type ProviderAdapter,
  ProviderError,
} from "./types.js";

/**
 * Interactions API body (`POST /v1beta/interactions`), per
 * https://ai.google.dev/api/interactions-api, https://ai.google.dev/gemini-api/docs/structured-output
 * and https://ai.google.dev/gemini-api/docs/thinking (checked 2026-10-17).
 */
export function buildInteractionBody(
  request: GenerateRequest,
  settings: CallSettings,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { max_output_tokens: settings.maxOutputTokens };
  if (settings.effort) generationConfig.thinking_level = settings.effort;
  const body: Record<string, unknown> = {
    model: settings.model,
    system_instruction: request.system,
    input: request.user,
    store: false,
    generation_config: generationConfig,
  };
  if (request.structured) {
    body.response_format = { type: "text", mime_type: "application/json", schema: request.schema };
  }
  return body;
}

interface InteractionJson {
  status?: string;
  model?: string;
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  /** Pre-May-2026 schema, kept for compatibility with older deployments or proxies. */
  outputs?: Array<{ type?: string; text?: string }>;
  errors?: Array<{ code?: string; message?: string }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
  };
}

export function parseInteractionOutput(
  json: unknown,
  requestId?: string,
): Omit<GenerateResult, "latencyMs"> {
  const obj = (json ?? {}) as InteractionJson;
  const details = requestId === undefined ? {} : { requestId };
  if (obj.status === "incomplete") {
    throw new ProviderError(
      "gemini",
      "truncated",
      "The interaction finished incomplete (output limit reached).",
      details,
    );
  }
  if (obj.status === "failed" || obj.status === "cancelled") {
    const first = obj.errors?.[0];
    throw new ProviderError(
      "gemini",
      first?.code === "safety" || first?.code === "prohibited_content"
        ? "refusal"
        : "invalid_response",
      `Interaction ${obj.status}${first ? `: ${first.code ?? ""} ${first.message ?? ""}`.trimEnd() : ""}.`,
      details,
    );
  }

  let text = typeof obj.output_text === "string" ? obj.output_text : "";
  if (!text && Array.isArray(obj.steps)) {
    text = obj.steps
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
  }
  if (!text && Array.isArray(obj.outputs)) {
    text = obj.outputs
      .filter((o) => (o.type === undefined || o.type === "text") && typeof o.text === "string")
      .map((o) => o.text)
      .join("");
  }
  if (!text)
    throw new ProviderError(
      "gemini",
      "invalid_response",
      "The interaction contained no text output.",
      details,
    );

  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof obj.usage?.total_input_tokens === "number")
    usage.inputTokens = obj.usage.total_input_tokens;
  const out = (obj.usage?.total_output_tokens ?? 0) + (obj.usage?.total_thought_tokens ?? 0);
  if (out > 0) usage.outputTokens = out;
  return { text, model: obj.model ?? "", usage, ...details };
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  displayName: "Google Gemini",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  async generate(request, settings) {
    const response = await postJson(
      "gemini",
      joinUrl(settings.baseUrl, "v1beta/interactions"),
      { "x-goog-api-key": settings.apiKey },
      buildInteractionBody(request, settings),
      settings,
    );
    const parsed = parseInteractionOutput(response.json, response.requestId);
    return { ...parsed, model: parsed.model || settings.model, latencyMs: response.latencyMs };
  },
};
