// Where the CLI finds its API key and the API: a flag, then the environment
// (TAPTRY_API_KEY - what CI uses), then the file `taptry login` writes.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_API_URL = "https://api.taptry.in";

function configDir() {
  if (process.env.TAPTRY_CONFIG_DIR) return process.env.TAPTRY_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "taptry");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "taptry");
}

const configPath = () => path.join(configDir(), "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  // 0600: the file holds a credential. (Ignored on Windows, where the
  // profile directory is already per-user.)
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function clearConfig() {
  fs.rmSync(configPath(), { force: true });
}

function resolveSettings(flags = {}) {
  const file = readConfig();
  return {
    apiKey: flags.apiKey || process.env.TAPTRY_API_KEY || file.apiKey || null,
    apiUrl: (flags.apiUrl || process.env.TAPTRY_API_URL || file.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
  };
}

module.exports = { resolveSettings, readConfig, writeConfig, clearConfig, configPath, DEFAULT_API_URL };
