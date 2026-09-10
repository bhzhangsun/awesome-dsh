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

## Layout

```
.
├── package.json            # private workspace root
├── pnpm-workspace.yaml     # declares packages/* as workspace members
├── tsconfig.base.json      # shared TS compiler options for packages
├── .npmrc                  # pnpm settings
└── packages/               # each plugin package lives here
```

## Package conventions

- Every plugin lives under `packages/` and is named using the
  `@bhzhangsun/<name>` scope, e.g. `packages/plugin-example` →
  `@bhzhangsun/plugin-example`.
- Packages extend `tsconfig.base.json` (`"extends": "../../tsconfig.base.json"`).
- Each package exposes the standard lifecycle scripts: `build`, `typecheck`,
  `test`, `clean`. Run them across the whole workspace with
  `pnpm -r <script>` (e.g. `pnpm build`).

## Adding a plugin package

1. Create a directory under `packages/`, e.g. `packages/plugin-example`.
2. Add a `package.json` with `"name": "@bhzhangsun/plugin-example"`,
   a `dsh` field for any client entry points, and the standard scripts.
3. Run `pnpm install` to link it into the workspace.
