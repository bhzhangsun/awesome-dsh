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

## Layout

```
.
├── package.json            # private workspace root
├── pnpm-workspace.yaml     # declares packages/* as workspace members
├── tsconfig.base.json      # shared TS compiler options for packages
├── .npmrc                  # pnpm settings
└── packages/               # each plugin package lives here
    ├── dsh-media/          # TypeScript package (tsdown client bundle)
    └── dsh-computer-use/   # plain-ESM JavaScript package (no build step)
```

## Package conventions

- Every plugin lives under `packages/` and is named using the
  `@bhzhangsun/<name>` scope, e.g. `packages/plugin-example` →
  `@bhzhangsun/plugin-example`.
- Packages extend `tsconfig.base.json` (`"extends": "../../tsconfig.base.json"`).
- Each package exposes the standard lifecycle scripts: `build`, `typecheck`,
  `test`, `clean`. Run them across the whole workspace with
  `pnpm -r <script>` (e.g. `pnpm build`).
- **Exception:** `packages/dsh-computer-use` is plain ESM JavaScript with no
  build step. It therefore exposes only `typecheck` (a `node --check` syntax
  gate) and `check`, and `pnpm -r build` simply skips it. Prefer `.js` here
  over introducing a bundler for a fork that tracks an upstream written in JS.

## Adding a plugin package

1. Create a directory under `packages/`, e.g. `packages/plugin-example`.
2. Add a `package.json` with `"name": "@bhzhangsun/plugin-example"`,
   a `dsh` field for any client entry points, and the standard scripts.
3. Run `pnpm install` to link it into the workspace.
