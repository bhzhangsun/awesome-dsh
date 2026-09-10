import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Route prefix the /media handler is registered under. Deliberately WITHOUT a
 * trailing slash: the host webserver's longest-prefix matcher only treats a
 * registered prefix `P` as owning `P` and `P/<anything>` (`pathname !== P &&
 * !pathname.startsWith(P + '/')` skips it). Registering `/media/` (with the
 * slash) therefore never matches `/media/<token>` — requests fall through to the
 * SPA fallback and 404, and the audio/video bar cannot play.
 */
const MEDIA_PREFIX = '/media'
/** `MEDIA_PREFIX` with its trailing slash, used to build the URL and strip the token from a pathname. */
const MEDIA_URL_PREFIX = `${MEDIA_PREFIX}/`

/** Extension → media MIME, so the browser picks the right player/codec. */
const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}

/** token → absolute file path, so url tokens never expose the real pathname. */
const served = new Map<string, string>()
/** token → insertion time (ms), for bounded eviction. */
const servedAt = new Map<string, number>()
const TOKEN_TTL_MS = 60 * 60 * 1000 // 1h
const MAX_TOKENS = 1024

function pruneServed(now: number): void {
  for (const [token, at] of servedAt) {
    if (now - at > TOKEN_TTL_MS) {
      served.delete(token)
      servedAt.delete(token)
    }
  }
  while (served.size > MAX_TOKENS) {
    const oldest = servedAt.keys().next().value
    if (oldest === undefined) break
    served.delete(oldest)
    servedAt.delete(oldest)
  }
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function baseHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '::1' ? '127.0.0.1' : host
}

/**
 * Resolve a user-supplied local media reference to an existing file.
 *
 * Accepts an absolute path, a path relative to the session workspace (`cwd`), or
 * a `file://` URL. The agent calls `media_render` for files it already has access
 * to, and URLs are only ever minted for files the tool explicitly serves, so the
 * /media/<token> endpoint can serve the resolved file regardless of whether it
 * sits inside the workspace. Returns the absolute path, or `null` when the
 * reference is not a resolvable, existing regular file.
 */
export function resolveMediaFile(cwd: string | undefined, ref: string): string | null {
  let raw = ref
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname)
    } catch {
      raw = raw.slice('file://'.length)
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // A non-file scheme (data:, blob:, …) — not a local file.
    return null
  }
  let abs: string
  if (isAbsolute(raw)) {
    abs = resolve(raw)
  } else if (cwd !== undefined) {
    abs = resolve(cwd, raw)
  } else {
    return null // relative reference without a workspace base
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) return null
  return abs
}

/** Register the `/media/<token>` static route on the host webserver. */
export function registerMediaRoute(ctx: Context): () => void {
  ctx.logger.info('[dsh-media] registering /media file route')
  return ctx.webServer.register({ kind: 'prefix', path: MEDIA_PREFIX, handler: serveMedia })
}

/**
 * Publish an absolute media file as a browser-reachable http URL. Returns
 * `undefined` when the host webserver is not yet listening (no port), in which
 * case the caller should reject or fall back to a plain text link.
 */
export function publishMediaUrl(ctx: Context, absPath: string): string | undefined {
  const now = Date.now()
  pruneServed(now)
  const token = randomBytes(12).toString('hex')
  served.set(token, absPath)
  servedAt.set(token, now)
  ctx.logger.info(`[dsh-media] serving ${absPath} as /media/${token}`)
  const { host, port } = ctx.webServer
  if (port === undefined || host === undefined) {
    ctx.logger.warn('[dsh-media] webServer not listening; cannot publish a media URL')
    return undefined
  }
  return `http://${baseHost(host)}:${port}${MEDIA_URL_PREFIX}${token}`
}

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

/** Serve one token-mapped file, honouring `Range` for media seeking. */
function serveMedia(req: IncomingMessage, res: ServerResponse): void {
  let pathname = ''
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    sendText(res, 400, 'bad request')
    return
  }
  const token = pathname.slice(MEDIA_URL_PREFIX.length).replace(/\/+$/, '')
  const absPath = served.get(token)
  if (absPath === undefined || !existsSync(absPath)) {
    sendText(res, 404, 'not found')
    return
  }
  const stat = statSync(absPath)
  const type = mimeFor(absPath)
  const range = req.headers.range

  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    let start: number
    let end: number
    if (match === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }
    start = match[1] === '' ? Math.max(0, stat.size - Number(match[2])) : Number(match[1])
    end = match[2] === '' || match[2] === undefined ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1)
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    })
    createReadStream(absPath, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size,
  })
  createReadStream(absPath).pipe(res)
}
