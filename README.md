# awesome-dsh

A [pnpm](https://pnpm.io) monorepo of [DSH (DeepSeek Harness)](https://github.com/anywhere-labs/deepseek-harness-desktop)
plugins published as npm packages.

DSH is itself a Cordis-based plugin system composed from many `@deepseek-ai/dsh-*`
packages. This repository is a home for additional/community plugins that plug
into the same tooling.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm (pinned via `packageManager` to `pnpm@11.8.0`). Install it once with:
  ```sh
  corepack enable
  ```
  or use the globally installed pnpm.

## Getting started

```sh
pnpm install
```

## Packages

| Package | What it does | Language / build |
| --- | --- | --- |
| [`@bhzhangsun/dsh-media`](./packages/dsh-media) | Renders audio/video in the assistant message body: a `media_render` tool plus a `dsh-media` fence replaced by a block-level player. | TypeScript (tsdown client bundle) |
| [`@bhzhangsun/dsh-computer-use`](./packages/dsh-computer-use) | Computer Use: virtual-cursor desktop automation with native vision, 12 model-facing tools, backed by cua-driver. | Plain ESM JavaScript, no build step — a fork of [`988hj7tczd-oss/dsh-computer-use`](https://github.com/988hj7tczd-oss/dsh-computer-use), see its `NOTICE` |
| [`@bhzhangsun/dsh-agent-server`](./packages/dsh-agent-server) | Turns dsh into a headless AI agent server: installs the `server` profile (HTTP/WS API, browser GUI off) with the `server` agent preset (pure-reasoning orchestration), then `dsh --profile server`. Ships a reference reverse proxy for business-owned, per-route auth. | Plain ESM JavaScript, no build step |

## Layout

```
.
├── package.json            # private workspace root
├── pnpm-workspace.yaml     # declares packages/* as workspace members
├── tsconfig.base.json      # shared TS compiler options for packages
├── .npmrc                  # pnpm settings
├── .githooks/              # committed git hooks (see Releases and tags)
├── .github/workflows/      # CI — GitHub only runs workflows from the root
├── scripts/                # repository tooling
└── packages/               # each plugin package lives here
    ├── dsh-media/          # TypeScript package (tsdown client bundle)
    ├── dsh-computer-use/   # plain-ESM JavaScript package (no build step)
    └── dsh-agent-server/   # plain-ESM JavaScript package (installs a dsh profile + preset)
```

## Package conventions

- Every plugin lives under `packages/` and is named using the
  `@bhzhangsun/<name>` scope, e.g. `packages/plugin-example` →
  `@bhzhangsun/plugin-example`.
- Packages extend `tsconfig.base.json` (`"extends": "../../tsconfig.base.json"`).
- Each package exposes the standard lifecycle scripts: `build`, `typecheck`,
  `test`, `clean`. Run them across the whole workspace with
  `pnpm -r <script>` (e.g. `pnpm build`).
- **Exception:** `packages/dsh-computer-use` and `packages/dsh-agent-server` are
  plain ESM JavaScript with no build step. They therefore expose `typecheck` (a
  `node --check` syntax gate), `test`, and `check`, and `pnpm -r build` simply
  skips them. Prefer `.js` here over introducing a bundler for a fork that tracks
  an upstream written in JS, or for an installer that ships data files.

## Adding a plugin package

1. Create a directory under `packages/`, e.g. `packages/plugin-example`.
2. Add a `package.json` with `"name": "@bhzhangsun/plugin-example"`,
   a `dsh` field for any client entry points, and the standard scripts.
3. Run `pnpm install` to link it into the workspace.

## Releases and tags

Three packages ship from this repository, so release tags are namespaced per
package — never a bare `vX.Y.Z`:

| Tag | Package |
| --- | --- |
| `media-vX.Y.Z` | `@bhzhangsun/dsh-media` |
| `computer-use-vX.Y.Z` | `@bhzhangsun/dsh-computer-use` |
| `agent-server-vX.Y.Z` | `@bhzhangsun/dsh-agent-server` |

(`v0.1.0` and `v0.1.1` predate this convention and remain as published history.)

**Never run `git push --tags`.** `packages/dsh-computer-use` is a fork, so this
repository also fetches from an upstream that tags its own releases. A plain tag
fetch once left those foreign tags (`v0.3.0`, `v0.3.1`) in this repository, and
`--tags` would have published them as if they were our releases. Two mechanisms
now prevent that:

1. The `cu-upstream` remote is configured with `tagOpt = --no-tags`, and the
   foreign tags were deleted, so a normal `git fetch` / `git pull` cannot bring
   them back.
2. `.githooks/pre-push` rejects any tag that is not `media-v*`,
   `computer-use-v*` or `agent-server-v*`, so an accidental `--tags` fails
   loudly instead of silently publishing someone else's tags. `pnpm install`
   activates it through the root `prepare` script; run `pnpm hooks` to
   (re)install it by hand.

Push the tag you actually mean:

```sh
git tag -a computer-use-v0.3.8 -m "..." && git push origin computer-use-v0.3.8
```

Publishing is per package:

```sh
cd packages/dsh-media && npm publish
cd packages/dsh-computer-use && npm publish
cd packages/dsh-agent-server && npm publish
```

For defence in depth, a GitHub **tag ruleset** makes the foreign shape
impossible to create server-side at all: Settings → Rules → Rulesets → New tag
ruleset, target *Tags*, include pattern `v*`, add the **Restrict creations**
rule, and leave the bypass list empty. (`v*` cannot match `media-v*`,
`computer-use-v*` or `agent-server-v*`.)

## Upstream sync (dsh-computer-use)

`packages/dsh-computer-use` tracks
[`988hj7tczd-oss/dsh-computer-use`](https://github.com/988hj7tczd-oss/dsh-computer-use)
through `git subtree`, so the fork's own history — and the shared upstream base
`ad754a9` (v0.2.0) — is preserved here. The two sides have diverged
independently, so expect real conflicts, not a fast-forward.

```sh
git fetch cu-upstream
git subtree pull --prefix=packages/dsh-computer-use cu-upstream main
```

Keep these deliberate divergences when resolving conflicts:

- **Our README and docs win.** Upstream rewrites its README often; ours is the
  product README for this package. On conflict, keep ours.
- **`package-lock.json` stays deleted** — this is a pnpm workspace, and a second
  lockfile only misleads. Upstream tracks it.
- **`.github/workflows/` lives at the repository root**, because GitHub runs
  workflows only from the root. Upstream's `packages/dsh-computer-use/.github/`
  copy stays removed; the root `computer-use-ci.yml` is what actually runs.

Upstream is pulled, never pushed: the personal fork was retired, so there is no
`git subtree push` target. Contributing a change back upstream means re-forking
first.
