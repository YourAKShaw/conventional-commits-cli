#!/usr/bin/env node
// Builds standalone executables (no Node.js needed) with `bun build --compile` into release/.
// Usage: node scripts/build-binaries.mjs [--only bun-linux-x64,bun-darwin-arm64]
// The optional OS-keychain module is not embedded: binaries read keys from environment
// variables or the opt-in file store (see docs/distribution.md).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release");

const TARGETS = [
  { target: "bun-linux-x64", name: "linux-x64" },
  { target: "bun-linux-arm64", name: "linux-arm64" },
  { target: "bun-linux-x64-musl", name: "linux-x64-musl" },
  { target: "bun-linux-arm64-musl", name: "linux-arm64-musl" },
  { target: "bun-darwin-x64", name: "darwin-x64" },
  { target: "bun-darwin-arm64", name: "darwin-arm64" },
  { target: "bun-windows-x64", name: "windows-x64", exe: true },
  { target: "bun-windows-arm64", name: "windows-arm64", exe: true },
];

const onlyArg = process.argv.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? (onlyArg.split("=")[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1] ?? "").split(",")
  : null;
const selected = TARGETS.filter((t) => !only || only.includes(t.target));
if (selected.length === 0)
  throw new Error(`No matching targets. Known: ${TARGETS.map((t) => t.target).join(", ")}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sums = [];
for (const t of selected) {
  const file = `ccli-${version}-${t.name}${t.exe ? ".exe" : ""}`;
  const args = [
    "build",
    join(root, "src/cli.ts"),
    "--compile",
    `--target=${t.target}`,
    "--outfile",
    join(out, file),
    "--minify",
    "--external",
    "@napi-rs/keyring",
    "--define",
    `__CCLI_VERSION__=${JSON.stringify(version)}`,
  ];
  console.log(`→ ${file}`);
  const result = spawnSync("bun", args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const hash = createHash("sha256")
    .update(readFileSync(join(out, file)))
    .digest("hex");
  sums.push(`${hash}  ${file}`);
}
writeFileSync(join(out, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.log(`Wrote ${selected.length} binaries and release/SHA256SUMS.txt`);
