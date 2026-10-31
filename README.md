# taptry

Turn an Android build into a link anyone can run in their browser - no
install, no sideloading. From your terminal, from CI on every pull request,
or from your coding assistant.

```bash
npx taptry upload app/build/outputs/apk/release/app-release.apk
# Uploading app-release.apk (18.2 MB)…
# Created My Game - https://taptry.in/app/my-game
# Waiting for the malware scan and checks (this can take a few minutes)…
#   Checking for malware…
#   Ready
# https://taptry.in/app/my-game
```

Takes `.apk`, `.aab`, `.apks`, `.xapk` and `.apkm`, up to 500MB. Every upload
is malware-scanned before its link works. Needs Node 20+; no dependencies.

## Setup

1. In [TapTry](https://taptry.in), open **Settings > API keys** and create a key.
2. Either save it on your machine - `npx taptry login` - or set
   `TAPTRY_API_KEY` (what CI should do).

## CLI

```
taptry upload <file> [--name <name>] [--ref <ref>] [--private] [--no-wait] [--timeout <s>] [--json]
taptry status <app> | --ref <ref>
taptry list [--ref <ref>]
taptry delete <app> | --ref <ref> [--yes]
taptry login | logout | whoami
taptry mcp
```

- **`--ref`** is your own id for an app, e.g. `github:me/game#42`. Uploading
  again with the same ref **replaces that app's file and keeps its link** -
  use it for anything you upload repeatedly.
- **`--private`**: only you can open it. Default: anyone with the link (it
  also shows on your TapTry profile).
- `upload` waits for the checks by default and prints the link on stdout,
  so `URL=$(taptry upload app.apk)` works. `--json` prints the whole result.
- `delete` asks first; without a terminal it needs `--yes`.

Exit codes: `0` ok · `1` error (network, auth, refused request) · `2` bad
usage · `3` the app failed its checks (malware, not an app, …) · `4` timed out
waiting for the checks.

## GitHub Action: a preview link on every pull request

Each pull request gets one TapTry app and one comment with its link, updated
on every push and deleted when the PR closes.

```yaml
# .github/workflows/taptry-preview.yml
name: TapTry preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read
  pull-requests: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        if: github.event.action != 'closed'
      - uses: actions/setup-java@v4
        if: github.event.action != 'closed'
        with:
          distribution: temurin
          java-version: 17
      - name: Build
        if: github.event.action != 'closed'
        run: ./gradlew assembleDebug
      - uses: TAPTRY_ORG/taptry@v1
        with:
          api-key: ${{ secrets.TAPTRY_API_KEY }}
          file: app/build/outputs/apk/debug/app-debug.apk
```

Add your key as the repository secret `TAPTRY_API_KEY`. Pull requests from
forks don't get secrets, so their previews are skipped with a warning.

| Input | Default | |
|---|---|---|
| `api-key` | - | **Required.** |
| `file` | - | The build output. A glob is fine if it matches exactly one file. |
| `name` | from the file | App name, set on the first upload. |
| `ref` | `github:<repo>#<PR>` or `github:<repo>@<branch>` | Same ref, same app. |
| `visibility` | `public` | `public` or `private`. |
| `wait` / `timeout` | `true` / `900` | Wait for the checks. |
| `comment` | `true` | Keep one PR comment up to date. |
| `delete-on-close` | `true` | Delete the preview when the PR closes. |
| `fail-on-error` | `true` | Fail the step when the build is refused. |

Outputs: `url`, `app-id`, `slug`, `status`, `ready`.

Outside pull requests (e.g. `on: push` to `main`), it keeps one app per
branch: `github:<repo>@main`.

## MCP server: "build it and give me a link"

`taptry mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server for Claude Code, Cursor, Claude Desktop and other MCP clients. Tools:
`upload_app`, `get_status`, `get_link`, `list_apps`, `delete_app`. The
assistant is told to ask before uploading or deleting, and `delete_app`
refuses unless `confirm: true` is passed.

**Claude Code**

```bash
claude mcp add taptry -e TAPTRY_API_KEY=tt_your_key -- npx -y taptry mcp
```

**Cursor** (`~/.cursor/mcp.json`) or **Claude Desktop**
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "taptry": {
      "command": "npx",
      "args": ["-y", "taptry", "mcp"],
      "env": { "TAPTRY_API_KEY": "tt_your_key" }
    }
  }
}
```

After `taptry login` you can leave out the `env` block.

## API

Everything here wraps TapTry's public HTTP API at
`https://api.taptry.in/api/v1` (bearer-token auth with the same key). A
full reference for using it directly is coming to TapTry's docs.

## License

MIT
