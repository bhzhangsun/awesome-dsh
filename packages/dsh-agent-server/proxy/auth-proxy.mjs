#!/usr/bin/env node
/**
 * auth-proxy.mjs — reference reverse proxy for @bhzhangsun/dsh-agent-server.
 *
 * Topology: this proxy binds the network and enforces auth; dsh stays on
 * loopback. It exists because dsh's webserver exposes no middleware seam, so a
 * process in front is the place to authenticate (see ../docs/NETWORK-AND-AUTH.md).
 *
 *   client ──TLS+auth──► this proxy ──plain HTTP──► dsh 127.0.0.1:3080
 *
 * What it does:
 *   - Forwards HTTP under /api and WebSocket upgrades on /api/remote.mux.
 *   - Keeps the caller's original Host header, which the dsh /api trust fence
 *     checks. Rewriting Host to loopback would break browser requests.
 *   - Selects an auth policy PER ROUTE from ROUTES below.
 *   - **Fails closed**: a path matching no route is denied.
 *
 * TLS is expected to terminate here in production; the reference listens on
 * plain HTTP so it stays dependency-free. Put TLS in front, or add node:https.
 *
 * Environment:
 *   BIND_HOST      default 0.0.0.0
 *   BIND_PORT      default 8443
 *   UPSTREAM_HOST  default 127.0.0.1
 *   UPSTREAM_PORT  default 3080
 *   JWT_SECRET     HS256 secret for the JWT policy (required if you keep it)
 *   API_KEYS       comma-separated accepted API keys (required if you keep it)
 *
 * dsh must be started with the public authority declared, or its fence 403s:
 *   dsh --profile server --trusted-host agent.example.com
 *
 * This is a REFERENCE, not a hardened edge. Add rate limiting, request-size
 * caps, structured auth logging, and TLS before facing the internet.
 */
import http from 'node:http'
import net from 'node:net'
import { createHmac, timingSafeEqual } from 'node:crypto'

const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0'
const BIND_PORT = Number(process.env.BIND_PORT ?? 8443)
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 3080)
const JWT_SECRET = process.env.JWT_SECRET ?? ''
const API_KEYS = (process.env.API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)

/** Constant-time string compare that never throws on length mismatch. */
function secretEquals(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Verify an HS256 JWT and return its payload, or undefined when invalid.
 * Replace with your own issuer/JWKS verification for asymmetric keys.
 */
function verifyJwtHs256(token) {
  const parts = token.split('.')
  if (parts.length !== 3 || JWT_SECRET === '') return undefined
  const [head, body, signature] = parts
  const expected = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest()
  const presented = Buffer.from(signature, 'base64url')
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return undefined
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return undefined
  return payload
}

const allow = (subject) => ({ ok: true, subject })
const denyWith = (status, reason) => ({ ok: false, status, reason })

function bearer(req) {
  const value = req.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined
  return value.slice('Bearer '.length)
}

/** Policy: a valid bearer JWT is required. */
function requireJwt(req) {
  const token = bearer(req)
  if (token === undefined) return denyWith(401, 'missing bearer token')
  const payload = verifyJwtHs256(token)
  if (payload === undefined) return denyWith(403, 'invalid or expired token')
  return allow(typeof payload.sub === 'string' ? payload.sub : 'jwt')
}

/** Policy: an accepted API key, or a valid JWT for browser callers. */
function requireApiKeyOrJwt(req) {
  const key = req.headers['x-api-key']
  if (typeof key === 'string' && API_KEYS.some((candidate) => secretEquals(candidate, key))) {
    return allow('api-key')
  }
  return requireJwt(req)
}

/** Policy: a session cookie issued by the business. */
function requireSession(req) {
  const cookie = req.headers.cookie
  if (typeof cookie !== 'string' || !cookie.includes('dsh_session=')) {
    return denyWith(401, 'missing session cookie')
  }
  // Replace with a real session lookup.
  return allow('session')
}

/**
 * The per-route auth table: first match wins, and no match means DENY.
 * This is the "different auth per interface" knob — reorder, replace, or add
 * rules freely; the proxy does not care what a policy checks.
 */
const ROUTES = [
  {
    name: 'remote-mux',
    // The live stream drives the session: treat it as highest privilege.
    match: (pathname) => pathname === '/api/remote.mux',
    authenticate: requireJwt,
  },
  {
    name: 'api-rpc',
    match: (pathname) => pathname.startsWith('/api/'),
    authenticate: requireApiKeyOrJwt,
  },
  {
    name: 'plugin-assets',
    match: (pathname) => pathname.startsWith('/plugins/'),
    authenticate: requireSession,
  },
  // The browser shell is closed on the `server` profile; deny it explicitly
  // rather than relying on the fail-closed default, so the intent is visible.
  { name: 'shell', match: (pathname) => pathname === '/', authenticate: () => denyWith(403, 'GUI disabled') },
]

/** Resolve the route and run its policy. Never throws. */
async function authorize(req, pathname) {
  const route = ROUTES.find((candidate) => candidate.match(pathname))
  if (route === undefined) return { ok: false, status: 403, reason: 'no route matches' }
  try {
    const decision = await route.authenticate(req)
    if (!decision.ok) return { ...decision, route: route.name }
    return { ...decision, route: route.name }
  } catch (error) {
    // A failing policy must never become an allow.
    return { ok: false, status: 403, reason: `policy error: ${error.message}`, route: route.name }
  }
}

/** Send an HTTP refusal and end the response. */
function refuse(res, decision) {
  const body = JSON.stringify({ error: decision.reason, route: decision.route })
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
  if (decision.status === 401) headers['www-authenticate'] = 'Bearer realm="dsh-agent-server"'
  res.writeHead(decision.status, headers)
  res.end(body)
}

function log(req, decision) {
  const route = decision.route ?? '-'
  const outcome = decision.ok ? 'allow' : `deny ${decision.status} ${decision.reason}`
  console.log(`${req.method ?? 'UPGRADE'} ${req.url ?? '-'} [${route}] ${outcome}`)
}

const server = http.createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname
    const decision = await authorize(req, pathname)
    log(req, decision)
    if (!decision.ok) {
      refuse(res, decision)
      return
    }

    // `headers: req.headers` preserves Host — required by the dsh trust fence.
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`upstream error: ${error.message}`)
    })
    req.pipe(upstream)
  })()
})

// WebSocket upgrades bypass the request handler, so they need their own auth
// check. Without this, /api/remote.mux would be reachable unauthenticated.
server.on('upgrade', (req, socket, head) => {
  void (async () => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname
    const decision = await authorize(req, pathname)
    log(req, decision)
    if (!decision.ok) {
      socket.write(
        `HTTP/1.1 ${decision.status} ${decision.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n`
        + 'Connection: close\r\n'
        + `Content-Length: 0\r\n`
        + (decision.status === 401 ? 'WWW-Authenticate: Bearer realm="dsh-agent-server"\r\n' : '')
        + '\r\n',
      )
      socket.destroy()
      return
    }

    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      // Rebuild the handshake verbatim so Host, Upgrade, and Sec-WebSocket-*
      // reach dsh unchanged.
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
        else if (value !== undefined) lines.push(`${name}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head !== undefined && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })()
})

// Streaming RPC and WebSocket traffic outlive the default request timeout.
server.requestTimeout = 0
server.headersTimeout = 60_000
server.keepAliveTimeout = 120_000

server.listen(BIND_PORT, BIND_HOST, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : BIND_PORT
  // `port=<n>` is the line a supervisor (or the test suite) waits for.
  console.log(`[auth-proxy] listening on http://${BIND_HOST}:${port} port=${port}`)
  console.log(`[auth-proxy] forwarding to http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`)
  console.log(`[auth-proxy] routes: ${ROUTES.map((route) => route.name).join(', ')} (default: deny)`)
  if (JWT_SECRET === '') console.warn('[auth-proxy] JWT_SECRET unset — the JWT policy denies everything')
  if (API_KEYS.length === 0) console.warn('[auth-proxy] API_KEYS unset — the API-key policy denies everything')
})
