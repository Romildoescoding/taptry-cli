// The CLI, MCP server and GitHub Action, each run as a real child process
// against test/fakeServer.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createFakeServer } = require("./fakeServer");

const BIN = path.join(__dirname, "..", "bin", "taptry.js");
const ACTION = path.join(__dirname, "..", "action", "run.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taptry-cli-"));
const apk = path.join(tmp, "app-release.apk");
fs.writeFileSync(apk, Buffer.alloc(2048, 7));
const broken = path.join(tmp, "broken.apk");
fs.writeFileSync(broken, Buffer.alloc(2048, 1));

let fake;
test.before(async () => {
  fake = await createFakeServer();
});
test.after(() => {
  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(file, args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TAPTRY_CONFIG_DIR: path.join(tmp, "config"), ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const cli = (args, opts = {}) =>
  run(BIN, args, { ...opts, env: { TAPTRY_API_URL: fake.url, TAPTRY_API_KEY: fake.key, ...(opts.env || {}) } });

// ------------------------------------------------------------------ CLI ---

test("cli: upload waits for the checks and prints the link", async () => {
  const r = await cli(["upload", apk, "--name", "My Game"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^https:\/\/taptry\.test\/app\/game-\d+$/);
  assert.match(r.stderr, /Waiting for the malware scan/);
  assert.match(r.stderr, /Ready/);
});

test("cli: --json, --ref replaces the same app, --private", async () => {
  const first = JSON.parse((await cli(["upload", apk, "--ref", "ci:main", "--private", "--json"])).stdout);
  assert.equal(first.created, true);
  assert.equal(first.app.visibility, "private");
  const unlisted = JSON.parse((await cli(["upload", apk, "--unlisted", "--json"])).stdout);
  assert.equal(unlisted.app.visibility, "unlisted");
  assert.equal((await cli(["upload", apk, "--unlisted", "--private"])).code, 2, "pick one");
  const second = JSON.parse((await cli(["upload", apk, "--ref", "ci:main", "--json"])).stdout);
  assert.equal(second.created, false);
  assert.equal(second.app.id, first.app.id);
  const status = JSON.parse((await cli(["status", "--ref", "ci:main", "--json"])).stdout);
  assert.equal(status.app.id, first.app.id);
});

test("cli: a refused build exits 3, bad usage exits 2, bad key exits 1", async () => {
  const refused = await cli(["upload", broken]);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /Couldn't be used/);
  assert.equal((await cli(["upload"])).code, 2);
  assert.equal((await cli(["upload", path.join(tmp, "notes.txt")])).code, 1);
  assert.equal((await cli(["frobnicate"])).code, 2);
  const badKey = await cli(["whoami"], { env: { TAPTRY_API_KEY: "tt_wrong" } });
  assert.equal(badKey.code, 1);
  assert.match(badKey.stderr, /Invalid or revoked API key/);
  const noKey = await run(BIN, ["list"], { env: { TAPTRY_API_URL: fake.url } });
  assert.match(noKey.stderr, /taptry login/);
});

test("cli: delete refuses without a TTY or --yes, deletes with --yes", async () => {
  const [app] = [...fake.apps.values()];
  const refused = await cli(["delete", app.slug], { input: "" });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /--yes/);
  assert.ok(fake.apps.has(app.id));
  const ok = await cli(["delete", app.slug, "--yes"]);
  assert.equal(ok.code, 0);
  assert.ok(!fake.apps.has(app.id));
});

test("cli: login verifies the key and saves it 0600; logout forgets it", async () => {
  const env = { TAPTRY_API_URL: fake.url, TAPTRY_API_KEY: "" };
  const login = await run(BIN, ["login", "--stdin"], { env, input: `${fake.key}\n` });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stderr, /Logged in as @romil/);
  const saved = path.join(tmp, "config", "config.json");
  assert.equal(JSON.parse(fs.readFileSync(saved, "utf8")).apiKey, fake.key);
  if (process.platform !== "win32") assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  assert.equal((await run(BIN, ["whoami"], { env })).code, 0);
  await run(BIN, ["logout"], { env });
  assert.ok(!fs.existsSync(saved));
  const wrong = await run(BIN, ["login", "--stdin"], { env, input: "tt_wrong\n" });
  assert.equal(wrong.code, 1);
  assert.ok(!fs.existsSync(saved), "a key that doesn't work isn't saved");
});

// ------------------------------------------------------------------ MCP ---

// Sends each request after the previous reply, the way a client using the
// results would. (The server itself handles requests concurrently.)
async function mcpSession(messages) {
  const child = spawn(process.execPath, [BIN, "mcp"], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TAPTRY_API_URL: fake.url, TAPTRY_API_KEY: fake.key, TAPTRY_CONFIG_DIR: path.join(tmp, "config") },
  });
  const waiting = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      waiting.shift()?.(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const replies = [];
  for (const m of messages) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    if (m.id !== undefined) replies.push(await new Promise((resolve) => waiting.push(resolve)));
  }
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  return replies;
}

test("mcp: initialize, list tools, upload, refuse an unconfirmed delete", async () => {
  const replies = await mcpSession([
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "upload_app", arguments: { file_path: apk, ref: "mcp:demo", wait_seconds: 30 } } },
    { id: 4, method: "tools/call", params: { name: "delete_app", arguments: { ref: "mcp:demo", confirm: false } } },
    { id: 5, method: "tools/call", params: { name: "get_link", arguments: { ref: "mcp:demo" } } },
    { id: 6, method: "nope" },
  ]);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].result.protocolVersion, "2025-06-18");
  assert.equal(byId[1].result.serverInfo.name, "taptry");
  assert.deepEqual(byId[2].result.tools.map((t) => t.name), [
    "upload_app", "get_status", "get_link", "list_apps",
    "start_session", "screenshot", "get_ui", "tap", "swipe", "type_text", "press_key", "get_logs", "end_session",
    "delete_app",
  ]);
  const uploaded = JSON.parse(byId[3].result.content[0].text);
  assert.equal(uploaded.ready, true);
  assert.match(uploaded.url, /^https:\/\/taptry\.test\/app\//);
  assert.equal(byId[4].result.isError, true);
  assert.match(byId[4].result.content[0].text, /confirm must be true/);
  assert.equal(JSON.parse(byId[5].result.content[0].text).ready, true, "still there after the refused delete");
  assert.equal(byId[6].error.code, -32601);
});

// --------------------------------------------------------------- Action ---

function action({ event, inputs }) {
  const eventPath = path.join(tmp, `event-${Math.random()}.json`);
  const outputPath = path.join(tmp, `output-${Math.random()}`);
  fs.writeFileSync(eventPath, JSON.stringify(event));
  fs.writeFileSync(outputPath, "");
  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REPOSITORY: "romil/game",
    GITHUB_API_URL: fake.url,
    "INPUT_API-URL": fake.url,
    "INPUT_GITHUB-TOKEN": "ghs_test",
    INPUT_TIMEOUT: "30",
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return run(ACTION, [], { env }).then((r) => {
    const outputs = {};
    for (const m of fs.readFileSync(outputPath, "utf8").matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
    return { ...r, outputs };
  });
}

const prEvent = (action) => ({
  action,
  pull_request: { number: 7, head: { sha: "abcdef1234567", repo: { full_name: "romil/game" } } },
});

test("action: a pull request gets one preview and one comment, updated on every push", async () => {
  const one = await action({ event: prEvent("opened"), inputs: { "api-key": fake.key, file: path.join(tmp, "*.release.apk").replace("*.release", "app-release") } });
  assert.equal(one.code, 0, one.stdout + one.stderr);
  assert.equal(one.outputs.ready, "true");
  assert.match(one.outputs.url, /^https:\/\/taptry\.test\/app\//);
  const two = await action({ event: prEvent("synchronize"), inputs: { "api-key": fake.key, file: path.join(tmp, "app-rel*.apk") } });
  assert.equal(two.code, 0, two.stdout);
  assert.equal(two.outputs["app-id"], one.outputs["app-id"], "same app for the same PR");

  const previews = [...fake.apps.values()].filter((a) => a.ref === "github:romil/game#7");
  assert.equal(previews.length, 1);
  const prComments = fake.comments.filter((c) => c.issue === 7);
  assert.equal(prComments.length, 1, "one comment, edited in place");
  assert.match(prComments[0].body, /Run .* in your browser/);
  assert.match(prComments[0].body, /from abcdef1/);
  assert.equal(previews[0].visibility, "unlisted", "PR previews default to unlisted");
  assert.match(prComments[0].body, /Unlisted: anyone with this link/);
});

test("action: closing the pull request deletes its preview", async () => {
  const r = await action({ event: prEvent("closed"), inputs: { "api-key": fake.key } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal([...fake.apps.values()].filter((a) => a.ref === "github:romil/game#7").length, 0);
  assert.match(fake.comments.find((c) => c.issue === 7).body, /Removed/);
});

test("action: refused build fails the step; fork PRs without a key are skipped", async () => {
  const refused = await action({ event: prEvent("opened"), inputs: { "api-key": fake.key, file: broken } });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /::error::TapTry couldn't use this build/);

  const fork = await action({
    event: { action: "opened", pull_request: { number: 9, head: { repo: { full_name: "stranger/game" } } } },
    inputs: { "api-key": "" },
  });
  assert.equal(fork.code, 0);
  assert.match(fork.stdout, /::warning::.*forks/);

  const ambiguous = await action({ event: prEvent("opened"), inputs: { "api-key": fake.key, file: path.join(tmp, "*.apk") } });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stdout, /matches 2 files/);
});
