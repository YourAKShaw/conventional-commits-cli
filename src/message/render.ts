import { defaultGitmoji, findGitmoji, formatGitmoji } from "./gitmoji.js";
import type { CommitDraft, Footer, FormatSettings } from "./types.js";

/** Footer line grammar from spec rules 8–9 (token, then ": " or " #"). */
export const FOOTER_LINE_RE = /^(BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z0-9][A-Za-z0-9-]*)(: | #)/;

export function headerPrefix(draft: Pick<CommitDraft, "type" | "scope" | "breaking">): string {
  const scope = draft.scope ? `(${draft.scope})` : "";
  return `${draft.type}${scope}${draft.breaking ? "!" : ""}: `;
}

export function resolveGitmoji(draft: CommitDraft, format: FormatSettings): string | null {
  // "" is an explicit "no gitmoji"; null means "use the type's default".
  if (!format.gitmoji.enabled || draft.gitmoji === "") return null;
  const chosen = findGitmoji(draft.gitmoji)?.code ?? defaultGitmoji(draft.type, draft.breaking);
  return chosen ? formatGitmoji(chosen, format.gitmoji.style) : null;
}

export function renderHeader(draft: CommitDraft, format: FormatSettings): string {
  const emoji = resolveGitmoji(draft, format);
  const prefix = headerPrefix(draft);
  if (!emoji) return `${prefix}${draft.description}`;
  if (format.gitmoji.position === "prefix") return `${emoji} ${prefix}${draft.description}`;
  return `${prefix}${emoji} ${draft.description}`;
}

/** Render a draft into the final message text (no trailing newline). */
export function renderMessage(draft: CommitDraft, format: FormatSettings): string {
  const header = renderHeader(draft, format);
  const { body, footers } = settleBodyAndFooters(draft);
  const parts = [header];
  if (body) parts.push(wrapBody(body, format.bodyWrap));
  const footerLines: string[] = [];
  if (draft.breaking && draft.breakingDescription) {
    footerLines.push(`BREAKING CHANGE: ${draft.breakingDescription.trim()}`);
  }
  for (const f of footers) footerLines.push(renderFooter(f));
  if (footerLines.length > 0) parts.push(footerLines.join("\n"));
  return parts.join("\n\n");
}

export function renderFooter(footer: Footer): string {
  const token = normalizeFooterToken(footer.token);
  const value = footer.value.trim();
  return `${token}: ${value}`;
}

/** Spec rule 9: tokens use "-" in place of whitespace, except BREAKING CHANGE. */
export function normalizeFooterToken(token: string): string {
  const trimmed = token.trim().replace(/:$/, "");
  if (/^breaking[ -]change$/i.test(trimmed)) return "BREAKING CHANGE";
  return trimmed.replace(/\s+/g, "-");
}

/**
 * Spec rule 10 means a last body paragraph made only of footer-shaped lines would be parsed
 * as footers anyway. Move such a paragraph into the footers so the structure is explicit.
 */
function settleBodyAndFooters(draft: CommitDraft): { body: string | null; footers: Footer[] } {
  const footers = draft.footers.filter(
    (f) => f.token.trim() && f.value.trim() && !/^breaking[ -]change$/i.test(f.token.trim()),
  );
  if (!draft.body) return { body: null, footers };
  const paragraphs = draft.body.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const lines = last.split("\n").filter((l) => l.trim());
  if (lines.length > 0 && lines.every((l) => FOOTER_LINE_RE.test(l.trim()))) {
    const moved = lines.map((l) => {
      const trimmed = l.trim();
      const m = FOOTER_LINE_RE.exec(trimmed);
      const rest = trimmed.slice(m?.[0].length ?? 0);
      return { token: m?.[1] ?? "", value: m?.[2] === " #" ? `#${rest}` : rest };
    });
    const remaining = paragraphs.slice(0, -1).join("\n\n").trim();
    return {
      body: remaining || null,
      footers: [...moved.filter((f) => !/^BREAKING[ -]CHANGE$/.test(f.token)), ...footers],
    };
  }
  return { body: draft.body.trim(), footers };
}

/**
 * Wrap prose paragraphs at `width`. List items get a hanging indent; code blocks,
 * indented lines and long unbreakable tokens (URLs) are preserved.
 */
export function wrapBody(body: string, width: number): string {
  const normalized = body.replace(/\r\n?/g, "\n").trim();
  const out: string[] = [];
  let inFence = false;
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push(...wrapParagraph(paragraph, width));
    paragraph = [];
  };

  for (const line of normalized.split("\n")) {
    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || /^( {4}|\t)/.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      if (out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      paragraph = [line];
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapParagraph(lines: string[], width: number): string[] {
  const first = lines[0] ?? "";
  const bullet = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(first);
  const indent = bullet ? " ".repeat(bullet[1]?.length ?? 0) : "";
  const text = lines
    .map((l) => l.trim())
    .join(" ")
    .replace(/\s+/g, " ");
  const content = bullet ? text.slice((bullet[1] ?? "").trim().length).trim() : text;
  const words = content.split(" ").filter(Boolean);
  const result: string[] = [];
  let current = bullet ? (bullet[1] ?? "") : "";
  let currentHasWord = false;
  for (const word of words) {
    const candidate = currentHasWord ? `${current} ${word}` : `${current}${word}`;
    if (candidate.length > width && currentHasWord) {
      result.push(current);
      current = `${indent}${word}`;
    } else {
      current = candidate;
    }
    currentHasWord = true;
  }
  if (currentHasWord || current.trim()) result.push(current);
  return result;
}
