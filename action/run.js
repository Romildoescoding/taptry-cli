// The GitHub Action (action.yml): upload a build, and on a pull request keep
// one comment with its TapTry link up to date. When the pull request closes,
// delete the preview. No dependencies - inputs, outputs and the GitHub API
// are plain environment variables, files and fetch.
const fs = require("fs");
const path = require("path");
const { TapTryClient, TapTryError, describeStatus } = require("../lib/client");

const MARKER = "<!-- taptry-preview -->";

// GitHub passes input `api-key` as env INPUT_API-KEY (hyphen kept).
const input = (name, fallback = "") => (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim() || fallback;
const bool = (name, fallback) => {
  const v = input(name);
  return v === "" ? fallback : /^(true|yes|1|on)$/i.test(v);
};

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `taptry_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delim}\n${value ?? ""}\n${delim}\n`);
}
const log = (msg) => console.log(msg);
const warn = (msg) => console.log(`::warning::${msg}`);
const fail = (msg) => {
  console.log(`::error::${msg}`);
  process.exitCode = 1;
};

function readEvent() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** The one file `pattern` names - a path, or a glob that must match exactly one file. */
function resolveFile(pattern) {
  if (!/[*?[]/.test(pattern)) return pattern;
  const matches = fs.globSync(pattern).filter((f) => fs.statSync(f).isFile());
  if (matches.length !== 1) {
    throw new TapTryError(
      matches.length ? `"${pattern}" matches ${matches.length} files (${matches.join(", ")}) - make it match one` : `"${pattern}" matches no files - did the build step run?`,
    );
  }
  return matches[0];
}

// ------------------------------------------------------------ comments ---

async function github(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${input("github-token")}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function upsertComment(repo, number, body) {
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const text = `${MARKER}\n${body}`;
  for (let page = 1; page <= 10; page++) {
    const comments = await github("GET", `${api}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const mine = comments.find((c) => c.body?.includes(MARKER));
    if (mine) return github("PATCH", `${api}/repos/${repo}/issues/comments/${mine.id}`, { body: text });
    if (comments.length < 100) break;
  }
  return github("POST", `${api}/repos/${repo}/issues/${number}/comments`, { body: text });
}

function commentBody(app, { sha, fileName }) {
  const short = sha ? sha.slice(0, 7) : "";
  const build = `\`${fileName}\`${app.packageFormat ? ` (${app.packageFormat}${app.versionName ? `, v${app.versionName}` : ""})` : ""}`;
  if (app.ready) {
    return [
      "### TapTry preview",
      `**[▶ Run ${app.name} in your browser](${app.url})** - no install needed.`,
      "",
      `Build ${build}${short ? ` from ${short}` : ""}. ${
        app.visibility === "private"
          ? "Private: only the uploader can open it."
          : app.visibility === "unlisted"
            ? "Unlisted: anyone with this link can run it; it isn't listed anywhere on TapTry."
            : "Anyone can run it."
      }`,
    ].join("\n");
  }
  if (!app.done) {
    return [
      "### TapTry preview",
      `Still being checked for malware - [the link](${app.url}) will work once that finishes.`,
      "",
      `Build ${build}${short ? ` from ${short}` : ""}.`,
    ].join("\n");
  }
  return ["### TapTry preview", `**Not available:** ${describeStatus(app)}`, "", `Build ${build}${short ? ` from ${short}` : ""}.`].join("\n");
}

// ---------------------------------------------------------------- main ---

async function run() {
  const event = readEvent();
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = event.pull_request;
  const apiKey = input("api-key");

  if (!apiKey) {
    if (pr && pr.head?.repo?.full_name && pr.head.repo.full_name !== repo) {
      warn("No TapTry API key - pull requests from forks don't get repository secrets, so this preview is skipped.");
      return;
    }
    return fail("No TapTry API key. Add one as a repository secret and pass it as `api-key: ${{ secrets.TAPTRY_API_KEY }}`.");
  }

  const client = new TapTryClient({
    apiKey,
    apiUrl: input("api-url", "https://api.taptry.in").replace(/\/+$/, ""),
    userAgent: "taptry-github-action",
  });
  const ref = input("ref") || (pr ? `github:${repo}#${pr.number}` : `github:${repo}@${process.env.GITHUB_REF_NAME || "main"}`);
  const comment = bool("comment", true) && pr && input("github-token");

  // The pull request closed: the preview has done its job.
  if (pr && event.action === "closed") {
    if (!bool("delete-on-close", true)) return log("Pull request closed - keeping the preview (delete-on-close: false).");
    const app = await client.findByRef(ref);
    if (!app) return log(`Pull request closed - no preview with ref ${ref} to delete.`);
    await client.delete(app.id);
    log(`Pull request closed - deleted preview ${app.name} (${ref}).`);
    if (comment) await upsertComment(repo, pr.number, "### TapTry preview\nRemoved - the pull request was closed.");
    return;
  }

  const pattern = input("file");
  if (!pattern) return fail("Input `file` is required - the path of the .apk/.aab/.apks/.xapk/.apkm your build produced.");
  const file = resolveFile(pattern);
  const fileName = path.basename(file);
  log(`Uploading ${file} as ${ref}…`);
  const { app: uploaded, created } = await client.upload(file, {
    name: input("name") || undefined,
    ref,
    visibility: input("visibility", "unlisted"),
  });
  log(`${created ? "Created" : "Updated"} ${uploaded.name}: ${uploaded.url}`);

  const timeoutSec = Number(input("timeout", "900"));
  let app = uploaded;
  if (bool("wait", true)) {
    let last = "";
    app = await client.waitUntilDone(uploaded.id, {
      timeoutMs: (Number.isFinite(timeoutSec) ? timeoutSec : 900) * 1000,
      onPoll: (a) => {
        const line = describeStatus(a);
        if (line !== last) log(`  ${line}`);
        last = line;
      },
    });
  }

  setOutput("url", app.url);
  setOutput("app-id", app.id);
  setOutput("slug", app.slug);
  setOutput("status", app.status);
  setOutput("ready", String(app.ready));
  if (comment) await upsertComment(repo, pr.number, commentBody(app, { sha: pr.head?.sha, fileName }));

  if (app.ready) log(`Ready: ${app.url}`);
  else if (!app.done) warn(`Still being checked after ${timeoutSec}s - the link will work once the scan finishes: ${app.url}`);
  else if (bool("fail-on-error", true)) fail(`TapTry couldn't use this build: ${describeStatus(app)}`);
  else warn(`TapTry couldn't use this build: ${describeStatus(app)}`);
}

module.exports = { run, commentBody, resolveFile, MARKER };

if (require.main === module) {
  run().catch((err) => fail(err instanceof TapTryError ? err.message : err.stack || String(err)));
}
