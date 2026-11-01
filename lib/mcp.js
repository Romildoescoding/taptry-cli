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
      "This publishes the app under the user's name: ask the user before uploading, and say whether it will be public (shown on their profile, anyone can run it), unlisted (listed nowhere, anyone with its secret link can run it) or private (only them). " +
      "Uploading again with the same `ref` replaces that app's file and keeps its link - prefer that over creating duplicates. " +
      "Every upload is malware-scanned first; the link only works once status is CLEAN, which can take a few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the app file, e.g. app/build/outputs/apk/release/app-release.apk." },
        name: { type: "string", description: "App name. Default: from the file name." },
        ref: { type: "string", description: "A stable id for this app, e.g. the repo name, so re-uploads update it instead of creating a new app." },
        visibility: { type: "string", enum: ["public", "unlisted", "private"], description: "Default public. Unlisted suits a build to share with specific people." },
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
  // ---- testing an app on a device
  {
    name: "start_session",
    title: "Run an app on a cloud Android device",
    description:
      "Start one of the user's uploaded TapTry apps on a real cloud Android device so you can test it: look at the screen (screenshot, get_ui), act on it (tap, swipe, type_text, press_key) and read its logs (get_logs). " +
      "Uses one of the user's runs. Returns a session_id for the other session tools. The session ends after 5 minutes without a call - call end_session when you're done. " +
      "The app must have status CLEAN (check with get_status after upload_app).",
    inputSchema: { type: "object", properties: appTarget, additionalProperties: false },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  {
    name: "screenshot",
    title: "Screenshot the device",
    description: "See the device screen. Coordinates for tap/swipe are in device pixels (the size is in start_session's result) - prefer tap with text when the target has a label.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_ui",
    title: "Read the screen's elements",
    description: "The elements on screen - text, content descriptions, ids, whether they're clickable - with their bounds and centre points in device pixels. Cheaper than a screenshot for finding what to tap.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tap",
    title: "Tap",
    description: "Tap the element showing `text` (its text, content description or id), or the point x, y in device pixels.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        text: { type: "string", description: "Tap the element with this text, description or id." },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "swipe",
    title: "Swipe",
    description: "Swipe from x1,y1 to x2,y2 (device pixels) - to scroll, swipe up from the bottom half.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        duration_ms: { type: "number", description: "Default 300." },
      },
      required: ["session_id", "x1", "y1", "x2", "y2"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    title: "Type text",
    description: "Type into the focused field (tap it first). Plain ASCII; press_key enter for a newline.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, text: { type: "string" } },
      required: ["session_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    title: "Press a key",
    description: "Press back, enter, delete, tab, escape, space, up, down, left, right, menu, search, volume_up or volume_down. (Home and recents are disabled - the app runs sandboxed.)",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, key: { type: "string" } },
      required: ["session_id", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "get_logs",
    title: "Read the app's logs",
    description: "Whether the app is still running, its last crash (with stack trace) if any, and its recent log lines.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "end_session",
    title: "End the session",
    description: "Release the device. Call this when you're done testing.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
    annotations: { idempotentHint: true },
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
    case "start_session": {
      const app = await targetApp(client, args);
      const session = await client.startSession(app.id);
      return {
        session_id: session.id,
        app: app.name,
        packageName: session.packageName,
        screen: session.screen,
        next: "Take a screenshot or call get_ui to see the app.",
      };
    }
    case "screenshot": {
      const shot = await client.screenshot(args.session_id);
      // An image the model can look at, not a base64 string to read.
      return { __content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] };
    }
    case "get_ui":
      return client.ui(args.session_id);
    case "tap":
      return client.tap(args.session_id, args.text ? { text: args.text } : { x: args.x, y: args.y });
    case "swipe":
      return client.swipe(args.session_id, { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.duration_ms });
    case "type_text":
      return client.typeText(args.session_id, args.text);
    case "press_key":
      return client.pressKey(args.session_id, args.key);
    case "get_logs":
      return client.logs(args.session_id);
    case "end_session":
      return client.endSession(args.session_id);
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
          "TapTry turns an Android app file into a link anyone can run in their browser, and can run the user's apps on a cloud Android device for you to test (start_session, then screenshot/get_ui, tap/swipe/type_text/press_key, get_logs, end_session). Ask before uploading or deleting anything; uploads are malware-scanned before the link works; each test session uses one of the user's runs.",
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
        if (result && result.__content) return reply({ content: result.__content });
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
