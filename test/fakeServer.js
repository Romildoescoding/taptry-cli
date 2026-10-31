// A stand-in for TapTry's /api/v1 (and GitHub's comments API) for the
// package's tests: same shapes as server/routes/v1.js, in memory. Uploaded
// apps report SCANNING for `scanPolls` status reads, then CLEAN - or ERROR
// when the uploaded file's name contains "broken".
const http = require("http");

function createFakeServer({ key = "tt_" + "a".repeat(40), scanPolls = 1 } = {}) {
  const apps = new Map();
  const comments = [];
  const requests = [];
  let seq = 0;

  const view = (a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    url: `https://taptry.test/app/${a.slug}`,
    visibility: a.isPublic ? "public" : "private",
    status: a.status,
    done: !["PENDING", "SCANNING"].includes(a.status),
    ready: a.status === "CLEAN",
    error: a.status === "ERROR" ? "We couldn't find an Android app in this file." : null,
    packageFormat: "APK",
    packageName: "com.example.game",
    versionName: "1.0",
    sizeBytes: a.size,
    ref: a.ref,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw.toString("latin1") });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // ---- fake GitHub comments API
    const gh = /^\/repos\/([^/]+\/[^/]+)\/issues\/(?:(\d+)\/comments|comments\/(\d+))$/.exec(url.pathname);
    if (gh) {
      if (req.method === "GET") return send(200, comments.filter((c) => c.issue === Number(gh[2])));
      const { body } = JSON.parse(raw.toString() || "{}");
      if (req.method === "POST") {
        const c = { id: comments.length + 1, issue: Number(gh[2]), body };
        comments.push(c);
        return send(201, c);
      }
      const c = comments.find((x) => x.id === Number(gh[3]));
      c.body = body;
      return send(200, c);
    }

    // ---- fake TapTry /api/v1
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: "Invalid or revoked API key", code: "INVALID_API_KEY" });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    if (p === "/me") return send(200, { user: { usertag: "romil" }, plan: { displayName: "Free", maxApps: 2, appsOwned: apps.size }, key: { name: "CI" } });

    if (p === "/apps" && req.method === "GET") {
      const ref = url.searchParams.get("ref");
      return send(200, { apps: [...apps.values()].filter((a) => !ref || a.ref === ref).map(view) });
    }
    if (p === "/apps" && req.method === "POST") {
      const fileName = /filename="([^"]+)"/.exec(raw.toString("latin1"))?.[1];
      if (!fileName) return send(400, { error: "No file uploaded", code: "NO_FILE" });
      const field = (n) => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(raw.toString("latin1"))?.[1];
      const ref = url.searchParams.get("ref");
      const existing = ref && [...apps.values()].find((a) => a.ref === ref);
      const status = fileName.includes("broken") ? "ERROR" : "SCANNING";
      if (existing) {
        Object.assign(existing, { status, polls: 0, size: raw.length, fileName });
        return send(200, { app: view(existing), created: false });
      }
      const id = `app${++seq}`;
      const a = { id, slug: `game-${seq}`, name: field("name") || fileName.replace(/\.\w+$/, ""), isPublic: field("public") !== "false", status, polls: 0, size: raw.length, ref, fileName };
      apps.set(id, a);
      return send(201, { app: view(a), created: true });
    }
    const one = /^\/apps\/([^/]+)$/.exec(p);
    const a = one && [...apps.values()].find((x) => x.id === one[1] || x.slug === one[1]);
    if (one && !a) return send(404, { error: "Not found", code: "NOT_FOUND" });
    if (one && req.method === "GET") {
      if (a.status === "SCANNING" && ++a.polls >= scanPolls) a.status = "CLEAN";
      return send(200, { app: view(a) });
    }
    if (one && req.method === "DELETE") {
      apps.delete(a.id);
      return send(200, { deleted: true, id: a.id });
    }
    send(404, { error: "No such endpoint", code: "NOT_FOUND" });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, key, apps, comments, requests, close: () => server.close() }),
    ),
  );
}

module.exports = { createFakeServer };
