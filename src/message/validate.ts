import { type LintConfig, runCommitlint } from "./commitlint.js";
import { checkSpec, type Issue } from "./spec.js";

export interface ValidationReport {
  issues: Issue[];
  /** Conventional Commits violations: block committing until fixed. */
  specErrors: Issue[];
  /** commitlint errors (style rules): the user may commit anyway after confirming. */
  styleErrors: Issue[];
  warnings: Issue[];
}

export async function validateMessage(raw: string, lint: LintConfig): Promise<ValidationReport> {
  const spec = checkSpec(raw);
  const specErrors = spec.filter((i) => i.level === "error");
  // commitlint's parser cannot make sense of a header that already violates the spec.
  const style = specErrors.length > 0 ? [] : await runCommitlint(raw, lint);
  const issues = [...spec, ...style];
  return {
    issues,
    specErrors,
    styleErrors: style.filter((i) => i.level === "error"),
    warnings: issues.filter((i) => i.level === "warning"),
  };
}

export function isClean(report: ValidationReport): boolean {
  return report.specErrors.length === 0 && report.styleErrors.length === 0;
}

export function formatIssues(issues: Issue[]): string[] {
  return issues.map((i) => `${i.level === "error" ? "✖" : "⚠"} ${i.message} (${i.rule})`);
}
