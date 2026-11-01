---
name: taptry
description: Share an Android app build as a link anyone can run in their browser (no install) by uploading it to TapTry with the `taptry` CLI. Use when the user wants to share, demo, preview or send an Android app/APK/AAB to someone, get a "try it" link for a build, or set up preview links for pull requests.
---

# TapTry: share an Android build as a link

`taptry` uploads an Android app file to the user's TapTry account and prints a
link that runs the app in any browser. It needs an API key: the user creates
one in TapTry under Settings > API keys, then either runs `npx taptry login` or
sets `TAPTRY_API_KEY`.

## Before uploading

- **Ask first.** An upload publishes the app under the user's name. Default
  visibility is public: it appears on their TapTry profile and anyone can run
  it. To share a build with specific people without listing it, use
  `--unlisted` (the printed link is a secret link). `--private`: only them.
- **Find the right file.** Accepted: `.apk`, `.aab`, `.apks`, `.xapk`, `.apkm`,
  up to 500MB. Gradle puts builds under `app/build/outputs/apk/<variant>/`
  (`./gradlew assembleDebug` or `assembleRelease`) and bundles under
  `app/build/outputs/bundle/<variant>/` (`bundleRelease`). Prefer an `.apk`:
  converted `.aab` files are re-signed by TapTry, so Google Sign-In, Maps keys
  and Play Integrity won't work in them.

## Upload

```bash
npx -y taptry upload path/to/app-release.apk --ref <stable-id>
```

- `--ref` makes re-uploads update the same app and link instead of creating a
  new one. Use something stable like `<repo-name>` or `<repo>@<branch>`, and
  reuse it every time you upload that app.
- It waits for the malware scan (usually 1-3 minutes) and prints the link on
  the last line of stdout. Exit code `3` means TapTry refused the build - the
  reason is on stderr (not an app, malware, mixed signing keys…).
- `--json` gives the full result, including `ready`, `status` and `error`.

## Other commands

```bash
npx -y taptry status <slug>        # or --ref <ref>
npx -y taptry list
npx -y taptry delete <slug> --yes  # only after the user explicitly agrees
npx -y taptry whoami
```

The Free plan allows 2 apps. If an upload fails with "plan allows up to N
apps", use `--ref` with an existing app's ref to replace it, or ask the user
which app to delete.

## Testing the app on a device (MCP)

With the TapTry MCP server installed (`npx -y taptry mcp`), you can run an
uploaded app on a cloud Android device and use it: `start_session` (the app
must be CLEAN), `screenshot` / `get_ui` to see it, `tap` (prefer
`text: "<label>"` over coordinates), `type_text` into a focused field,
`press_key` (back, enter, ...), `swipe` to scroll, `get_logs` for crashes,
and always `end_session` when done. Each session uses one of the user's runs.

## Pull-request previews

For a preview link on every PR, add the GitHub Action in the package README:
it builds the app, uploads it with `ref` `github:<repo>#<PR>`, comments the
link and deletes the preview when the PR closes. It needs the key as the
repository secret `TAPTRY_API_KEY` and `pull-requests: write` permission.
