import { describe, expect, it } from "vitest";
import { parseFooters, parseHeader, parseMessage } from "../../src/message/parse.js";
import { checkSpec } from "../../src/message/spec.js";

// The seven examples from https://www.conventionalcommits.org/en/v1.0.0/#examples
const SPEC_EXAMPLES = [
  "feat: allow provided config object to extend other configs\n\nBREAKING CHANGE: `extends` key in config file is now used for extending other config files",
  "feat!: send an email to the customer when a product is shipped",
  "feat(api)!: send an email to the customer when a product is shipped",
  "feat!: drop support for Node 6\n\nBREAKING CHANGE: use JavaScript features not available in Node 6.",
  "docs: correct spelling of CHANGELOG",
  "feat(lang): add Polish language",
  "fix: prevent racing of requests\n\nIntroduce a request id and a reference to latest request. Dismiss\nincoming responses other than from latest request.\n\nRemove timeouts which were used to mitigate the racing issue but are\nobsolete now.\n\nReviewed-by: Z\nRefs: #123",
];

const errors = (msg: string) =>
  checkSpec(msg)
    .filter((i) => i.level === "error")
    .map((i) => i.rule);

describe("checkSpec", () => {
  it.each(SPEC_EXAMPLES)("accepts the specification's own examples: %#", (msg) => {
    expect(errors(msg)).toEqual([]);
  });

  it("accepts gitmoji after the colon and as an opt-in prefix", () => {
    expect(errors("feat(auth): ✨ add login")).toEqual([]);
    expect(errors("✨ feat(auth): add login")).toEqual([]);
    expect(errors("feat: :sparkles: add login")).toEqual([]);
  });

  it.each([
    ["feat:add login", "spec-1"],
    ["feat: ", "spec-5"],
    ["feat:", "spec-5"],
    ["added login", "spec-1"],
    ["feat(): add login", "spec-4"],
    ["feat(auth api): add login", "spec-4"],
    ["feat:  add login", "spec-5"],
    ["feat: add login\nbody without blank line", "spec-6"],
    ["feat: add login\n\nBreaking change: lowercase token", "spec-12"],
  ])("rejects %j (%s)", (msg, rule) => {
    expect(errors(msg)).toContain(rule);
  });

  it("warns about footer tokens containing spaces (spec rule 9)", () => {
    const issues = checkSpec("fix: x\n\nReviewed by: Z");
    expect(issues.some((i) => i.rule === "spec-9" && i.level === "warning")).toBe(true);
  });

  it("accepts BREAKING-CHANGE as a synonym (spec rule 16)", () => {
    expect(errors("feat: x\n\nBREAKING-CHANGE: y")).toEqual([]);
  });
});

describe("parse", () => {
  it("parses header parts and a description gitmoji", () => {
    expect(parseHeader("feat(api)!: 🎉 start")).toEqual({
      type: "feat",
      scope: "api",
      breaking: true,
      description: "start",
      gitmoji: "🎉",
    });
    expect(parseHeader("not a header")).toBeNull();
  });

  it("continues footer values until the next token (spec rule 10)", () => {
    expect(parseFooters(["Refs: #1", "continued line", "Acked-by: Z", "Fixes #2"])).toEqual([
      { token: "Refs", value: "#1\ncontinued line" },
      { token: "Acked-by", value: "Z" },
      { token: "Fixes", value: "#2" },
    ]);
  });

  it("separates body and footer block", () => {
    const m = parseMessage("fix: x\n\nBody one.\n\nBody two.\n\nRefs: #9");
    expect(m.body).toBe("Body one.\n\nBody two.");
    expect(m.footers).toEqual([{ token: "Refs", value: "#9" }]);
  });
});
