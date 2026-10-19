import { CliError, ExitCode } from "../errors.js";
import { PROVIDERS, REGISTRY_VERIFIED_ON } from "../providers/registry.js";
import { isProviderId, PROVIDER_IDS } from "../providers/types.js";
import { c, writeOut } from "../term.js";

export async function listModels(
  providerArg: string | undefined,
  options: { json?: boolean },
): Promise<number> {
  if (providerArg && !isProviderId(providerArg.toLowerCase())) {
    throw new CliError(
      `Unknown provider "${providerArg}". Choose one of: ${PROVIDER_IDS.join(", ")}.`,
      { exitCode: ExitCode.Usage },
    );
  }
  const ids = providerArg
    ? [providerArg.toLowerCase() as (typeof PROVIDER_IDS)[number]]
    : [...PROVIDER_IDS];
  if (options.json) {
    await writeOut(
      `${JSON.stringify({ verifiedOn: REGISTRY_VERIFIED_ON, providers: ids.map((id) => PROVIDERS[id]) }, null, 2)}\n`,
    );
    return ExitCode.Ok;
  }
  const out: string[] = [];
  for (const id of ids) {
    const info = PROVIDERS[id];
    out.push(
      `${c.bold(info.displayName)} ${c.dim(`(${id}) · key: ${info.envVars.join(" or ")} · effort: ${info.effortParameter}`)}`,
    );
    for (const m of info.models) {
      const isDefault = m.id === info.defaultModel;
      const efforts = m.efforts
        ? m.efforts.join(", ")
        : "not verified (passed through as configured)";
      out.push(
        `  ${isDefault ? c.green("★") : " "} ${m.id.padEnd(24)} ${c.dim(`effort: ${efforts}${m.defaultEffort ? ` (vendor default ${m.defaultEffort})` : ""}`)}`,
      );
      if (m.note) out.push(`    ${c.dim(m.note)}`);
    }
    out.push(
      `  ${c.dim(`ccli default: ${info.defaultModel}, effort ${info.defaultEffort} · docs ${info.docsUrl}`)}`,
      "",
    );
  }
  out.push(
    c.dim(
      `Checked against vendor documentation on ${REGISTRY_VERIFIED_ON}. Any model ID can be configured; models change often.`,
    ),
  );
  await writeOut(`${out.join("\n")}\n`);
  return ExitCode.Ok;
}
