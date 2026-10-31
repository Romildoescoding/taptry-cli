// `taptry mcp` - a Model Context Protocol server over stdio, so coding
// assistants (Claude Code, Cursor, Claude Desktop, ...) can upload a build
// and hand back a TapTry link. Same API client as the CLI; no dependencies -
// MCP's stdio transport is newline-delimited JSON-RPC 2.0, which is small
// enough to speak directly.
//
// stdout is the protocol channel: anything else written there corrupts it,
// so every log line goes to stderr.
const readline = require("readline");
const { TapTryClient, TapTryError, describeStatus } = require("./client");
const { resolveSettings } = require("./config");

const VERSION = require("../package.json").version;
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const appTarget = {
  app: { type: "string", description: "The app's id or slug." },
  ref: { type: "string", description: "Or: the ref the app was uploaded with." },
};

const TOOLS = [
  {
    name: "upload_app",
    title: "Upload an app to TapTry",
    description:
      "Upload an Android app file (.apk, .aab, .apks, .xapk or .apkm) from disk to the user's TapTry account and get a link anyone can open to run the app in their browser. " +
      "This publishes the app under the user's name: ask the user before uploading, and say whether it will be public (anyone with the link, shown on their profile) or private (only them). " +
      "Uploading again with the same `ref` replaces that app's file and keeps its link - prefer that over creating duplicates. " +
      "Every upload is malware-scanned first; the link only works once status is CLEAN, which can take a few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the app file, e.g. app/build/outputs/apk/release/app-release.apk." },
        name: { type: "string", description: "App name. Default: from the file name." },
        ref: { type: "string", description: "A stable id for this app, e.g. the repo name, so re-uploads update it instead of creating a new app." },
        visibility: { type: "string", enum: ["public", "private"], description: "Default public." },
        wait_seconds: { type: "number", description: "How long to wait for the checks before returning (0-600, default 90). Use get_status after that." },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_status",
    title: "Check a TapTry app",
    description: "Check whether an uploaded app has finished its malware scan and is ready to run, and get its link.",
    inputSchema: { type: "object", properties: appTarget, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_link",
    title: "Get a TapTry link",
    description: "Get the link to an uploaded app (works for others once the app is ready and public).",
    inputSchema: { type: "object", properties: appTarget, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_apps",
    title: "List TapTry apps",
    description: "List the apps in the user's TapTry account, newest first.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "Only the app with this ref." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "delete_app",
    title: "Delete a TapTry app",
    description:
      "Permanently delete one of the user's TapTry apps - its link, likes and stats. Irreversible: only call this after the user has explicitly agreed to delete that specific app, and pass confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        ...appTarget,
        confirm: { type: "boolean", description: "Must be true: the user has explicitly agreed to this deletion." },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

function summary(app) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    url: app.url,
    status: app.status,
    ready: app.ready,
    done: app.done,
    message: describeStatus(app),
    visibility: app.visibility,
    packageFormat: app.packageFormat,
    packageName: app.packageName,
    versionName: app.versionName,
    ref: app.ref,
  };
}

async function targetApp(client, args) {
  if (args.ref) {
    const app = await client.findByRef(args.ref);
    if (!app) throw new TapTryError(`No app with ref ${args.ref}`, { status: 404 });
    return app;
  }
  if (!args.app) throw new TapTryError("Pass `app` (id or slug) or `ref`.");
  return client.get(args.app);
}

async function callTool(client, name, args = {}) {
  switch (name) {
    case "upload_app": {
      const wait = Math.min(Math.max(Number(args.wait_seconds ?? 90), 0), 600);
      const { app, created } = await client.upload(args.file_path, { name: args.name, ref: args.ref, visibility: args.visibility });
      const final = wait > 0 ? await client.waitUntilDone(app.id, { timeoutMs: wait * 1000, intervalMs: 5000 }) : app;
      return {
        created,
        ...summary(final),
        next: final.done ? undefined : "Still being checked - call get_status in a minute or two.",
      };
    }
    case "get_status":
      return summary(await targetApp(client, args));
    case "get_link": {
      const app = await targetApp(client, args);
      return { url: app.url, ready: app.ready, visibility: app.visibility, message: describeStatus(app) };
    }
    case "list_apps":
      return { apps: (await client.list({ ref: args.ref })).map(summary) };
    case "delete_app": {
      if (args.confirm !== true) {
        throw new TapTryError("Not deleted: confirm must be true, and only after the user explicitly agreed to delete this app.");
      }
      const app = await targetApp(client, args);
      await client.delete(app.id);
      return { deleted: true, id: app.id, name: app.name };
    }
    default:
      throw new TapTryError(`Unknown tool ${name}`);
  }
}

/** Handles one JSON-RPC message; returns the response, or null for a notification. */
async function handle(message, getClient) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => (isRequest ? { jsonrpc: "2.0", id, result } : null);
  const fail = (code, msg) => (isRequest ? { jsonrpc: "2.0", id, error: { code, message: msg } } : null);

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "taptry", title: "TapTry", version: VERSION },
        instructions:
          "TapTry turns an Android app file into a link anyone can run in their browser. Ask before uploading or deleting anything; uploads are malware-scanned before the link works.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some((t) => t.name === params?.name)) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await callTool(getClient(), params.name, params.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        // A tool failure is a result the model should read, not a protocol error.
        const text = err instanceof TapTryError ? err.message : `Unexpected error: ${err.message}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      if (!isRequest) return null; // notifications/initialized and friends
      return fail(-32601, `Method not found: ${method}`);
  }
}

function serve({ flags = {}, input = process.stdin, output = process.stdout } = {}) {
  let client = null;
  // Built on first use, so a missing key is a tool error the assistant can
  // relay ("run taptry login"), not a server that won't start.
  const getClient = () => {
    client ??= new TapTryClient({
      ...resolveSettings({ apiKey: flags["api-key"], apiUrl: flags["api-url"] }),
      userAgent: `taptry-mcp/${VERSION}`,
    });
    return client;
  };
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      const response = await handle(message, getClient);
      if (response) send(response);
    } catch (err) {
      process.stderr.write(`taptry mcp: ${err.stack || err}\n`);
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } });
    }
  });
  return new Promise((resolve) => rl.on("close", resolve));
}

module.exports = { serve, handle, TOOLS };
