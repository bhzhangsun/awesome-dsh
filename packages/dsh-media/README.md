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
- **Client** (`src/client/fenceRenderer.ts`) watches assistant replies for
  ` ```dsh-media ` code fences and replaces each with a block-level player.
  Because the player lives in the message body, it stays visible even when the
  turn-process disclosure is folded.

The player is deliberately **not** rendered from the `tool/result` node: the
`media_render` output stays inside the tool-call area (which folds), while the
message body carries the player.

### Update semantics — on demand, never rebuilt for free

The player is mounted from the DOM side, so it has to survive a conversation that
re-renders continuously. A fence element is therefore never the identity of a
player:

- **Only touched fences are examined.** The `MutationObserver` reacts to a batch
  only when it adds, removes, or edits a fence (or pulls one of our mount
  containers out of the tree). There is no whole-page rescan, and churn inside a
  running player — its seek bar, its timer — is ignored.
- **Parsing is memoized** per fence body and info string, so a streaming reply is
  not re-`JSON.parse`d on every mutation.
- **Rendering is diffed.** A player re-renders only when its items really change;
  with an unchanged `url` React keeps the same `<audio>`/`<video>` element, so a
  new title or caption refetches nothing.
- **A player outlives its fence.** When React replaces a fence element — or a
  whole message subtree — with fresh nodes, the live player is parked and
  re-homed onto the equivalent fence (identical items) or re-attached to the same
  fence, keeping the media element and its playback state. Only a fence that
  stays gone for a full second tears its player down, so real edits and deletions
  still clean up.

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
render — it is not a general file browser.

### The mapping is persisted, and tokens never expire

A `dsh-media` fence is **stored text**: it carries its URL into the transcript,
where it is requested again on every page load, in later sessions, and long after
the process that minted it exited. So the map lives in
`${DSH_HOME:-~/.dsh}/storages/dsh-media/served.json` and is restored at startup by
every process that serves it:

- a **restart** (or a client reload that follows one) no longer turns the players
  in older replies into 404s;
- tokens have **no TTL** — an old reply keeps playing;
- re-publishing the same file reuses its token, so a reply and a later re-render
  share one URL;
- entries whose file is gone are dropped at load, and the map is capped at 4096
  entries, so the file cannot grow without bound;
- several DSH processes (the desktop app and a `dsh` CLI session, say) share the
  one file: a write merges what is already there, and a miss re-reads it once
  before answering 404, so neither process can strand the other's URLs.

The client also re-homes a `/media/<token>` URL onto the origin serving the page
(`resolveMediaSrc`), so a URL minted on another port — the port is chosen at
startup — still resolves. A player that cannot load anything at all says so
instead of sitting at 0:00 or showing a black frame.

### Recovery from session history

The map only starts existing from the version that introduced it, so URLs minted
before it are gone with the process that minted them. They are recoverable
anyway, because the session log still records both halves of every render: the
`tool/call` event carries the file reference the tool was given, and the
`tool/result` event carries the token URL it published. `sessionLog.ts` pairs them
by call id, and `historyHeal.ts` resolves each reference against the session's own
`cwd` and adopts the token — reviving the players in **existing** replies without
the files being rendered again.

The pass runs in the background when the plugin activates, and again on demand
when a request arrives for a token this process has never seen, so the very
request that would have 404'd is served instead. It stays cheap: newest log first,
logs whose size and mtime are unchanged since the previous pass are skipped, and a
wall-clock budget bounds the walk. On a real tree of ~110 logs / 130 MB it
recovers everything in about 6 seconds, yielding to the event loop between logs.

Two details worth knowing, both of which cost a debugging session to learn:

- a session log is JSONL **appended in zstd frames** (one per flush), so a long
  session is thousands of frames in one file. Decompressing the file as a single
  stream returns only the first frame — the session header — and recovers nothing;
- sessions are nested by workspace, and some directories are named by raw UUID
  rather than `session-<id>`, so the walk is recursive instead of a fixed-depth
  glob.

## Layout

```
src/
  index.ts            # host entry (name / inject / apply re-exports)
  tool.ts             # media_render tool + /media route wiring
  projection.ts       # result helpers (mediaRenderResult / normalizeMediaItems)
  mediaServer.ts      # local-file resolution + /media/<token> HTTP serving
  mediaStore.ts       # the persisted token → file map (survives a restart)
  historyHeal.ts      # recovers tokens from session logs (revives old replies)
  sessionLog.ts       # reads a zstd-framed session log for media_render calls
  skillContent.ts     # runtime skill text
  shared/
    schema.ts         # tool JSON schema + validation helpers
    types.ts          # MediaItem / MediaRenderResult
  client/
    index.ts          # client entry: styles + fence renderer
    fenceRenderer.ts  # replaces dsh-media fences with block-level players
    InlineMedia.tsx   # the audio player bar, the video block, the failure notice
    mediaUrl.ts       # re-homes a /media/<token> url onto this page's origin
    styles.ts         # injected CSS
test/
  media.test.ts       # pure host-logic tests
  mediaStore.test.ts  # token persistence across a restart, via the real route
  historyHeal.test.ts # recovery from planted session logs, incremental passes
  sessionLog.test.ts  # the zstd-frame reader and the call/result pairing
  client.test.ts      # url re-homing + the media-unavailable state
  fenceRenderer.test.ts # the fence renderer, in jsdom with real React
  logFixture.ts       # builds zstd-framed session logs for those tests
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
  served URL), the count of media URLs recovered from session history, and
  rejections.
- **Client** (`console`): fence-renderer activation.

## Known limitations

- The player is produced by scanning the rendered message DOM, so the client half
  must be loaded — reload the page after installing or updating the plugin.
- A `media_render` call whose reply has **no** `dsh-media` fence shows no player:
  the fence is what carries the player into the message body.
