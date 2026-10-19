export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
}

/**
 * High-confidence credential formats checked in addition to secretlint's rules.
 * These deliberately ignore inline "disable" comments, so repository content cannot
 * switch the check off.
 */
export const BUILTIN_PATTERNS: readonly SecretPattern[] = [
  {
    id: "private-key",
    description: "Private key block",
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key ID",
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "openai-key",
    description: "OpenAI-style secret key",
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  { id: "anthropic-key", description: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "xai-key", description: "xAI API key", regex: /\bxai-[A-Za-z0-9]{20,}/g },
  { id: "google-api-key", description: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: "github-token",
    description: "GitHub token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { id: "gitlab-token", description: "GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "slack-token", description: "Slack token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  {
    id: "stripe-key",
    description: "Stripe secret key",
    regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  { id: "npm-token", description: "npm access token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: "jwt",
    description: "JSON Web Token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: "url-credentials",
    description: "Credentials embedded in a URL",
    regex:
      /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"`]{1,64}:(?!\$\{|\*{3}|<)[^\s@/'"`]{3,128}@[^\s'"`]+/gi,
  },
];

const KEYWORD_RE =
  /(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|bearer|auth)/i;
const CANDIDATE_RE = /[A-Za-z0-9+/=_-]{16,}/g;
const PLACEHOLDER_RE =
  /^(?:x+|\*+|0+|your[_-]?.*|.*(?:example|sample|placeholder|changeme|dummy|redacted|test).*)$/i;

export interface EntropyHit {
  start: number;
  end: number;
  value: string;
}

/**
 * Flag high-entropy tokens (16+ chars). A token on a line that mentions a credential keyword needs
 * entropy ≥ 3.5 bits/char; a standalone token must be ≥ 32 chars with entropy ≥ 4.5,
 * which hex digests (≤ 4.0) can never reach.
 */
export function findHighEntropy(line: string): EntropyHit[] {
  const hits: EntropyHit[] = [];
  const keyword = KEYWORD_RE.test(line);
  for (const m of line.matchAll(CANDIDATE_RE)) {
    const value = m[0];
    if (PLACEHOLDER_RE.test(value) || /^[A-Za-z]+$/.test(value) || /^[A-Za-z_-]+$/.test(value))
      continue;
    const entropy = shannonEntropy(value);
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(value)).length;
    const strong = value.length >= 32 && entropy >= 4.5 && classes >= 3;
    const contextual = keyword && entropy >= 3.5 && classes >= 2;
    if (strong || contextual)
      hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + value.length, value });
  }
  return hits;
}

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Compile user-supplied patterns; invalid ones are reported, not silently dropped. */
export function compileUserPatterns(sources: readonly string[]): {
  patterns: SecretPattern[];
  errors: string[];
} {
  const patterns: SecretPattern[] = [];
  const errors: string[] = [];
  sources.forEach((source, i) => {
    try {
      patterns.push({
        id: `custom-${i + 1}`,
        description: `Custom pattern ${source}`,
        regex: new RegExp(source, "g"),
      });
    } catch (error) {
      errors.push(
        `Invalid secrets.extraPatterns entry ${JSON.stringify(source)}: ${(error as Error).message}`,
      );
    }
  });
  return { patterns, errors };
}
