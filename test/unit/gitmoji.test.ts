import { describe, expect, it } from "vitest";
import {
  findGitmoji,
  GITMOJIS,
  LEADING_GITMOJI_RE,
  TYPE_GITMOJI,
} from "../../src/message/gitmoji.js";

describe("gitmoji", () => {
  it("every type default exists in the bundled list", () => {
    for (const code of Object.values(TYPE_GITMOJI)) expect(findGitmoji(code)?.code).toBe(code);
  });

  it("recognises every gitmoji emoji and shortcode as a leading gitmoji", () => {
    for (const g of GITMOJIS) {
      expect(LEADING_GITMOJI_RE.test(`${g.emoji} feat: x`), g.code).toBe(true);
      expect(LEADING_GITMOJI_RE.test(`${g.code} feat: x`), g.code).toBe(true);
    }
    expect(LEADING_GITMOJI_RE.test("feat: x")).toBe(false);
  });

  it("finds by code, bare name or emoji (with or without variation selector)", () => {
    expect(findGitmoji("sparkles")?.code).toBe(":sparkles:");
    expect(findGitmoji("✨")?.code).toBe(":sparkles:");
    expect(findGitmoji("⚡")?.code).toBe(":zap:");
    expect(findGitmoji("nope")).toBeUndefined();
    expect(findGitmoji("")).toBeUndefined();
  });
});
