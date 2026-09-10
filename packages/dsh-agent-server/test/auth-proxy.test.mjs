/**
 * auth-proxy tests. These cover the behaviour that matters for exposure:
 * fail-closed routing, per-route policies, the original Host reaching dsh, and
 * — the one a hand-rolled proxy usually leaks — auth on the WebSocket upgrade.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const proxyPath = join(pkgRoot, 'proxy', 'auth-proxy.mjs')

/**
 * Whether this environment can run a plain Node child at all.
 *
 * A sandboxed runner can alias `process.execPath` to a wrapper whose nested
 * sandbox initialization is refused; the proxy would never start and the suite
 * would report failures that are not the proxy's. Probe with a trivial exit
 * code instead of trusting the spawn.
 * @returns true when a nested child cannot be trusted to run.
 */
function nestedSpawnBlocked() {
  const probe = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' })
  return probe.status !== 7
}

const skipReason = nestedSpawnBlocked()
  ? 'this environment cannot spawn a nested Node child; run the suite with a plain node'
  : false

const JWT_SECRET = 'test-secret'
const API_KEY = 'test-key'

/** Build an HS256 JWT signed with the test secret. */
function makeJwt(payload, secret = JWT_SECRET) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${signature}`
}

/** Send an HTTP request with full header control (`fetch` forbids overriding Host). */
function httpRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Send a raw WebSocket handshake and resolve with the response head. */
function wsHandshake(port, path, headers = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        'Host: agent.example.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '', '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let buffer = ''
    const finish = () => {
      socket.destroy()
      resolve(buffer)
    }
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\r\n')) finish()
    })
    socket.on('error', finish)
    socket.setTimeout(3000, finish)
  })
}

describe('auth-proxy', { skip: skipReason }, () => {
  let upstream
  let proxy
  let proxyPort
  let upstreamPort
  /** Host headers seen by the upstream HTTP handler. */
  const seenHosts = []
  /** Host headers seen on upstream upgrade attempts. */
  let upgradeAttempts = 0

  before(async () => {
    upstream = http.createServer((req, res) => {
      seenHosts.push(req.headers.host)
      const body = JSON.stringify({ host: req.headers.host, path: req.url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
    upstream.on('upgrade', (req, socket) => {
      upgradeAttempts += 1
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: dummy\r\n\r\n',
      )
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port

    proxy = spawn(process.execPath, [proxyPath], {
      env: {
        ...process.env,
        BIND_HOST: '127.0.0.1',
        BIND_PORT: '0',
        UPSTREAM_HOST: '127.0.0.1',
        UPSTREAM_PORT: String(upstreamPort),
        JWT_SECRET,
        API_KEYS: API_KEY,
      },
    })
    proxyPort = await new Promise((resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => reject(new Error(`proxy did not start: ${out}`)), 10_000)
      proxy.stdout.on('data', (chunk) => {
        out += chunk.toString()
        const match = out.match(/port=(\d+)/)
        if (match !== null) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
      proxy.on('error', reject)
    })
  })

  after(() => {
    proxy?.kill()
    upstream?.close()
  })

  const url = (path) => `http://127.0.0.1:${proxyPort}${path}`

  it('denies an /api request with no credentials', async () => {
    const res = await fetch(url('/api/session'))
    assert.equal(res.status, 401)
  })

  it('denies an /api request with a wrong API key', async () => {
    const res = await fetch(url('/api/session'), { headers: { 'x-api-key': 'wrong' } })
    assert.ok(res.status === 401 || res.status === 403, `expected denial, got ${res.status}`)
  })

  it('allows a valid API key, and dsh sees the caller Host', async () => {
    seenHosts.length = 0
    const res = await httpRequest(proxyPort, '/api/session', {
      'x-api-key': API_KEY,
      host: 'agent.example.com',
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    // Rewriting Host to loopback would break the dsh trust fence.
    assert.equal(body.host, 'agent.example.com')
    assert.deepEqual(seenHosts, ['agent.example.com'])
  })

  it('allows a valid JWT on the api-rpc route', async () => {
    const token = makeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 })
    const res = await fetch(url('/api/session'), { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
  })

  it('rejects an expired JWT', async () => {
    const token = makeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 60 })
    const res = await fetch(url('/api/session'), { headers: { authorization: `Bearer ${token}` } })
    assert.ok(res.status === 401 || res.status === 403)
  })

  it('denies the browser shell', async () => {
    const res = await fetch(url('/'))
    assert.equal(res.status, 403)
  })

  it('fails closed on an unmatched path', async () => {
    const res = await fetch(url('/nope'))
    assert.equal(res.status, 403)
  })

  it('requires a session for plugin assets', async () => {
    assert.equal((await fetch(url('/plugins/x/client.js'))).status, 401)
  })

  it('refuses an unauthenticated WebSocket upgrade WITHOUT touching the upstream', async () => {
    const before = upgradeAttempts
    const response = await wsHandshake(proxyPort, '/api/remote.mux')
    assert.match(response.split('\r\n')[0], /401|403/)
    assert.equal(upgradeAttempts, before, 'upstream must never see an unauthenticated upgrade')
  })

  it('forwards an authenticated WebSocket upgrade', async () => {
    const token = makeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 })
    const response = await wsHandshake(proxyPort, '/api/remote.mux', {
      Authorization: `Bearer ${token}`,
    })
    assert.match(response.split('\r\n')[0], /101/)
  })
})
