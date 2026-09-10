# proxy/ — network exposure and authentication

Two interchangeable ways to put the agent server on a network. Both keep dsh on
loopback and enforce auth **in the proxy**, per route.

Read [`../docs/NETWORK-AND-AUTH.md`](../docs/NETWORK-AND-AUTH.md) first — it
explains the trust fence, the WebSocket requirement, and the configuration that
must be avoided.

## Start dsh with the public authority declared

The `/api` trust fence refuses a `Host` it was not told about, so both proxies
below require this:

```sh
dsh --profile server --trusted-host agent.example.com
```

## Option 1 — Caddy (declarative)

```sh
caddy run --config proxy/Caddyfile.example
```

Edit the site address and point every `forward_auth` at your verifier. The
verifier is yours to write; it answers `200` to allow and `401`/`403` to deny:

```sh
# what Caddy calls, one probe path per route
POST /verify/jwt       Authorization: Bearer <jwt>
POST /verify/apikey    X-API-Key: <key>
POST /verify/session   Cookie: dsh_session=<id>
```

## Option 2 — the reference Node proxy (code)

```sh
JWT_SECRET=... API_KEYS=key1,key2 node proxy/auth-proxy.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BIND_HOST` | `0.0.0.0` | interface to listen on |
| `BIND_PORT` | `8443` | port (`0` picks a free one and logs it) |
| `UPSTREAM_HOST` | `127.0.0.1` | dsh host |
| `UPSTREAM_PORT` | `3080` | dsh port |
| `JWT_SECRET` | — | HS256 secret for the JWT policy |
| `API_KEYS` | — | comma-separated accepted API keys |

Auth rules live in the `ROUTES` table at the top of `auth-proxy.mjs`. First match
wins and **no match denies**, so a new path is closed until you give it a policy.

```js
const ROUTES = [
  { name: 'remote-mux', match: (p) => p === '/api/remote.mux', authenticate: requireJwt },
  { name: 'api-rpc',    match: (p) => p.startsWith('/api/'),   authenticate: requireApiKeyOrJwt },
  { name: 'plugin-assets', match: (p) => p.startsWith('/plugins/'), authenticate: requireSession },
]
```

It forwards HTTP and WebSocket upgrades, preserves the caller's `Host` (required
by the trust fence), and applies auth to the upgrade path — not just to HTTP.

### What this reference is not

It is a starting point, not a hardened edge: no TLS (terminate in front or switch
to `node:https`), no rate limiting, no request-size cap, and no session store.
Add those before facing the internet.

## Tests

`test/auth-proxy.test.mjs` boots a fake upstream plus the proxy and asserts
fail-closed routing, per-route policies, `Host` preservation, and that an
**unauthenticated WebSocket upgrade is refused without reaching the upstream**:

```sh
pnpm --filter @bhzhangsun/dsh-agent-server test
```
