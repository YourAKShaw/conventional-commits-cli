import { z } from "zod";
import { PROVIDER_IDS } from "../providers/types.js";

const providerId = z.enum(PROVIDER_IDS);

const effort = z
  .string()
  .regex(/^[a-z]+$/, "Use a lowercase effort name such as auto, minimal, low, medium or high.");

export const providerSettingsSchema = z.strictObject({
  model: z.string().min(1).optional(),
  effort: effort.optional(),
  maxOutputTokens: z.number().int().min(256).max(128_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  enabled: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
});

const typeName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "Types are lowercase words, for example feat.");
const typeEntry = z.union([typeName, z.strictObject({ type: typeName, description: z.string() })]);

export const formatSchema = z.strictObject({
  gitmoji: z
    .strictObject({
      enabled: z.boolean().optional(),
      style: z.enum(["unicode", "code"]).optional(),
      position: z.enum(["after-colon", "prefix"]).optional(),
    })
    .optional(),
  headerMaxLength: z.number().int().min(20).max(200).optional(),
  bodyWrap: z.number().int().min(40).max(200).optional(),
  types: z.union([z.literal("commitlint"), z.array(typeEntry).min(1)]).optional(),
  scopes: z.array(z.string().regex(/^\S+$/, "Scopes cannot contain spaces.")).optional(),
});

const globs = z.array(z.string().min(1));

export const globalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1).optional(),
  providers: z
    .strictObject({
      order: z.array(providerId).optional(),
      openai: providerSettingsSchema.optional(),
      anthropic: providerSettingsSchema.optional(),
      xai: providerSettingsSchema.optional(),
      gemini: providerSettingsSchema.optional(),
    })
    .optional(),
  smart: z
    .strictObject({
      enabled: z.boolean().optional(),
      maxInputTokens: z.number().int().min(2_000).max(400_000).optional(),
      maxRegenerations: z.number().int().min(0).max(20).optional(),
      requestBudgetMs: z.number().int().min(5_000).max(900_000).optional(),
      language: z.string().min(1).max(40).optional(),
      historyCount: z.number().int().min(0).max(50).optional(),
      largeChangeFiles: z.number().int().min(1).optional(),
      largeChangeLines: z.number().int().min(1).optional(),
      acknowledgedProviders: z.array(providerId).optional(),
    })
    .optional(),
  format: formatSchema.optional(),
  secrets: z
    .strictObject({
      extraDenyGlobs: globs.optional(),
      extraPatterns: globs.optional(),
      onDetect: z.enum(["ask", "exclude", "redact", "abort"]).optional(),
    })
    .optional(),
  commitlint: z.strictObject({ loadJsConfig: z.boolean().optional() }).optional(),
});

/**
 * Repository config (.ccli.json) may only shape formatting and tighten data egress.
 * It can never choose providers, models, endpoints, keys or loosen secret handling,
 * because a cloned repository is not trusted to redirect your diffs.
 */
export const repoConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1).optional(),
  format: formatSchema.optional(),
  secrets: z
    .strictObject({ extraDenyGlobs: globs.optional(), extraPatterns: globs.optional() })
    .optional(),
  smart: z
    .strictObject({
      enabled: z.boolean().optional(),
      maxInputTokens: z.number().int().min(2_000).max(400_000).optional(),
    })
    .optional(),
  providers: z.strictObject({ allow: z.array(providerId).min(1).optional() }).optional(),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type ProviderSettingsConfig = z.infer<typeof providerSettingsSchema>;

/** Keys a repository config may not set, with the reason shown to the user. */
export const REPO_FORBIDDEN_KEYS: Readonly<Record<string, string>> = {
  "providers.order": "provider order",
  "providers.openai": "provider settings",
  "providers.anthropic": "provider settings",
  "providers.xai": "provider settings",
  "providers.gemini": "provider settings",
  "smart.acknowledgedProviders": "data-sharing acknowledgements",
  "secrets.onDetect": "secret handling",
  commitlint: "loading executable configs",
};
