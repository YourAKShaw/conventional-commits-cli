import { anthropicAdapter } from "./anthropic.js";
import { geminiAdapter } from "./gemini.js";
import { createResponsesAdapter, openaiAdapter } from "./openai.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

/** xAI serves an OpenAI-compatible Responses API (https://docs.x.ai/developers/model-capabilities/text/reasoning). */
export const xaiAdapter = createResponsesAdapter("xai", "xAI", "https://api.x.ai/v1");

export const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  xai: xaiAdapter,
  gemini: geminiAdapter,
};
