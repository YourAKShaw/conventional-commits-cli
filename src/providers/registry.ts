import type { ProviderId } from "./types.js";

/**
 * Model and effort data checked against vendor documentation on 2026-10-17/19.
 * Vendors change models, effort levels and defaults often: re-verify before each release
 * (see docs/providers.md). Unknown models are allowed; their effort values pass through
 * unvalidated.
 */
export const REGISTRY_VERIFIED_ON = "2026-10-19";

export interface ModelInfo {
  id: string;
  /** Supported effort values, lowest first; null when not verified. */
  efforts: readonly string[] | null;
  /** Vendor default effort when the parameter is omitted, if documented. */
  defaultEffort?: string;
  note?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  envVars: readonly string[];
  defaultModel: string;
  /** Effort used for commit messages: short structured output rarely needs deep reasoning. */
  defaultEffort: string;
  effortParameter: string;
  docsUrl: string;
  keyUrl: string;
  models: readonly ModelInfo[];
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
  openai: {
    id: "openai",
    displayName: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "low",
    effortParameter: "reasoning.effort (Responses API)",
    docsUrl: "https://developers.openai.com/api/docs/guides/reasoning",
    keyUrl: "https://platform.openai.com/settings/organization/api-keys",
    models: [
      {
        id: "gpt-5.6-luna",
        efforts: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        note: "Lowest cost and latency in the GPT-5.6 family",
      },
      { id: "gpt-5.6-terra", efforts: null, note: "Lower-cost GPT-5.6 tier" },
      {
        id: "gpt-6-astra",
        efforts: null,
        note: "Vendor-recommended starting point for reasoning; does not accept 'none'",
      },
    ],
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-haiku-5-5",
    defaultEffort: "low",
    effortParameter: "output_config.effort (Messages API)",
    docsUrl: "https://platform.claude.com/docs/en/build-with-claude/effort",
    keyUrl: "https://platform.claude.com/",
    models: [
      {
        id: "claude-haiku-5-5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        note: "Fastest Claude model",
      },
      {
        id: "claude-sonnet-5-5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
      {
        id: "claude-opus-5-5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
      {
        id: "claude-fable-5-1",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
    ],
  },
  xai: {
    id: "xai",
    displayName: "xAI",
    envVars: ["XAI_API_KEY"],
    defaultModel: "grok-4.7",
    defaultEffort: "low",
    effortParameter: "reasoning.effort (Responses API)",
    docsUrl: "https://docs.x.ai/developers/model-capabilities/text/reasoning",
    keyUrl: "https://console.x.ai/team/default/api-keys",
    models: [
      {
        id: "grok-4.7",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
        note: "Reasoning cannot be disabled",
      },
      { id: "grok-4.6", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
      { id: "grok-4.5", efforts: ["low", "medium", "high"], defaultEffort: "high" },
    ],
  },
  gemini: {
    id: "gemini",
    displayName: "Google Gemini",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-3.5-flash-lite",
    defaultEffort: "minimal",
    effortParameter: "generation_config.thinking_level (Interactions API)",
    docsUrl: "https://ai.google.dev/gemini-api/docs/thinking",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      {
        id: "gemini-3.5-flash-lite",
        efforts: ["minimal", "low", "medium", "high"],
        defaultEffort: "minimal",
        note: "Fastest, most cost-effective 3.5 model",
      },
      { id: "gemini-3.8-flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      {
        id: "gemini-3.6-flash",
        efforts: ["minimal", "low", "medium", "high"],
        defaultEffort: "medium",
      },
      { id: "gemini-4-argon", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
  },
};

export function modelInfo(provider: ProviderId, model: string): ModelInfo | undefined {
  return PROVIDERS[provider].models.find((m) => m.id === model);
}
