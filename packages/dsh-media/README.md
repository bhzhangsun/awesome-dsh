# @bhzhangsun/dsh-media

Audio/video output for [DSH (DeepSeek Harness)](https://github.com/anywhere-labs/deepseek-harness-desktop):
gives the agent a `media_render` tool that serves a local or remote audio/video
file over DSH's own webserver and renders a block-level player in the assistant
message body.

## Install

```sh
dsh plugin --profile <profile> add @bhzhangsun/dsh-media
```

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), so the official CLI
wires it up: it installs the package into the profile and appends
`@bhzhangsun/dsh-media` to `dsh.profile.bundles`. No manual profile edits and no
local path linking are needed. Restart DSH (and reload the page) so both halves
load.

## How it works

- **Host** (`src/tool.ts`) registers the `media_render` model tool. Each item is
  either an absolute `http(s)` URL or a local file reference; local files are
  served over HTTP. The tool result text also lists the resolved browser URLs, so
  the model can emit them in a fence.
- **Client** (`src/client/fenceRenderer.ts`) scans assistant replies for
  ` ```dsh-media ` code fences and replaces each with a block-level player.
  Because the player lives in the message body, it stays visible even when the
  turn-process disclosure is folded.

The player is deliberately **not** rendered from the `tool/result` node: the
`media_render` output stays inside the tool-call area (which folds), while the
message body carries the player.

### Why the fence renderer matches the wrapper

DSH renders a fenced code block as a block-level `md-code-block` container whose
`<code>` element carries **no** `language-*` class and **no** `data-lang`
attribute — the info string lives in an `.infostring` child. The renderer
therefore matches the wrapper (`.md-code-block`), reads the info string, and
falls back to parsing the code body as a `dsh-media` JSON block.

## Rendering

- **Audio** — a block-level player bar: play/pause + file name (fixed-width
  column) on the left; seek bar (3px track, draggable) + time + mute + playback
  rate on the right.
- **Video** — a block-level native `<video controls>` at full width; the file
  name overlays the top-left corner on hover.

Both use `currentColor` plus `color-scheme: dark light`, so they follow the
conversation theme in light and dark mode.

## The `media_render` tool

```jsonc
{
  "items": [
    { "kind": "audio", "url": "https://.../clip.mp3", "title": "Podcast" },
    { "kind": "video", "url": "refs/demo.mp4", "poster": "poster.jpg", "caption": "Overview" }
  ]
}
```

`url` is one of:

- **Absolute `http(s)` URL** — used as-is.
- **Local file reference** — an absolute path, a path relative to the session
  workspace (which may use `../`), or a `file://` URL pointing at any local media
  file the agent references. The host resolves it to an existing regular file and
  serves it over HTTP.

## Serving local files — `127.0.0.1` vs `file://`

The conversation client is served by the DSH host webserver on
`http://127.0.0.1:<port>`. A page loaded over `http://127.0.0.1` **cannot** load
`file://` media (Chromium blocks it as cross-origin), so local media is never
referenced by `file://`. Instead the plugin:

1. registers a `GET /media/<token>` route on `@deepseek-ai/dsh-host-webserver`;
2. on `media_render`, resolves the local path to an existing file (absolute,
   workspace-relative, or `file://`; `../` is allowed), stores an opaque
   `token → path` mapping server-side, and rewrites the item URL to
   `http://127.0.0.1:<port>/media/<token>`.

The route supports `Range` requests so video can seek. Because the URL is
token-based (never the real pathname) and only minted by the agent's
`media_render` call, the host only exposes files the agent explicitly asked to
render — it is not a general file browser. Tokens expire after one hour and the
map is bounded.

## Layout

```
src/
  index.ts            # host entry (name / inject / apply re-exports)
  tool.ts             # media_render tool + /media route wiring
  projection.ts       # result helpers (mediaRenderResult / normalizeMediaItems)
  mediaServer.ts      # local-file resolution + /media/<token> HTTP serving
  skillContent.ts     # runtime skill text
  shared/
    schema.ts         # tool JSON schema + validation helpers
    types.ts          # MediaItem / MediaRenderResult
  client/
    index.ts          # client entry: styles + fence renderer
    fenceRenderer.ts  # replaces dsh-media fences with block-level players
    InlineMedia.tsx   # the audio player bar and the video block
    styles.ts         # injected CSS
test/
  media.test.ts       # pure host-logic tests
```

## Build scripts

```sh
pnpm build          # tsdown (client bundle) + tsc (host + client types)
pnpm typecheck      # tsc --noEmit for host + client
pnpm test           # vitest
pnpm clean          # remove lib/
```

## Logging

- **Host** (`ctx.logger`): activation, `/media` route registration, each
  `media_render` call, URL resolution (`http(s)` pass-through vs local file →
  served URL), and rejections.
- **Client** (`console`): fence-renderer activation.

## Known limitations

- The player is produced by scanning the rendered message DOM, so the client half
  must be loaded — reload the page after installing or updating the plugin.
- A `media_render` call whose reply has **no** `dsh-media` fence shows no player:
  the fence is what carries the player into the message body.
