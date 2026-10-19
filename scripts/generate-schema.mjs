#!/usr/bin/env node
// Regenerates schema/*.json from the zod config schemas. A unit test and CI fail when they drift.
// The files are generated verbatim (excluded from Biome) so `git diff --exit-code schema/` is exact.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(tmpdir(), `ccli-schema-${process.pid}.mjs`);
await build({
  entryPoints: [join(root, "src/config/json-schema.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "error",
});
const { configJsonSchemas } = await import(pathToFileURL(out).href);
rmSync(out, { force: true });
mkdirSync(join(root, "schema"), { recursive: true });
for (const [name, schema] of Object.entries(configJsonSchemas())) {
  writeFileSync(join(root, "schema", name), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schema/${name}`);
}
