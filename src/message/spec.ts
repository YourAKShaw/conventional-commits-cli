import { HEADER_RE, parseMessage } from "./parse.js";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  source: "spec" | "commitlint" | "secret";
  rule: string;
  message: string;
}

/**
 * Check a message against the Conventional Commits 1.0.0 specification.
 * Rule numbers refer to https://www.conventionalcommits.org/en/v1.0.0/#specification.
 * Style preferences (length, case, allowed types) are left to commitlint.
 */
export function checkSpec(raw: string): Issue[] {
  const issues: Issue[] = [];
  const add = (level: IssueLevel, rule: string, message: string) =>
    issues.push({ level, source: "spec", rule, message });

  const msg = parseMessage(raw);
  const header = msg.headerForParsing;

  if (!header.trim()) {
    add("error", "spec-1", "The header line is empty.");
    return issues;
  }

  if (!msg.parsedHeader) {
    if (/^[^\s():!]+(\([^()]*\))?!?:\S/.test(header)) {
      add(
        "error",
        "spec-1",
        'The type/scope prefix must be followed by a colon and a space (": ").',
      );
    } else if (/^[^\s():!]+(\([^()]*\))?!?:\s*$/.test(header)) {
      add("error", "spec-5", "A description must follow the colon and space.");
    } else if (/^\S+ \S*:/.test(header) && !HEADER_RE.test(header)) {
      add(
        "error",
        "spec-1",
        'The header must start with a type followed by ": ", for example "feat: add login".',
      );
    } else {
      add(
        "error",
        "spec-1",
        'The header must look like "type(scope): description", for example "fix(parser): handle empty input".',
      );
    }
    return issues;
  }

  const { type, scope, description } = msg.parsedHeader;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(type)) {
    add("error", "spec-1", `The type "${type}" must be a single word such as feat or fix.`);
  }
  if (scope !== null) {
    if (!scope.trim()) {
      add(
        "error",
        "spec-4",
        "The scope in parentheses is empty; remove the parentheses or name a scope.",
      );
    } else if (/\s/.test(scope)) {
      add(
        "error",
        "spec-4",
        `The scope "${scope}" must be a noun without spaces, for example "${scope.trim().replace(/\s+/g, "-")}".`,
      );
    }
  }
  if (!description.trim()) {
    add("error", "spec-5", "The description after the colon is empty.");
  } else if (/^\s/.test(description)) {
    add("error", "spec-5", "The description must immediately follow the colon and a single space.");
  }

  if (msg.missingBlankAfterHeader) {
    add("error", "spec-6", "The body must begin after one blank line following the header.");
  }

  // A last paragraph made only of "Token: value" lines is meant as footers even when a token
  // contains spaces (which makes parsers treat it as body text); check it as a footer block.
  const paragraphs = (msg.body ?? "").split(/\n\s*\n/);
  const lastBody = paragraphs[paragraphs.length - 1] ?? "";
  const intendedFooters =
    msg.footerBlock.length === 0 &&
    lastBody.trim() !== "" &&
    lastBody.split("\n").every((l) => /^[A-Za-z][A-Za-z0-9 -]*[A-Za-z0-9](: | #)/.test(l))
      ? lastBody.split("\n")
      : [];

  for (const line of [...msg.footerBlock, ...intendedFooters]) {
    const tokenMatch = /^([A-Za-z][A-Za-z0-9 -]*[A-Za-z0-9])(: | #)/.exec(line);
    if (!tokenMatch) continue;
    const token = tokenMatch[1] ?? "";
    if (/^breaking[ -]change$/i.test(token)) {
      if (token !== "BREAKING CHANGE" && token !== "BREAKING-CHANGE") {
        add(
          "error",
          "spec-12",
          `Write the breaking-change footer token in uppercase: "BREAKING CHANGE" (found "${token}").`,
        );
      }
      if (tokenMatch[2] !== ": ") {
        add(
          "error",
          "spec-12",
          'A BREAKING CHANGE footer must be followed by ": " and a description.',
        );
      }
    } else if (/\s/.test(token)) {
      add(
        "warning",
        "spec-9",
        `Footer token "${token}" contains spaces; use "${token.replace(/\s+/g, "-")}".`,
      );
    }
  }

  // A footer-like line inside the body with a mis-cased BREAKING CHANGE token is a common mistake.
  for (const line of (msg.body ?? "").split("\n")) {
    if (/^breaking[ -]change:/i.test(line) && !/^BREAKING[ -]CHANGE:/.test(line)) {
      add("error", "spec-12", 'Write "BREAKING CHANGE:" in uppercase.');
    }
  }

  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.rule}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
