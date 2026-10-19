import type { ChangeStatus, FileChange, Hunk } from "../git/diff.js";
import type { SummaryReason } from "./filter.js";

export type PayloadReason = SummaryReason | "budget";

export interface PayloadFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  added: number | null;
  deleted: number | null;
  mode: "full" | "partial" | "summary";
  reason?: PayloadReason;
  /** Diff text exactly as it will be sent ("" for summary-only files). */
  text: string;
  /** Human-readable location for each line of `text`. */
  lineRefs: string[];
  omittedLines: number;
}

export interface Payload {
  files: PayloadFile[];
  diffTokens: number;
  /** Some content was cut or omitted to respect the budget. */
  truncated: boolean;
  /** The change is large enough that splitting it into several commits is worth suggesting. */
  large: boolean;
  changedLines: number;
}

export interface BudgetOptions {
  maxDiffTokens: number;
  maxLineLength?: number;
  largeChangeFiles?: number;
  largeChangeLines?: number;
}

/** Conservative token estimate: characters ÷ 4 plus a 20% margin. Providers tokenise differently. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.3);
}

const HIGH_SIGNAL = [
  /(^|\/)package\.json$/,
  /\.d\.ts$/,
  /(^|\/)(migrations?|schema|schemas)\//i,
  /\.(proto|graphql|gql|sql)$/i,
  /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i,
  /(^|\/)Dockerfile$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)(index|mod|lib)\.[cm]?[jt]sx?$/,
];

const MIN_USEFUL_TOKENS = 40;

export function buildPayload(
  files: readonly FileChange[],
  summaryReason: (file: FileChange) => PayloadReason | null,
  options: BudgetOptions,
): Payload {
  const maxLine = options.maxLineLength ?? 400;
  const entries = files.map((file) => {
    const reason = summaryReason(file);
    const rendered = reason
      ? { lines: [] as string[], refs: [] as string[] }
      : renderHunks(file.hunks, maxLine);
    const text = rendered.lines.join("\n");
    return {
      file,
      reason,
      rendered,
      cost: estimateTokens(text),
      weight: HIGH_SIGNAL.some((r) => r.test(file.path)) ? 2 : 1,
    };
  });

  const candidates = entries.filter((e) => !e.reason && e.rendered.lines.length > 0);
  const totalCost = candidates.reduce((n, e) => n + e.cost, 0);
  const allocation = new Map<(typeof entries)[number], number>();

  if (totalCost <= options.maxDiffTokens) {
    for (const e of candidates) allocation.set(e, e.cost);
  } else {
    // Water-filling: small files are included whole; large ones share what remains by weight.
    let remaining = options.maxDiffTokens;
    let pending = [...candidates].sort((a, b) => a.cost / a.weight - b.cost / b.weight);
    while (pending.length > 0) {
      const totalWeight = pending.reduce((n, e) => n + e.weight, 0);
      const fits = pending.find((e) => e.cost <= (remaining * e.weight) / totalWeight);
      if (!fits) {
        for (const e of pending)
          allocation.set(e, Math.floor((remaining * e.weight) / totalWeight));
        break;
      }
      allocation.set(fits, fits.cost);
      remaining -= fits.cost;
      pending = pending.filter((e) => e !== fits);
    }
  }

  let truncated = false;
  let diffTokens = 0;
  const payloadFiles: PayloadFile[] = entries.map((e) => {
    const base = {
      path: e.file.path,
      status: e.file.status,
      added: e.file.added,
      deleted: e.file.deleted,
      ...(e.file.oldPath === undefined ? {} : { oldPath: e.file.oldPath }),
    };
    if (e.reason)
      return {
        ...base,
        mode: "summary",
        reason: e.reason,
        text: "",
        lineRefs: [],
        omittedLines: 0,
      };
    if (e.rendered.lines.length === 0) {
      return { ...base, mode: "full", text: "", lineRefs: [], omittedLines: 0 };
    }
    const tokens = allocation.get(e) ?? 0;
    if (tokens >= e.cost) {
      diffTokens += e.cost;
      return {
        ...base,
        mode: "full",
        text: e.rendered.lines.join("\n"),
        lineRefs: e.rendered.refs,
        omittedLines: 0,
      };
    }
    truncated = true;
    if (tokens < MIN_USEFUL_TOKENS) {
      return {
        ...base,
        mode: "summary",
        reason: "budget",
        text: "",
        lineRefs: [],
        omittedLines: 0,
      };
    }
    const cut = cutToTokens(e.rendered.lines, e.rendered.refs, tokens);
    diffTokens += estimateTokens(cut.lines.join("\n"));
    return {
      ...base,
      mode: "partial",
      text: cut.lines.join("\n"),
      lineRefs: cut.refs,
      omittedLines: e.rendered.lines.length - cut.lines.length,
    };
  });

  const changedLines = files.reduce((n, f) => n + (f.added ?? 0) + (f.deleted ?? 0), 0);
  return {
    files: payloadFiles,
    diffTokens,
    truncated,
    large:
      files.length > (options.largeChangeFiles ?? 100) ||
      changedLines > (options.largeChangeLines ?? 2000),
    changedLines,
  };
}

function renderHunks(hunks: readonly Hunk[], maxLine: number): { lines: string[]; refs: string[] } {
  const lines: string[] = [];
  const refs: string[] = [];
  for (const hunk of hunks) {
    lines.push(hunk.header);
    refs.push(`hunk at line ${hunk.newStart}`);
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const raw of hunk.lines) {
      const line = raw.length > maxLine ? `${raw.slice(0, maxLine)} …[line truncated]` : raw;
      lines.push(line);
      const kind = raw[0];
      if (kind === "+") {
        refs.push(`line ${newNo}`);
        newNo++;
      } else if (kind === "-") {
        refs.push(`removed line ${oldNo}`);
        oldNo++;
      } else if (kind === "\\") {
        refs.push("");
      } else {
        refs.push(`line ${newNo}`);
        oldNo++;
        newNo++;
      }
    }
  }
  return { lines, refs };
}

function cutToTokens(
  lines: string[],
  refs: string[],
  tokens: number,
): { lines: string[]; refs: string[] } {
  const maxChars = Math.floor(tokens / 0.3);
  const outLines: string[] = [];
  const outRefs: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (used + line.length + 1 > maxChars) break;
    outLines.push(line);
    outRefs.push(refs[i] ?? "");
    used += line.length + 1;
  }
  return { lines: outLines, refs: outRefs };
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
  U: "unmerged",
  X: "unknown",
};

export function statusLabel(status: ChangeStatus): string {
  return STATUS_LABEL[status];
}

export function describeReason(reason: PayloadReason): string {
  switch (reason) {
    case "sensitive file":
      return "content withheld: sensitive file";
    case "possible secret":
      return "content withheld: possible secret";
    case "budget":
      return "omitted to fit the token budget";
    case "too large to capture":
      return "diff too large to capture";
    default:
      return `summary only: ${reason}`;
  }
}

export function counts(file: Pick<PayloadFile, "added" | "deleted">): string {
  if (file.added === null && file.deleted === null) return "binary";
  return `+${file.added ?? 0} −${file.deleted ?? 0}`;
}
