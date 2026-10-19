export interface Footer {
  token: string;
  value: string;
}

/** Structured commit message shared by manual and smart mode. */
export interface CommitDraft {
  type: string;
  scope: string | null;
  /** Gitmoji shortcode such as ":sparkles:"; null uses the type's default, "" means none. */
  gitmoji: string | null;
  description: string;
  body: string | null;
  breaking: boolean;
  /** Text for the BREAKING CHANGE footer. Optional when `!` alone marks the break (spec rule 13). */
  breakingDescription: string | null;
  footers: Footer[];
}

export interface TypeInfo {
  type: string;
  description: string;
}

export type GitmojiStyle = "unicode" | "code";
export type GitmojiPosition = "after-colon" | "prefix";

export interface FormatSettings {
  gitmoji: { enabled: boolean; style: GitmojiStyle; position: GitmojiPosition };
  headerMaxLength: number;
  bodyWrap: number;
}

export function emptyDraft(type = "feat"): CommitDraft {
  return {
    type,
    scope: null,
    gitmoji: null,
    description: "",
    body: null,
    breaking: false,
    breakingDescription: null,
    footers: [],
  };
}
