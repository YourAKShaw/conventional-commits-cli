#!/usr/bin/env node
// Bundles src/cli.ts into dist/ and writes third-party license notices for every
// bundled package. Runtime dependencies are bundled, so the published package has no
// required dependencies; only the optional native keychain module stays external.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outdir = join(root, "dist");

rmSync(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: { cli: join(root, "src/cli.ts") },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  minifySyntax: true,
  legalComments: "none",
  metafile: true,
  chunkNames: "chunks/[name]-[hash]",
  external: ["@napi-rs/keyring"],
  define: { __CCLI_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __ccliCreateRequire } from 'node:module';",
      "const require = __ccliCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

// The shebang must only be on the entry file; strip it from shared chunks.
for (const file of Object.keys(result.metafile.outputs)) {
  if (!file.includes(`${sep}chunks${sep}`) && !file.includes("/chunks/")) continue;
  const abs = resolve(root, file);
  const text = readFileSync(abs, "utf8");
  if (text.startsWith("#!")) writeFileSync(abs, text.slice(text.indexOf("\n") + 1));
}

writeFileSync(join(outdir, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices(result.metafile));

const outputs = Object.entries(result.metafile.outputs)
  .map(
    ([file, info]) =>
      `${relative(root, resolve(root, file))} ${(info.bytes / 1024).toFixed(0)} KiB`,
  )
  .join("\n  ");
console.log(`Built ${pkg.name}@${pkg.version}\n  ${outputs}`);

function thirdPartyNotices(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = input.split(/[\\/]/);
    const idx = parts.lastIndexOf("node_modules");
    if (idx === -1) continue;
    const nameParts = parts[idx + 1]?.startsWith("@")
      ? parts.slice(idx + 1, idx + 3)
      : parts.slice(idx + 1, idx + 2);
    const dir = resolve(root, ...parts.slice(0, idx + 1), ...nameParts);
    if (!packages.has(dir)) packages.set(dir, nameParts.join("/"));
  }

  const sections = [...packages.entries()]
    .map(([dir, name]) => {
      const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const licenseFile = existsSync(dir)
        ? readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f))
        : undefined;
      const text = licenseFile
        ? readFileSync(join(dir, licenseFile), "utf8").trim()
        : `No license file is shipped in this package. Declared license: ${meta.license ?? "unknown"}.`;
      const repo = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
      return { name: meta.name ?? name, version: meta.version, license: meta.license, repo, text };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    "# Third-party notices",
    "",
    `${pkg.name} bundles the following packages into \`dist/\`. Their licenses are reproduced below.`,
    "",
  ];
  const body = sections.flatMap((s) => [
    `## ${s.name}@${s.version}`,
    "",
    `License: ${s.license ?? "unknown"}${s.repo ? `  \nRepository: ${s.repo}` : ""}`,
    "",
    "```text",
    s.text,
    "```",
    "",
  ]);
  return [...header, ...body].join("\n");
}
