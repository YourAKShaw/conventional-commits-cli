import process from "node:process";
import { loadConfig } from "../config/load.js";
import { CliError, ExitCode } from "../errors.js";
import { createKeyStore, maskKey } from "../keys/resolve.js";
import { resolveEffort } from "../providers/effort.js";
import { ADAPTERS } from "../providers/index.js";
import { PROVIDERS } from "../providers/registry.js";
import { isProviderId, PROVIDER_IDS, ProviderError, type ProviderId } from "../providers/types.js";
import { c, writeOut } from "../term.js";
import type { CommandContext } from "./context.js";

function parseProvider(value: string): ProviderId {
  const id = value.toLowerCase();
  if (!isProviderId(id)) {
    throw new CliError(`Unknown provider "${value}". Choose one of: ${PROVIDER_IDS.join(", ")}.`, {
      exitCode: ExitCode.Usage,
    });
  }
  return id;
}

export async function authSet(
  ctx: CommandContext,
  providerArg: string,
  options: { stdin?: boolean; insecureFileStore?: boolean },
): Promise<number> {
  const provider = parseProvider(providerArg);
  const info = PROVIDERS[provider];
  let key: string;
  if (options.stdin) {
    key = (await readStdin()).trim();
  } else {
    if (!ctx.ui.interactive) {
      throw new CliError("Reading a key needs a terminal.", {
        exitCode: ExitCode.Usage,
        hint: "Pipe it instead: … | ccli auth set <provider> --stdin",
      });
    }
    ctx.ui.info(`Create a key at ${info.keyUrl}`);
    key = (
      await ctx.ui.password({
        message: `${info.displayName} API key`,
        validate: (v) =>
          v.trim().length < 16
            ? "That does not look like an API key."
            : /\s/.test(v.trim())
              ? "Keys cannot contain spaces."
              : undefined,
      })
    ).trim();
  }
  if (key.length < 16 || /\s/.test(key))
    throw new CliError("That does not look like an API key.", { exitCode: ExitCode.Usage });

  const store = createKeyStore(ctx.env);
  if (options.insecureFileStore) {
    store.file.set(provider, key);
    ctx.ui.warn(
      `Stored the ${info.displayName} key in plain text at ${store.file.location} (owner-only permissions on macOS/Linux).`,
    );
    return ExitCode.Ok;
  }
  const availability = await store.keychain.availability();
  if (!availability.available) {
    throw new CliError(`The OS keychain is not available: ${availability.reason}.`, {
      hint: `Use the ${info.envVars[0]} environment variable, or re-run with --insecure-file-store to save it in a plaintext file.`,
    });
  }
  await store.keychain.set(provider, key);
  ctx.ui.success(`Stored the ${info.displayName} key in the OS keychain.`);
  const envName = info.envVars.find((name) => ctx.env[name]);
  if (envName)
    ctx.ui.warn(`${envName} is set in your environment and takes precedence over the stored key.`);
  return ExitCode.Ok;
}

export async function authRemove(ctx: CommandContext, providerArg: string): Promise<number> {
  const provider = parseProvider(providerArg);
  const store = createKeyStore(ctx.env);
  let removed = false;
  try {
    removed = (await store.keychain.delete(provider)) || removed;
  } catch {
    // Keychain unavailable: nothing stored there.
  }
  removed = store.file.delete(provider) || removed;
  const name = PROVIDERS[provider].displayName;
  if (removed) ctx.ui.success(`Removed the stored ${name} key.`);
  else ctx.ui.info(`No stored ${name} key was found.`);
  const envName = PROVIDERS[provider].envVars.find((v) => ctx.env[v]);
  if (envName) ctx.ui.info(`${envName} is still set in your environment.`);
  return ExitCode.Ok;
}

export async function authList(ctx: CommandContext, options: { json?: boolean }): Promise<number> {
  const store = createKeyStore(ctx.env);
  const rows = [];
  for (const id of PROVIDER_IDS) {
    const key = await store.resolve(id);
    rows.push({
      provider: id,
      name: PROVIDERS[id].displayName,
      source: key?.source ?? null,
      origin: key?.origin ?? null,
      key: key ? maskKey(key.value) : null,
    });
  }
  if (options.json) {
    await writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return ExitCode.Ok;
  }
  const lines = rows.map((r) =>
    r.source
      ? `${c.green("●")} ${r.name.padEnd(14)} ${String(r.key).padEnd(8)} ${c.dim(`from ${r.origin}`)}`
      : `${c.gray("○")} ${r.name.padEnd(14)} ${c.dim(`not set — ${PROVIDERS[r.provider].envVars[0]} or \`ccli auth set ${r.provider}\``)}`,
  );
  await writeOut(`${lines.join("\n")}\n`);
  const warning = store.file.permissionWarning();
  if (warning) ctx.ui.warn(warning);
  return ExitCode.Ok;
}

/** Make one tiny request per provider to verify the key, model and effort settings. */
export async function authTest(
  ctx: CommandContext,
  providerArg: string | undefined,
): Promise<number> {
  const config = loadConfig(null, ctx.env).effective;
  const ids = providerArg
    ? [parseProvider(providerArg)]
    : PROVIDER_IDS.filter((id) => config.providers.settings[id].enabled);
  const store = createKeyStore(ctx.env);
  let failures = 0;
  let tested = 0;
  for (const id of ids) {
    const name = PROVIDERS[id].displayName;
    const key = await store.resolve(id);
    if (!key) {
      if (providerArg) {
        ctx.ui.error(`${name}: no API key found.`);
        failures++;
      }
      continue;
    }
    tested++;
    const settings = config.providers.settings[id];
    const effort = resolveEffort(id, settings.model, settings.effort);
    const adapter = ADAPTERS[id];
    try {
      const result = await adapter.generate(
        {
          system: "You are a connectivity check.",
          user: 'Reply with the JSON object {"ok": true}.',
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          schemaName: "connectivity_check",
          structured: settings.structuredOutput,
        },
        {
          apiKey: key.value,
          model: settings.model,
          effort: effort.value,
          maxOutputTokens: Math.max(1024, Math.min(settings.maxOutputTokens, 2048)),
          timeoutMs: settings.timeoutMs,
          baseUrl: settings.baseUrl ?? adapter.defaultBaseUrl,
          signal: ctx.signal,
        },
      );
      ctx.ui.success(
        `${name}: OK — ${result.model || settings.model}${effort.value ? `, effort ${effort.value}` : ""} (${result.latencyMs} ms, key ${maskKey(key.value)} from ${key.origin})`,
      );
    } catch (error) {
      failures++;
      const message =
        error instanceof ProviderError
          ? `${error.message} [${error.kind}]`
          : (error as Error).message;
      ctx.ui.error(`${name}: ${message}`);
    }
  }
  if (tested === 0 && !providerArg) {
    ctx.ui.warn(
      "No provider has an API key. Set one with `ccli auth set <provider>` or an environment variable.",
    );
    return ExitCode.Error;
  }
  return failures > 0 ? ExitCode.Error : ExitCode.Ok;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(
        new CliError("--stdin expects the key on standard input (pipe it in).", {
          exitCode: ExitCode.Usage,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}
