// A small client for TapTry's public API (/api/v1, see PUBLIC-API.md). No
// dependencies: Node 20's fetch, FormData and fs.openAsBlob, which streams
// the file from disk instead of reading 500MB into memory.
const fs = require("fs");
const path = require("path");

const ACCEPTED_EXTENSIONS = [".apk", ".aab", ".apks", ".xapk", ".apkm"];
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

class TapTryError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class TapTryClient {
  constructor({ apiKey, apiUrl, userAgent = "taptry-cli" }) {
    if (!apiKey) {
      throw new TapTryError(
        "No API key. Run `taptry login`, or set TAPTRY_API_KEY. Create a key in TapTry under Settings > API keys.",
        { code: "NO_API_KEY" },
      );
    }
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.userAgent = userAgent;
  }

  async request(method, p, { query, body } = {}) {
    const url = new URL(`${this.apiUrl}/api/v1${p}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, "user-agent": this.userAgent },
        body,
      });
    } catch (err) {
      throw new TapTryError(`Couldn't reach ${this.apiUrl} - ${err.cause?.message || err.message}`, { code: "NETWORK" });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON - handled below */
    }
    if (!res.ok) {
      throw new TapTryError(json?.error || `TapTry answered ${res.status}`, { status: res.status, code: json?.code || null });
    }
    if (!json) throw new TapTryError(`TapTry answered ${res.status} with something that isn't JSON`, { status: res.status });
    return json;
  }

  me() {
    return this.request("GET", "/me");
  }

  async list({ ref } = {}) {
    return (await this.request("GET", "/apps", { query: { ref } })).apps;
  }

  async get(idOrSlug) {
    return (await this.request("GET", `/apps/${encodeURIComponent(idOrSlug)}`)).app;
  }

  /** The app with this ref, or null. */
  async findByRef(ref) {
    return (await this.list({ ref }))[0] ?? null;
  }

  async delete(idOrSlug) {
    return this.request("DELETE", `/apps/${encodeURIComponent(idOrSlug)}`);
  }

  /**
   * Uploads a file. With `ref`, uploading again with the same ref replaces
   * that app's file (same app, same link). Returns { app, created }.
   */
  async upload(filePath, { name, ref, visibility, description } = {}) {
    checkFile(filePath);
    const form = new FormData();
    form.append("file", await fs.openAsBlob(filePath), path.basename(filePath));
    if (name) form.append("name", name);
    if (description) form.append("description", description);
    if (visibility) form.append("public", visibility === "private" ? "false" : "true");
    return this.request("POST", "/apps", { query: { ref }, body: form });
  }

  async replace(idOrSlug, filePath) {
    checkFile(filePath);
    const form = new FormData();
    form.append("file", await fs.openAsBlob(filePath), path.basename(filePath));
    return this.request("POST", `/apps/${encodeURIComponent(idOrSlug)}/file`, { body: form });
  }

  /**
   * Polls until the app's checks finish (or `timeoutMs` passes). Calls
   * onPoll(app) after each poll. Returns the app; `app.done` is false on
   * timeout.
   */
  async waitUntilDone(idOrSlug, { timeoutMs = 15 * 60 * 1000, intervalMs = 5000, onPoll } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const app = await this.get(idOrSlug);
      onPoll?.(app);
      if (app.done || Date.now() + intervalMs > deadline) return app;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** Throws a TapTryError for a file the server would refuse anyway. */
function checkFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new TapTryError(`No such file: ${filePath}`, { code: "NO_FILE" });
  }
  if (!stat.isFile()) throw new TapTryError(`Not a file: ${filePath}`, { code: "NO_FILE" });
  const ext = path.extname(filePath).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new TapTryError(`${path.basename(filePath)} isn't an app file - TapTry takes ${ACCEPTED_EXTENSIONS.join(", ")}`, {
      code: "BAD_FILE",
    });
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new TapTryError(`${path.basename(filePath)} is ${(stat.size / 1048576).toFixed(0)}MB - the limit is 500MB`, {
      code: "TOO_LARGE",
    });
  }
}

/** One line a person can read: "Ready", "Checking…", or why it failed. */
function describeStatus(app) {
  switch (app.status) {
    case "CLEAN":
      return "Ready";
    case "PENDING":
    case "SCANNING":
      return "Checking for malware…";
    case "FLAGGED":
      return "Held for review - a few malware scanners objected, and TapTry will look at it";
    case "INFECTED":
      return "Blocked - malware scanners flagged this file";
    case "TAMPERED":
      return "Blocked - the file's signature doesn't match its contents";
    case "ERROR":
      return `Couldn't be used: ${app.error || "unknown error"}`;
    default:
      return app.status;
  }
}

module.exports = { TapTryClient, TapTryError, describeStatus, checkFile, ACCEPTED_EXTENSIONS };
