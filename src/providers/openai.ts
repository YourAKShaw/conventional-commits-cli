import { joinUrl, postJson } from "./http.js";
import {
  type CallSettings,
  type GenerateRequest,
  type GenerateResult,
  type ProviderAdapter,
  ProviderError,
  type ProviderId,
} from "./types.js";

/**
 * Request body for an OpenAI-compatible Responses API (`POST /responses`).
 * Shape per https://developers.openai.com/api/docs/guides/structured-outputs and
 * https://developers.openai.com/api/docs/guides/reasoning (checked 2026-10-17).
 */
export function buildResponsesBody(
  request: GenerateRequest,
  settings: CallSettings,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    input: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    max_output_tokens: settings.maxOutputTokens,
    store: false,
  };
  if (settings.effort) body.reasoning = { effort: settings.effort };
  if (request.structured) {
    body.text = {
      format: {
        type: "json_schema",
        name: request.schemaName,
        schema: request.schema,
        strict: true,
      },
    };
  }
  return body;
}

export function parseResponsesOutput(
  provider: ProviderId,
  json: unknown,
  requestId?: string,
): Omit<GenerateResult, "latencyMs"> {
  const obj = (json ?? {}) as {
    status?: string;
    model?: string;
    incomplete_details?: { reason?: string } | null;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const details = requestId === undefined ? {} : { requestId };
  if (obj.status === "incomplete") {
    const reason = obj.incomplete_details?.reason ?? "unknown";
    if (reason === "max_output_tokens") {
      throw new ProviderError(
        provider,
        "truncated",
        "Output was cut off by max_output_tokens.",
        details,
      );
    }
    throw new ProviderError(provider, "refusal", `Response incomplete (${reason}).`, details);
  }
  if (obj.status === "failed") {
    throw new ProviderError(
      provider,
      "invalid_response",
      "The response status is failed.",
      details,
    );
  }

  let text = "";
  for (const item of obj.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") {
        throw new ProviderError(
          provider,
          "refusal",
          `The model declined: ${part.refusal ?? ""}`.trim(),
          details,
        );
      }
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  if (!text && typeof obj.output_text === "string") text = obj.output_text;
  if (!text)
    throw new ProviderError(
      provider,
      "invalid_response",
      "The response contained no text.",
      details,
    );

  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof obj.usage?.input_tokens === "number") usage.inputTokens = obj.usage.input_tokens;
  if (typeof obj.usage?.output_tokens === "number") usage.outputTokens = obj.usage.output_tokens;
  return { text, model: obj.model ?? "", usage, ...details };
}

export function createResponsesAdapter(
  id: ProviderId,
  displayName: string,
  defaultBaseUrl: string,
): ProviderAdapter {
  return {
    id,
    displayName,
    defaultBaseUrl,
    async generate(request, settings) {
      const response = await postJson(
        id,
        joinUrl(settings.baseUrl, "responses"),
        { authorization: `Bearer ${settings.apiKey}` },
        buildResponsesBody(request, settings),
        settings,
      );
      const parsed = parseResponsesOutput(id, response.json, response.requestId);
      return { ...parsed, model: parsed.model || settings.model, latencyMs: response.latencyMs };
    },
  };
}

export const openaiAdapter = createResponsesAdapter(
  "openai",
  "OpenAI",
  "https://api.openai.com/v1",
);
