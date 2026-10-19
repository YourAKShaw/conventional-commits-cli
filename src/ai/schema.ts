import { z } from "zod";
import type { RawDraft } from "../message/normalize.js";

/**
 * Response contract for smart mode. Only strings, booleans and arrays are used (no null,
 * no length constraints) so the same schema is accepted by all four providers' structured
 * output features. Empty strings mean "absent".
 */
export function responseJsonSchema(types: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "type",
      "scope",
      "gitmoji",
      "description",
      "body",
      "breaking",
      "breakingDescription",
      "footers",
    ],
    properties: {
      type: { type: "string", enum: [...types], description: "Conventional Commits type." },
      scope: { type: "string", description: 'Short noun for the affected area, or "" for none.' },
      gitmoji: { type: "string", description: 'Gitmoji shortcode such as ":sparkles:", or "".' },
      description: { type: "string", description: "Imperative summary for the header." },
      body: { type: "string", description: 'What changed and why, or "".' },
      breaking: { type: "boolean", description: "True only for breaking changes." },
      breakingDescription: {
        type: "string",
        description: 'What breaks and how to migrate, or "".',
      },
      footers: {
        type: "array",
        description: "Git-trailer-style footers such as Refs.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["token", "value"],
          properties: { token: { type: "string" }, value: { type: "string" } },
        },
      },
    },
  };
}

const footerSchema = z.object({ token: z.string(), value: z.string() });

export const rawDraftSchema = z.object({
  type: z.string().min(1),
  scope: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  gitmoji: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  description: z.string().min(1, "description is empty"),
  body: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  breaking: z.boolean(),
  breakingDescription: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  footers: z
    .array(footerSchema)
    .nullish()
    .transform((v) => v ?? []),
});

export type ParseOutcome = { ok: true; draft: RawDraft } | { ok: false; error: string };

/** Parse model output leniently (code fences, surrounding prose) and validate it. */
export function parseModelOutput(text: string): ParseOutcome {
  const candidate = extractJsonObject(text);
  if (candidate === null) return { ok: false, error: "The output did not contain a JSON object." };
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, error: `The output was not valid JSON: ${(error as Error).message}` };
  }
  const result = rawDraftSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `The JSON did not match the schema: ${issues}` };
  }
  return { ok: true, draft: result.data };
}

export function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return source.slice(start, end + 1);
}
