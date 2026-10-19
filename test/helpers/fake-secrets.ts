// Credentials are assembled at runtime so the repository never contains strings that look
// like real tokens (which would trip secret scanners and push protection).
const join = (...parts: string[]) => parts.join("");

export const FAKE = {
  github: join("gh", "p_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8s9T0"),
  aws: join("AK", "IA", "QWERTYUIOPASDFGH"),
  openai: join("sk", "-proj-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed"),
  anthropic: join("sk", "-ant-", "api03-", "Qw3Er4Ty5Ui6Op7As8Df9Gh0Jk1Lz2Xc3Vb4"),
  google: join("AI", "za", "SyD3x4mPl3KeY5678901234567890abcd"),
  privateKeyHeader: join("-----BEGIN ", "RSA ", "PRIVATE KEY-----"),
  jwt: join(
    "ey",
    "JhbGciOiJIUzI1NiJ9",
    ".",
    "ey",
    "JzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ),
  urlCreds: join("postgres", "://", "admin", ":", "S3cr3tPassw0rd", "@db.internal:5432/app"),
};
