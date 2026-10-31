// `taptry` - upload Android apps to TapTry from a terminal or CI.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parseArgs } = require("util");
const { TapTryClient, TapTryError, describeStatus } = require("./client");
const { resolveSettings, readConfig, writeConfig, clearConfig, configPath } = require("./config");

const VERSION = require("../package.json").version;

// Exit codes, so CI can tell "the app was refused" from "TapTry was down".
const EXIT = { OK: 0, ERROR: 1, USAGE: 2, APP_FAILED: 3, TIMEOUT: 4 };

const HELP = `taptry ${VERSION} - share Android apps as a link anyone can run in their browser

Usage
  taptry upload <file> [options]   Upload an .apk, .aab, .apks, .xapk or .apkm
  taptry status <app>              Check an app's status (id or slug)
  taptry list                      Your apps
  taptry delete <app>              Delete an app
  taptry login                     Save an API key on this machine
  taptry logout                    Forget the saved key
  taptry whoami                    Show the account a key belongs to
  taptry mcp                       Run the MCP server (for Claude Code, Cursor, ...)

Upload options
  --name <name>        App name (default: from the file name)
  --ref <ref>          Your own id for this app, e.g. github:you/repo#42. Uploading
                       again with the same ref replaces that app's file - same link.
  --private            Only you can open it (default: anyone with the link)
  --no-wait            Return as soon as the file is uploaded, before its checks finish
  --timeout <seconds>  How long to wait for the checks (default 900)

Other options
  --ref <ref>          status/delete: the app with this ref
  --yes                delete: don't ask for confirmation
  --json               Print machine-readable JSON to stdout
  --api-key <key>      Use this key (default: TAPTRY_API_KEY, then \`taptry login\`)
  -h, --help, -v, --version

Create an API key in TapTry under Settings > API keys.`;

const OPTIONS = {
  name: { type: "string" },
  ref: { type: "string" },
  private: { type: "boolean" },
  "no-wait": { type: "boolean" },
  timeout: { type: "string" },
  yes: { type: "boolean", short: "y" },
  json: { type: "boolean" },
  "api-key": { type: "string" },
  "api-url": { type: "string" },
  stdin: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

class UsageError extends Error {}

function makeIo({ stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, json = false } = {}) {
  return {
    json,
    // Human progress goes to stderr, so `--json` output on stdout stays clean.
    info: (msg) => stderr.write(`${msg}\n`),
    out: (value) => stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`),
    stdin,
    stderr,
  };
}

function clientFor(flags) {
  const settings = resolveSettings({ apiKey: flags["api-key"], apiUrl: flags["api-url"] });
  return new TapTryClient({ ...settings, userAgent: `taptry-cli/${VERSION}` });
}

function appLine(app) {
  const bits = [app.packageFormat, app.versionName && `v${app.versionName}`, app.visibility].filter(Boolean).join(", ");
  return `${app.name} (${bits}) - ${describeStatus(app)}`;
}

function exitFor(app) {
  if (!app.done) return EXIT.TIMEOUT;
  return app.ready ? EXIT.OK : EXIT.APP_FAILED;
}

async function confirmPrompt(io, question) {
  if (!io.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: io.stdin, output: io.stderr });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function readSecret(io, question) {
  if (!io.stdin.isTTY) {
    // `echo $KEY | taptry login --stdin`
    let data = "";
    for await (const chunk of io.stdin) data += chunk;
    return data.trim();
  }
  io.stderr.write(question);
  return new Promise((resolve) => {
    let value = "";
    io.stdin.setRawMode(true);
    io.stdin.resume();
    io.stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        io.stdin.setRawMode(false);
        io.stdin.pause();
        io.stdin.off("data", onData);
        io.stderr.write("\n");
        resolve(value.trim());
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    io.stdin.on("data", onData);
  });
}

async function resolveApp(client, positional, flags) {
  if (flags.ref) {
    const app = await client.findByRef(flags.ref);
    if (!app) throw new TapTryError(`No app with ref ${flags.ref}`, { status: 404, code: "NOT_FOUND" });
    return app;
  }
  if (!positional) throw new UsageError("Which app? Pass its id or slug, or --ref <ref>.");
  return client.get(positional);
}

// ---------------------------------------------------------------- commands

const commands = {
  async upload(io, [file], flags) {
    if (!file) throw new UsageError("Which file? taptry upload <file>");
    const timeoutSec = flags.timeout ? Number(flags.timeout) : 900;
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new UsageError("--timeout must be a number of seconds");
    const client = clientFor(flags);

    const size = (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) / 1048576;
    io.info(`Uploading ${path.basename(file)} (${size.toFixed(1)} MB)…`);
    const { app: uploaded, created } = await client.upload(file, {
      name: flags.name,
      ref: flags.ref,
      visibility: flags.private ? "private" : undefined,
    });
    io.info(`${created ? "Created" : "Updated"} ${uploaded.name} - ${uploaded.url}`);

    let app = uploaded;
    if (!flags["no-wait"]) {
      io.info("Waiting for the malware scan and checks (this can take a few minutes)…");
      let last = "";
      app = await client.waitUntilDone(uploaded.id, {
        timeoutMs: timeoutSec * 1000,
        onPoll: (a) => {
          const line = describeStatus(a);
          if (line !== last) io.info(`  ${line}`);
          last = line;
        },
      });
    }

    if (io.json) io.out({ app, created });
    else if (app.ready) io.out(app.url);
    else if (!app.done) io.info(flags["no-wait"] ? `Check on it with: taptry status ${app.slug}` : "Still checking - timed out waiting.");
    else io.info(describeStatus(app));
    return flags["no-wait"] ? EXIT.OK : exitFor(app);
  },

  async status(io, [idOrSlug], flags) {
    const app = await resolveApp(clientFor(flags), idOrSlug, flags);
    if (io.json) io.out({ app });
    else io.out(`${appLine(app)}\n${app.url}`);
    return app.done ? exitFor(app) : EXIT.OK;
  },

  async list(io, _args, flags) {
    const apps = await clientFor(flags).list({ ref: flags.ref });
    if (io.json) io.out({ apps });
    else if (!apps.length) io.info("No apps yet. Upload one with: taptry upload <file>");
    else for (const app of apps) io.out(`${app.slug.padEnd(28)} ${appLine(app)}${app.ref ? `  [ref ${app.ref}]` : ""}`);
    return EXIT.OK;
  },

  async delete(io, [idOrSlug], flags) {
    const client = clientFor(flags);
    const app = await resolveApp(client, idOrSlug, flags);
    if (!flags.yes) {
      if (!io.stdin.isTTY) throw new UsageError("Deleting needs confirmation - pass --yes to delete without asking.");
      const ok = await confirmPrompt(io, `Delete "${app.name}" (${app.url})? Its link, likes and stats go with it.`);
      if (!ok) {
        io.info("Not deleted.");
        return EXIT.OK;
      }
    }
    await client.delete(app.id);
    if (io.json) io.out({ deleted: true, id: app.id });
    else io.info(`Deleted ${app.name}.`);
    return EXIT.OK;
  },

  async login(io, _args, flags) {
    const key = flags["api-key"] || (await readSecret(io, "API key (from Settings > API keys): "));
    if (!key) throw new UsageError("No key given.");
    const client = new TapTryClient({ ...resolveSettings({ apiUrl: flags["api-url"] }), apiKey: key });
    const me = await client.me();
    writeConfig({ ...readConfig(), apiKey: key, ...(flags["api-url"] ? { apiUrl: flags["api-url"] } : {}) });
    io.info(`Logged in as @${me.user.usertag} (key "${me.key.name}"). Saved to ${configPath()}.`);
    return EXIT.OK;
  },

  async logout(io) {
    clearConfig();
    io.info("Forgot the saved key. (TAPTRY_API_KEY, if set, still applies.)");
    return EXIT.OK;
  },

  async whoami(io, _args, flags) {
    const me = await clientFor(flags).me();
    if (io.json) io.out(me);
    else io.out(`@${me.user.usertag} - ${me.plan.displayName} plan, ${me.plan.appsOwned}/${me.plan.maxApps} apps (key "${me.key.name}")`);
    return EXIT.OK;
  },

  async mcp(_io, _args, flags) {
    await require("./mcp").serve({ flags });
    return null; // runs until stdin closes
  },
};

async function main(argv, ioOptions = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\nRun taptry --help for usage.\n`);
    return EXIT.USAGE;
  }
  const { values: flags, positionals } = parsed;
  const io = makeIo({ ...ioOptions, json: Boolean(flags.json) });
  if (flags.version) {
    io.out(VERSION);
    return EXIT.OK;
  }
  const [command, ...rest] = positionals;
  if (flags.help || !command) {
    io.out(HELP);
    return command || flags.help ? EXIT.OK : EXIT.USAGE;
  }
  const run = commands[command];
  if (!run) {
    io.info(`Unknown command "${command}". Run taptry --help for usage.`);
    return EXIT.USAGE;
  }
  try {
    return await run(io, rest, flags);
  } catch (err) {
    if (err instanceof UsageError) {
      io.info(err.message);
      return EXIT.USAGE;
    }
    if (err instanceof TapTryError) {
      if (io.json) io.out({ error: err.message, code: err.code, status: err.status });
      else io.info(`Error: ${err.message}`);
      return EXIT.ERROR;
    }
    throw err;
  }
}

module.exports = { main, EXIT, VERSION };
