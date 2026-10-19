import { describe, expect, it } from "vitest";
import { findGitmoji } from "../../src/message/gitmoji.js";
import {
  normalizeFooterToken,
  renderHeader,
  renderMessage,
  wrapBody,
} from "../../src/message/render.js";
import { type CommitDraft, emptyDraft, type FormatSettings } from "../../src/message/types.js";

const fmt = (overrides: Partial<FormatSettings["gitmoji"]> = {}): FormatSettings => ({
  gitmoji: { enabled: true, style: "unicode", position: "after-colon", ...overrides },
  headerMaxLength: 72,
  bodyWrap: 72,
});
const draft = (d: Partial<CommitDraft>): CommitDraft => ({
  ...emptyDraft("feat"),
  description: "add login",
  ...d,
});

describe("renderHeader", () => {
  it("places the gitmoji after the colon by default (spec rule 1 keeps the type first)", () => {
    expect(renderHeader(draft({ scope: "auth" }), fmt())).toBe("feat(auth): ✨ add login");
  });

  it("supports shortcode style and the opt-in prefix position", () => {
    expect(renderHeader(draft({}), fmt({ style: "code" }))).toBe("feat: :sparkles: add login");
    expect(renderHeader(draft({}), fmt({ position: "prefix" }))).toBe("✨ feat: add login");
  });

  it("uses the chosen gitmoji, the breaking default, or none", () => {
    const ambulance = findGitmoji(":ambulance:")!.emoji;
    expect(renderHeader(draft({ type: "fix", gitmoji: ":ambulance:" }), fmt())).toBe(
      `fix: ${ambulance} add login`,
    );
    expect(renderHeader(draft({ breaking: true }), fmt())).toBe("feat!: 💥 add login");
    expect(renderHeader(draft({ gitmoji: "" }), fmt())).toBe("feat: add login");
    expect(
      renderHeader(draft({}), {
        ...fmt(),
        gitmoji: { enabled: false, style: "unicode", position: "after-colon" },
      }),
    ).toBe("feat: add login");
  });

  it("omits the gitmoji for a type without a default", () => {
    expect(renderHeader(draft({ type: "wip" }), fmt())).toBe("wip: add login");
  });
});

describe("renderMessage", () => {
  it("renders body and footers separated by blank lines (spec rules 6 and 8)", () => {
    const text = renderMessage(
      draft({
        body: "Explain the change.",
        footers: [
          { token: "Reviewed by", value: "Z" },
          { token: "Refs", value: "#123" },
        ],
      }),
      fmt({ enabled: false }),
    );
    expect(text).toBe("feat: add login\n\nExplain the change.\n\nReviewed-by: Z\nRefs: #123");
  });

  it("adds an uppercase BREAKING CHANGE footer when a description is given (spec rules 11–13)", () => {
    const text = renderMessage(
      draft({ breaking: true, breakingDescription: "drop Node 18" }),
      fmt({ enabled: false }),
    );
    expect(text).toBe("feat!: add login\n\nBREAKING CHANGE: drop Node 18");
  });

  it("allows `!` without a footer (spec rule 13)", () => {
    expect(renderMessage(draft({ breaking: true }), fmt({ enabled: false }))).toBe(
      "feat!: add login",
    );
  });

  it("moves a trailing footer-only body paragraph into the footers (spec rule 10)", () => {
    const text = renderMessage(
      draft({ body: "Some context.\n\nRefs #42" }),
      fmt({ enabled: false }),
    );
    expect(text).toBe("feat: add login\n\nSome context.\n\nRefs: #42");
  });

  it("drops BREAKING CHANGE entries from the generic footer list", () => {
    const text = renderMessage(
      draft({ footers: [{ token: "BREAKING CHANGE", value: "x" }] }),
      fmt({ enabled: false }),
    );
    expect(text).toBe("feat: add login");
  });
});

describe("normalizeFooterToken", () => {
  it("hyphenates whitespace (spec rule 9) and uppercases breaking change", () => {
    expect(normalizeFooterToken("Acked by")).toBe("Acked-by");
    expect(normalizeFooterToken("breaking change")).toBe("BREAKING CHANGE");
    expect(normalizeFooterToken("Breaking-Change:")).toBe("BREAKING CHANGE");
  });
});

describe("wrapBody", () => {
  it("wraps prose at the width and keeps long URLs intact", () => {
    const url = `https://example.com/${"a".repeat(80)}`;
    const wrapped = wrapBody(`word `.repeat(30) + url, 40);
    for (const line of wrapped.split("\n")) {
      if (!line.includes("https://")) expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(wrapped).toContain(url);
  });

  it("keeps bullets with hanging indents, code fences and indented code verbatim", () => {
    const body = [
      "- first item that is long enough to need wrapping when the width is small",
      "- second",
      "",
      "```",
      "const x =      1;",
      "```",
      "",
      "    indented code   stays",
    ].join("\n");
    const out = wrapBody(body, 30);
    expect(out).toContain("- first item that is long");
    expect(out.split("\n")[1]?.startsWith("  ")).toBe(true);
    expect(out).toContain("const x =      1;");
    expect(out).toContain("    indented code   stays");
  });

  it("normalises CRLF and collapses extra blank lines", () => {
    expect(wrapBody("a\r\n\r\n\r\n\r\nb", 72)).toBe("a\n\nb");
  });
});
