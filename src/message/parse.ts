import { LEADING_GITMOJI_RE } from "./gitmoji.js";
import { FOOTER_LINE_RE } from "./render.js";
import type { Footer } from "./types.js";

export interface ParsedHeader {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  /** Leading gitmoji removed from the description (after-colon position), if any. */
  gitmoji: string | null;
}

export interface ParsedMessage {
  raw: string;
  header: string;
  /** Header with any leading gitmoji (prefix position) removed. */
  headerForParsing: string;
  parsedHeader: ParsedHeader | null;
  /** True when line 2 exists and is not blank (spec rule 6). */
  missingBlankAfterHeader: boolean;
  body: string | null;
  footers: Footer[];
  footerBlock: string[];
}

/** type(scope)!: description — type must be non-empty; scope may be empty here so spec checks can report it. */
export const HEADER_RE =
  /^(?<type>[^\s():!]+)(?:\((?<scope>[^()\r\n]*)\))?(?<bang>!)?: (?<description>.*)$/;

export function stripLeadingGitmoji(text: string): { text: string; gitmoji: string | null } {
  const m = LEADING_GITMOJI_RE.exec(text);
  if (!m) return { text, gitmoji: null };
  return { text: text.slice(m[0].length), gitmoji: m[0].trim() };
}

export function parseHeader(header: string): ParsedHeader | null {
  const m = HEADER_RE.exec(header);
  if (!m?.groups) return null;
  const { text: description, gitmoji } = stripLeadingGitmoji(m.groups.description ?? "");
  return {
    type: m.groups.type ?? "",
    scope: m.groups.scope ?? null,
    breaking: m.groups.bang === "!",
    description,
    gitmoji,
  };
}

export function parseMessage(raw: string): ParsedMessage {
  const text = raw.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const headerForParsing = stripLeadingGitmoji(header).text;
  const parsedHeader = parseHeader(headerForParsing);
  const missingBlankAfterHeader = lines.length > 1 && (lines[1] ?? "").trim() !== "";

  const rest = lines.slice(1).join("\n").trim();
  const paragraphs = rest ? rest.split(/\n\s*\n/) : [];
  let footerBlock: string[] = [];
  let bodyParagraphs = paragraphs;
  const last = paragraphs[paragraphs.length - 1];
  if (last !== undefined) {
    const firstLine = last.split("\n")[0] ?? "";
    if (FOOTER_LINE_RE.test(firstLine) || /^breaking change: /i.test(firstLine)) {
      footerBlock = last.split("\n");
      bodyParagraphs = paragraphs.slice(0, -1);
    }
  }

  return {
    raw: text,
    header,
    headerForParsing,
    parsedHeader,
    missingBlankAfterHeader,
    body: bodyParagraphs.length > 0 ? bodyParagraphs.join("\n\n") : null,
    footers: parseFooters(footerBlock),
    footerBlock,
  };
}

/** Spec rule 10: a footer value continues until the next valid token/separator pair. */
export function parseFooters(lines: string[]): Footer[] {
  const footers: Footer[] = [];
  for (const line of lines) {
    const m = FOOTER_LINE_RE.exec(line) ?? /^(breaking change)(: )/i.exec(line);
    if (m) {
      const rest = line.slice(m[0].length);
      footers.push({ token: m[1] ?? "", value: m[2] === " #" ? `#${rest}` : rest });
    } else if (footers.length > 0) {
      const previous = footers[footers.length - 1]!;
      previous.value = `${previous.value}\n${line}`;
    }
  }
  return footers;
}

/** Replace the header's type, scope or breaking marker while keeping the rest of the message. */
export function replaceHeader(raw: string, newHeader: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  lines[0] = newHeader;
  return lines.join("\n");
}
