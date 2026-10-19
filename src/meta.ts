declare const __CCLI_VERSION__: string | undefined;

/** Injected by the build (scripts/build.mjs); "0.0.0-dev" when running from source. */
export const VERSION: string =
  typeof __CCLI_VERSION__ === "string" ? __CCLI_VERSION__ : "0.0.0-dev";

export const TOOL_NAME = "conventional-commits-cli";
export const PACKAGE_NAME = "@yourakshaw/conventional-commits-cli";
export const SHORT_NAME = "ccli";
export const KEYCHAIN_SERVICE = "conventional-commits-cli";
export const REPO_CONFIG_FILE = ".ccli.json";
export const REPO_IGNORE_FILE = ".ccliignore";
export const ISSUES_URL = "https://github.com/YourAKShaw/conventional-commits-cli/issues";
