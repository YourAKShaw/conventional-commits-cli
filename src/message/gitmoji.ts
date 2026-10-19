import { gitmojis as rawGitmojis } from "gitmojis";
import type { GitmojiStyle } from "./types.js";

export interface Gitmoji {
  emoji: string;
  code: string;
  description: string;
  name: string;
}

/** Bundled snapshot of the gitmoji list (from the `gitmojis` package at build time). */
export const GITMOJIS: readonly Gitmoji[] = rawGitmojis.map((g) => ({
  emoji: g.emoji,
  code: g.code,
  description: g.description,
  name: g.name,
}));

/** Default gitmoji per Conventional Commits type. */
export const TYPE_GITMOJI: Readonly<Record<string, string>> = {
  feat: ":sparkles:",
  fix: ":bug:",
  docs: ":memo:",
  style: ":art:",
  refactor: ":recycle:",
  perf: ":zap:",
  test: ":white_check_mark:",
  build: ":package:",
  ci: ":construction_worker:",
  chore: ":wrench:",
  revert: ":rewind:",
};

export const BREAKING_GITMOJI = ":boom:";

const stripVariation = (s: string) => s.replace(/️/g, "");

const byCode = new Map(GITMOJIS.map((g) => [g.code, g]));
const byEmoji = new Map(GITMOJIS.map((g) => [stripVariation(g.emoji), g]));

/** Look up a gitmoji by shortcode (":sparkles:" or "sparkles") or by the emoji itself. */
export function findGitmoji(value: string | null | undefined): Gitmoji | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const code = trimmed.startsWith(":") ? trimmed : `:${trimmed}:`;
  return byCode.get(code.toLowerCase()) ?? byEmoji.get(stripVariation(trimmed));
}

export function defaultGitmoji(type: string, breaking: boolean): string | null {
  if (breaking) return BREAKING_GITMOJI;
  return TYPE_GITMOJI[type.toLowerCase()] ?? null;
}

export function formatGitmoji(code: string, style: GitmojiStyle): string {
  const found = findGitmoji(code);
  if (!found) return code;
  return style === "unicode" ? found.emoji : found.code;
}

/** Suggested gitmojis for a type: its default first, then the rest of the list. */
export function gitmojisForType(type: string): Gitmoji[] {
  const preferred = findGitmoji(TYPE_GITMOJI[type.toLowerCase()]);
  const rest = GITMOJIS.filter((g) => g !== preferred);
  return preferred ? [preferred, ...rest] : [...rest];
}

/** Matches a leading gitmoji (emoji or :shortcode:) followed by whitespace. */
export const LEADING_GITMOJI_RE =
  /^(?::[a-z0-9_+-]+:|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+/u;
