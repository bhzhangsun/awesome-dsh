# @bhzhangsun/dsh-agent-server

One install turns [dsh](https://github.com/deepseek-ai/deepseek-harness) into a
resident, **headless AI agent server**: a pure-reasoning agent exposed over the
HTTP/WS API, with no browser GUI.

```bash
npm install -g @bhzhangsun/dsh-agent-server
dsh --profile server
```

That is the whole setup. The package installs both halves the boot needs — a
**profile** and an **agent preset** — into your dsh home.

## What you get

**The `server` profile** — a copy of the `web` profile's bundles (`dsh-base` +
`dsh-web-app`) with the browser surface closed and the API surface kept:

- The `/api` transport survives: the `connection` node half, the Typert Remote
  gateway, and the webserver stay mounted. Every `dsh-client-ui-*` row,
  `client-hmr`, `modules`, and `cordis-client-runner` is disabled.
- `web-runtime` stops auto-opening a browser and still prints the URL line.
- The roster defaults to the `server` preset, so every session on this profile
  boots the server agent with no picker and no `--patch` overlay.

Callers reach it over:

```
ws://<host>:<port>/api/remote.mux   (Typert Remote RPC)
http://<host>:<port>/api/...        (HTTP RPC bridge)
```

**The `server` agent preset** — a pure-reasoning orchestration agent. It
deliberately omits the shell, the filesystem/editor tools, web search/fetch, and
plan mode. What remains is what an API-driven agent needs: `ask_user`, `todo`,
`goal`, background `jobs`, `subagent` / `subagent_fork`, `workflow`, `ralph`, and
context compaction. It reasons and orchestrates; it does not execute.

Subagents and workflows may be enabled, but their **write** endpoints are not part
of this preset: data changes require user approval through the API layer, so the
agent only reasons and orchestrates.

## Why both halves ship in one package

They are two halves of one deliverable, and dsh resolves each from a *different*
on-disk convention under `$DSH_HOME` — neither is reachable from an installed
package's `node_modules`:

| Half | Installed to | Resolved by |
| --- | --- | --- |
| `profile/` | `$DSH_HOME/profiles/server/` | `dsh --profile server` (`resolveProfileDir`) |
| `preset/` | `$DSH_HOME/.agent-presets/server/` | the roster's user-root scan |

The two also depend on each other in opposite directions, which is why splitting
them across two packages left each one incomplete:

- The profile's patch sets `agent-presets: default: server` — it **requires the
  preset** to be installed, or it defaults to a preset that does not exist.
- The preset is pure agent-plane and **cannot** close the browser GUI or keep the
  API transport — that lives in the host composition, i.e. the profile.

Shipping them together makes `npm install` + `dsh --profile server` the entire
path from nothing to a running agent server.

## Package layout

```
dsh-agent-server/
  package.json          # npm manifest: bin + postinstall
  bin/install.js        # installs both halves into $DSH_HOME, idempotently
  profile/              # -> $DSH_HOME/profiles/server/
    package.json        #   dsh.profile.bundles = dsh-base + dsh-web-app
    cordis.yml          #   empty root entry list (the tree is built from patches)
    cordis.patch.yml    #   closes the browser GUI; defaults the roster to `server`
    pnpm-workspace.yaml #   pnpm settings for out-of-tree plugins
  preset/               # -> $DSH_HOME/.agent-presets/server/
    agent.cordis.yml    #   the server preset composition
    preset.yml          #   display metadata (name / description)
  proxy/                # network exposure + auth (see below)
    Caddyfile.example   #   declarative, per-route auth via forward_auth
    auth-proxy.mjs      #   reference Node proxy, per-route auth table
  docs/
    NETWORK-AND-AUTH.md #   how to expose this safely
  test/                 # node --test suite (installer + proxy)
  README.md
  LICENSE
```

## Managing the install

A **global** install writes both halves automatically. Any other install — as
another project's dependency, or inside this repository's workspace — writes
nothing, so it cannot overwrite a profile you are already running:

```bash
npm install -g @bhzhangsun/dsh-agent-server   # installs both halves
npx @bhzhangsun/dsh-agent-server              # install them explicitly instead
```

Drive it yourself with:

```bash
dsh-agent-server --dry-run     # show resolved target paths, write nothing
dsh-agent-server --uninstall   # remove both installed copies
dsh-agent-server --help
```

| Variable | Effect |
| --- | --- |
| `DSH_HOME` | target a different dsh home |
| `DSH_AGENT_SERVER_INSTALL=1` | force the `postinstall` to install (useful in CI or a container build) |
| `DSH_AGENT_SERVER_SKIP_INSTALL=1` | make the `postinstall` a no-op, even on a global install |

Upgrading is `npm install -g` again: the installer overwrites both copies with the
new versions.

## Exposing it on a network

The profile deliberately keeps the server on **loopback**. Publishing the agent
to a network — with authentication your business owns, applied per route — is a
reverse-proxy concern, and it is documented in
[`docs/NETWORK-AND-AUTH.md`](./docs/NETWORK-AND-AUTH.md). Two starting points
ship in [`proxy/`](./proxy):

- `Caddyfile.example` — per-route `forward_auth` against a verifier you write.
- `auth-proxy.mjs` — a dependency-free Node proxy with an explicit per-route
  auth table, HTTP plus WebSocket upgrade forwarding, that **fails closed**.

Binding dsh itself to `0.0.0.0` while authenticating in a proxy would leave the
port directly reachable and bypass auth; the doc explains the two configurations
that are safe and why the mixed one is not.

## Notes

- The profile needs no private `node_modules`: both bundles resolve from the dsh
  installation itself.
- Installing the package does **not** touch an existing `server` profile or
  preset beyond overwriting those two directories. Any other profile (for example
  `desktop`) is left alone.
- To get the browser GUI back, boot `dsh --profile web` instead of removing
  anything.
- `dsh --profile server` needs no `--patch` overlay — the profile already carries
  the patch that used to be applied by hand.
- On a network, remember `--trusted-host <public-authority>`: dsh's `/api` trust
  fence refuses a Host it was not told about.
