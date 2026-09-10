# Network exposure and authentication

How to put this agent server on a network, with authentication the business owns
and applies per route.

The short version: **dsh keeps binding loopback; a reverse proxy you own binds the
network and enforces auth.** Both halves matter, and mixing them is unsafe — see
[the trap](#the-trap-do-not-mix-the-two).

```
   client ──── TLS + auth ────►  reverse proxy        ──── plain HTTP ────►  dsh
   (browser, SDK, curl)         0.0.0.0:8443              127.0.0.1:3080
                                business-owned auth        profile: server
                                per-route rules            GUI closed, /api kept
```

## Why dsh stays on loopback

`dsh --host 0.0.0.0` is refused by the CLI on purpose:

```ts
// deepseek-harness/packages/bundle/web-app/src/startup.ts:74
if (options.host === '0.0.0.0') {
  program.error('error: --host 0.0.0.0 is intentionally not supported yet for safety: '
    + 'it would expose remote code execution to the network; use 127.0.0.1 instead')
}
```

The rejection is defensive, not a technical limit — `WebServer` accepts exactly
two listen hosts, and all-interfaces is one of them:

```ts
// deepseek-harness/packages/host/webserver/src/index.ts:60
/** Listen host; the two supported values are loopback and all-interfaces. */
host: '127.0.0.1' | '0.0.0.0'
```

The reason it is gated is that an all-interfaces bind **also auto-trusts the whole
LAN**. The web-app derives its trusted authorities from the active interface list:

```ts
// deepseek-harness/packages/bundle/web-app/tests/trusted-hosts.spec.ts
const { trustedHosts } = resolveLanTrust('0.0.0.0', ['harness.internal:3080'])
expect(trustedHosts).toEqual(['192.168.1.5', '10.0.0.7', 'harness.internal:3080'])
```

Those authorities pass the `/api` trust fence. So on a `0.0.0.0` bind, every host
on the LAN is inside the fence, and the agent — which can run code — is reachable
by anything on that network. That is the exposure the guard exists to prevent,
and it is why auth must exist **before** the network bind does.

This package therefore leaves the profile's `webserver.host` at its default
`127.0.0.1`. Do not add a `host: '0.0.0.0'` override to `profile/cordis.patch.yml`
unless the process itself authenticates every request — see
[in-process auth is not available today](#why-auth-is-not-an-in-process-middleware-yet).

## What the proxy must handle

`/api` is one prefix route owned by Connection; everything under it is Typert
Remote. Two transports share the prefix:

| Path | Transport | Notes |
| --- | --- | --- |
| `/api/remote.mux` | **WebSocket** upgrade | the multiplexed Remote stream; heartbeat ping every **2000 ms** by default |
| `/api/...` | HTTP | request/response RPC |

The WebSocket is registered through the upgrade path, not the HTTP route table,
so **a proxy that only forwards HTTP silently breaks the live stream**:

```ts
// deepseek-harness/packages/api/gateway/src/stream-protocol.ts:5
/** Exact WebSocket route carrying every Typert Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
```

Requirements for the proxy:

- Forward `Upgrade` and `Connection` headers on `/api/remote.mux`.
- Keep idle timeouts **longer than 2 s**, or the ping/heartbeat accounting on the
  dsh side will drop the stream. Do not set a short global `proxy_read_timeout`.
- Disable response buffering (relevant to nginx; Caddy streams by default).

### The `/api` trust fence

Both the HTTP route and the WebSocket upgrade pass the same Host/Origin check
before the request reaches the RPC bridge:

```ts
// deepseek-harness/packages/client/connection/src/api-request-trust.ts:91
// Host fence (DNS-rebinding defense), applied to every request
if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
// Origin fence: when a browser attaches an Origin it must be exactly this authority
const origin = header(request.headers, 'origin')
if (origin === undefined) return true
return new URL(origin).host === hostUrl.host
```

Three consequences for the proxy deployment:

1. **The public authority must be declared to dsh.** Browsers send
   `Host: agent.example.com`, which is neither loopback nor trusted by default —
   the request is refused with 403. Pass it at boot:

   ```sh
   dsh --profile server --trusted-host agent.example.com
   ```

   `--trusted-host` takes `host` or `host:port`, is repeatable, and a
   **port-less `host` matches any port** — so one entry covers `:443` and `:8443`.

2. **Do not "fix" this by rewriting `Host` down to loopback.** A browser talking
   to `https://agent.example.com` also sends
   `Origin: https://agent.example.com`. If the proxy rewrites `Host` to
   `127.0.0.1:3080`, the two no longer match and the Origin fence refuses the
   request. Rewriting works only for clients that send no `Origin` at all.
   Declaring the real authority is the supported path for both.

3. **Never let the proxy introduce `sec-fetch-site: cross-site`.** That header is
   refused regardless of `Host` or `Origin`.

## Auth lives in the proxy, per route

The business owns the auth rules; this package only defines where they attach.

A starting matrix, to be replaced with the real policy:

| Route | Auth (business-implemented) |
| --- | --- |
| `/api/remote.mux` (WebSocket) | JWT — the live stream grants session control, so treat it as the highest-privilege route |
| `/api/*` (HTTP RPC) | API key, or JWT for browser callers |
| `/plugins/*`, static assets | session cookie, or deny if the GUI is not served |
| `/` | **deny** — this profile closes the browser GUI; exposing the shell serves nothing useful |

Two ready-to-adapt proxies ship in this package:

- [`proxy/Caddyfile.example`](../proxy/Caddyfile.example) — declarative, with
  per-route auth via `forward_auth` to a verification service you write, plus a
  built-in basic-auth route for internal use.
- [`proxy/auth-proxy.mjs`](../proxy/auth-proxy.mjs) — a small Node reverse proxy
  in front of the same upstream, with an explicit per-route auth table so rules
  can be arbitrary code instead of declarative predicates. It forwards HTTP and
  WebSocket upgrades.

Both keep the client's original `Host` header, which is what makes the fence in
step 1 above work.

## Why auth is not an in-process middleware yet

If you expected to mount auth inside dsh, the seam does not exist today. The
webserver owns one dispatch chain with no user-extensible middleware:

```ts
// deepseek-harness/packages/host/webserver/src/index.ts:242
this.server = createServer((req, res) => {
  if (this.gzip === undefined) next()      // gzip middleware is private
  else this.gzip(req, res, next)
})
// handle(): match(pathname) → route.handler | fallback | 404
```

Its only extension points are `register` (exact/prefix routes, duplicates throw),
`registerUpgrade` (upgrades only), `claimFallback` (one owner, **unclaimed**
requests only), and the index-injection taps. Route matching is exact first, then
**longest prefix wins**:

```ts
if (best === undefined || prefix.length > best.path.length) best = route
```

`/api` is already claimed, so a plugin cannot re-register it (duplicates throw)
and cannot wrap it with a shorter prefix (the longer prefix wins). The design
statement is explicit — *"Route handlers retain direct response ownership."*
Authenticating inside the process would mean either a subclass replacing the
`webserver` row (internals-coupled, upstream-fragile) or an upstream change
adding a request hook. Until then, the proxy **is** the seam.

<a id="the-trap-do-not-mix-the-two"></a>
## The trap: do not mix the two

Binding dsh to `0.0.0.0` **while** authenticating in a proxy is the one
configuration to avoid. The port is then directly reachable and an attacker
simply skips the proxy:

| Configuration | dsh binds | Auth enforced by | Direct-access bypass |
| --- | --- | --- | --- |
| **This package** | `127.0.0.1` | proxy | not reachable ✅ |
| In-process (needs a dsh change) | `0.0.0.0` | dsh middleware | n/a ✅ |
| ❌ Mixed | `0.0.0.0` | proxy | **yes** ⛔ |

## Ops checklist

- [ ] TLS terminated at the proxy; `--trusted-host <public-authority>` matches the
      certificate's name.
- [ ] WebSocket upgrade forwarded on `/api/remote.mux`; timeouts > 2 s.
- [ ] Response buffering off (nginx `proxy_buffering off`) for streaming.
- [ ] Upstream pinned to `127.0.0.1:3080`; verify the port is not reachable from
      the LAN (e.g. `nc -vz <lan-ip> 3080` from another host fails).
- [ ] Rate limiting and request-size caps (`maxBodyBytes` is 300 MiB inside dsh).
- [ ] Auth denials logged with the route and reason, without logging credentials.
- [ ] `dsh` and the proxy supervised together so the proxy never serves a stale
      upstream.

## Verify the fence end to end

```sh
# Trusted authority: reaches the API.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Host: agent.example.com' https://agent.example.com/api/...

# Untrusted authority: the fence refuses it with 403, even with valid proxy auth.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Host: evil.example.com' https://agent.example.com/api/...

# WebSocket handshake must NOT be answered with a plain HTTP error.
curl -sS -i -N \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Host: agent.example.com' \
  'https://agent.example.com/api/remote.mux' | head -1
```

The first must not be 403, the second must be 403, and the third must show a
`101` (or the auth challenge the proxy imposes) rather than a `404`/`502` — a
plain HTTP answer there means the upgrade is not being forwarded.
