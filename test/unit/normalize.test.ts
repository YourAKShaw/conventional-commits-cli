import { describe, expect, it } from "vitest";
import {
  lowercaseFirstWord,
  normalizeDescription,
  normalizeDraft,
  normalizeScope,
  normalizeType,
} from "../../src/message/normalize.js";

const types = [
  { type: "feat", description: "" },
  { type: "fix", description: "" },
];

describe("normalize", () => {
  it("cleans descriptions", () => {
    expect(normalizeDescription("Add OAuth login.")).toBe("add OAuth login");
    expect(normalizeDescription("feat(api): Add  thing")).toBe("add thing");
    expect(normalizeDescription("OAuth support")).toBe("OAuth support");
    expect(normalizeDescription("API keys rotated")).toBe("API keys rotated");
    expect(normalizeDescription("iOS build")).toBe("iOS build");
  });

  it("keeps identifiers and acronyms capitalised", () => {
    expect(lowercaseFirstWord("README updates")).toBe("README updates");
    expect(lowercaseFirstWord("Node22 support")).toBe("Node22 support");
    expect(lowercaseFirstWord("Update docs")).toBe("update docs");
  });

  it("normalises scopes and types", () => {
    expect(normalizeScope(" (auth api) ")).toBe("auth-api");
    expect(normalizeScope("none")).toBeNull();
    expect(normalizeScope("")).toBeNull();
    expect(normalizeType("Feat!", types)).toBe("feat");
    expect(normalizeType("FIX", types)).toBe("fix");
  });

  it("moves BREAKING CHANGE footers into the breaking fields", () => {
    const d = normalizeDraft(
      {
        type: "feat",
        scope: "",
        gitmoji: "sparkles",
        description: "Drop legacy flag.",
        body: "  ",
        breaking: false,
        breakingDescription: "",
        footers: [
          { token: "breaking change", value: "flag removed" },
          { token: "Refs", value: " #4 " },
        ],
      },
      types,
    );
    expect(d).toEqual({
      type: "feat",
      scope: null,
      gitmoji: ":sparkles:",
      description: "drop legacy flag",
      body: null,
      breaking: true,
      breakingDescription: "flag removed",
      footers: [{ token: "Refs", value: "#4" }],
    });
  });

  it("clears breakingDescription when not breaking and rejects unknown gitmoji", () => {
    const d = normalizeDraft(
      {
        type: "fix",
        scope: "x",
        gitmoji: ":not-a-gitmoji:",
        description: "y",
        body: "",
        breaking: false,
        breakingDescription: "z",
        footers: [],
      },
      types,
    );
    expect(d.breakingDescription).toBeNull();
    expect(d.gitmoji).toBeNull();
  });
});
