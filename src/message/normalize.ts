import { findGitmoji } from "./gitmoji.js";
import { normalizeFooterToken } from "./render.js";
import type { CommitDraft, Footer, TypeInfo } from "./types.js";

export interface RawDraft {
  type: string;
  scope: string;
  gitmoji: string;
  description: string;
  body: string;
  breaking: boolean;
  breakingDescription: string;
  footers: Footer[];
}

/** Clean up a model-produced draft into a CommitDraft. Deterministic and side-effect free. */
export function normalizeDraft(raw: RawDraft, allowedTypes: TypeInfo[]): CommitDraft {
  const type = normalizeType(raw.type, allowedTypes);
  const footers = raw.footers
    .map((f) => ({ token: normalizeFooterToken(f.token ?? ""), value: (f.value ?? "").trim() }))
    .filter((f) => f.token && f.value);

  // A BREAKING CHANGE footer returned in `footers` belongs in the breaking fields.
  let breaking = raw.breaking;
  let breakingDescription = raw.breakingDescription.trim() || null;
  for (const f of footers) {
    if (f.token === "BREAKING CHANGE") {
      breaking = true;
      breakingDescription ??= f.value;
    }
  }

  return {
    type,
    scope: normalizeScope(raw.scope),
    gitmoji: findGitmoji(raw.gitmoji)?.code ?? null,
    description: normalizeDescription(raw.description),
    body: normalizeBody(raw.body),
    breaking,
    breakingDescription: breaking ? breakingDescription : null,
    footers: footers.filter((f) => f.token !== "BREAKING CHANGE"),
  };
}

export function normalizeType(type: string, allowed: TypeInfo[]): string {
  const cleaned = type
    .trim()
    .replace(/[!:()\s].*$/, "")
    .toLowerCase();
  const match = allowed.find((t) => t.type.toLowerCase() === cleaned);
  return match?.type ?? cleaned;
}

export function normalizeScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  const cleaned = scope
    .trim()
    .replace(/^\(|\)$/g, "")
    .trim()
    .replace(/\s+/g, "-");
  if (!cleaned || /^(none|null|n\/a|-)$/i.test(cleaned)) return null;
  return cleaned;
}

export function normalizeDescription(description: string): string {
  let text = description.replace(/\s+/g, " ").trim();
  // A model sometimes repeats the prefix ("feat: add x") inside the description.
  text = text.replace(/^[a-z]+(\([^)]*\))?!?:\s+/i, "");
  text = text.replace(/[.。]+$/, "").trim();
  return lowercaseFirstWord(text);
}

/**
 * Lowercase the first letter unless the first word looks like a proper noun, acronym or
 * identifier (OAuth, API, iOS, README, useState).
 */
export function lowercaseFirstWord(text: string): string {
  const first = text.split(" ")[0] ?? "";
  if (!/^[A-Z][a-z]/.test(first)) return text;
  if (/[A-Z]/.test(first.slice(1)) || /\d/.test(first)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function normalizeBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const text = body.replace(/\r\n?/g, "\n").trim();
  return text || null;
}
