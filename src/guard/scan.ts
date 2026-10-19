import { BUILTIN_PATTERNS, findHighEntropy, type SecretPattern } from "./patterns.js";

export interface ScanItem {
  /** File path, or a pseudo-source such as "recent commits". */
  source: string;
  text: string;
  /** Optional human-readable location per text line (for example "line 42"). */
  lineRefs?: readonly string[];
}

export interface Finding {
  source: string;
  rule: string;
  detector: "secretlint" | "pattern" | "entropy";
  start: number;
  end: number;
  /** 1-based line within the scanned text. */
  line: number;
  location: string;
  masked: string;
}

export interface ScanOptions {
  extraPatterns?: readonly SecretPattern[];
  /** Disable secretlint (used by tests that exercise only the built-in layers). */
  secretlint?: boolean;
}

/** Scan exactly the text that would be sent. Overlapping findings are merged. */
export async function scanForSecrets(
  items: readonly ScanItem[],
  options: ScanOptions = {},
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const patterns = [...BUILTIN_PATTERNS, ...(options.extraPatterns ?? [])];
  const lint = options.secretlint === false ? null : await secretlintRunner();

  for (const item of items) {
    if (!item.text) continue;
    const local: Omit<Finding, "line" | "location" | "masked" | "source">[] = [];

    if (lint) {
      for (const m of await lint(item.text, item.source))
        local.push({ ...m, detector: "secretlint" });
    }
    for (const p of patterns) {
      p.regex.lastIndex = 0;
      for (const m of item.text.matchAll(
        new RegExp(
          p.regex.source,
          p.regex.flags.includes("g") ? p.regex.flags : `${p.regex.flags}g`,
        ),
      )) {
        const start = m.index ?? 0;
        if (m[0].length === 0) continue;
        local.push({ rule: p.id, detector: "pattern", start, end: start + m[0].length });
      }
    }
    let offset = 0;
    for (const line of item.text.split("\n")) {
      for (const hit of findHighEntropy(line)) {
        local.push({
          rule: "high-entropy-string",
          detector: "entropy",
          start: offset + hit.start,
          end: offset + hit.end,
        });
      }
      offset += line.length + 1;
    }

    for (const f of mergeOverlapping(local)) {
      const line = lineOf(item.text, f.start);
      findings.push({
        ...f,
        source: item.source,
        line,
        location: item.lineRefs?.[line - 1] || `line ${line}`,
        masked: mask(item.text.slice(f.start, f.end)),
      });
    }
  }
  return findings;
}

/** Show enough to recognise a value without revealing it. */
export function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return `${"*".repeat(v.length)} (${v.length} chars)`;
  return `${v.slice(0, 4)}…${"*".repeat(4)} (${v.length} chars)`;
}

/** Replace every finding's range in `text` with a placeholder. */
export function redact(
  text: string,
  findings: readonly Pick<Finding, "start" | "end" | "rule">[],
): string {
  const sorted = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) out = `${out.slice(0, f.start)}[REDACTED:${f.rule}]${out.slice(f.end)}`;
  return out;
}

function mergeOverlapping<T extends { start: number; end: number }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: T[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start < last.end) {
      if (item.end > last.end) last.end = item.end;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

type LintFn = (
  text: string,
  source: string,
) => Promise<{ rule: string; start: number; end: number }[]>;
let runner: Promise<LintFn> | null = null;

/** secretlint's recommended rules, loaded lazily. Inline "secretlint-disable" comments are not honoured. */
function secretlintRunner(): Promise<LintFn> {
  runner ??= (async () => {
    const [{ lintSource }, { creator: preset }] = await Promise.all([
      import("@secretlint/core"),
      import("@secretlint/secretlint-rule-preset-recommend"),
    ]);
    const config = {
      rules: [
        {
          id: preset.meta.id,
          rule: preset,
          rules: [{ id: "@secretlint/secretlint-rule-filter-comments", disabled: true }],
        },
      ],
    };
    return async (text: string, source: string) => {
      const result = await lintSource({
        source: { content: text, filePath: source, contentType: "text" },
        options: { config: config as never, maskSecrets: false, noPhysicFilePath: true },
      });
      return result.messages.map((m) => ({
        rule: m.ruleId.replace(/^@secretlint\/secretlint-rule-/, "secretlint/"),
        start: m.range[0],
        end: m.range[1],
      }));
    };
  })();
  return runner;
}
