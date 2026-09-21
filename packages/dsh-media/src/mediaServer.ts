import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MediaHistoryHealer } from './historyHeal.js'
import { mediaTokenStore } from './mediaStore.js'

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

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function baseHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '::1' ? '127.0.0.1' : host
}

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
  mediaHistoryHealer(ctx)
  return ctx.webServer.register({ kind: 'prefix', path: MEDIA_PREFIX, handler: serveMedia })
}

let healer: MediaHistoryHealer | undefined

/**
 * The process-wide history healer (see {@link MediaHistoryHealer}), wired to the
 * tool's own local-file resolution so a recovered reference is checked the same
 * way a fresh `media_render` call would be.
 */
function mediaHistoryHealer(ctx: Context): MediaHistoryHealer {
  healer ??= new MediaHistoryHealer({
    store: mediaTokenStore(),
    resolve: (cwd, ref) => resolveMediaFile(cwd, ref) ?? undefined,
    logger: ctx.logger,
  })
  return healer
}

/**
 * Start the background recovery pass that revives media URLs in *older* replies.
 * The fiber owns it: disposing the plugin aborts the pass.
 */
export function startMediaHistoryHeal(ctx: Context): void {
  const abort = new AbortController()
  ctx.effect(
    () => () => abort.abort(),
    'dsh-media: session-history recovery',
  )
  void mediaHistoryHealer(ctx).heal(abort.signal).catch((error: unknown) => {
    ctx.logger.warn(`[dsh-media] session-history recovery failed: ${String(error)}`)
  })
}

/**
 * Publish an absolute media file as a browser-reachable http URL. Returns
 * `undefined` when the host webserver is not yet listening (no port), in which
 * case the caller should reject or fall back to a plain text link.
 *
 * The token is persisted (see {@link mediaTokenStore}), because the URL ends up
 * in the transcript and has to keep resolving after a restart — a client reload
 * alone already re-requests it. Re-publishing an already-published file reuses
 * its token, so a reply and a later re-render share one URL.
 */
export function publishMediaUrl(ctx: Context, absPath: string): string | undefined {
  const { host, port } = ctx.webServer
  if (port === undefined || host === undefined) {
    ctx.logger.warn('[dsh-media] webServer not listening; cannot publish a media URL')
    return undefined
  }
  const token = mediaTokenStore().mint(absPath)
  ctx.logger.info(`[dsh-media] serving ${absPath} as /media/${token}`)
  return `http://${baseHost(host)}:${port}${MEDIA_URL_PREFIX}${token}`
}

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

/** Serve one token-mapped file, honouring `Range` for media seeking. */
async function serveMedia(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let pathname = ''
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    sendText(res, 400, 'bad request')
    return
  }
  const token = pathname.slice(MEDIA_URL_PREFIX.length).replace(/\/+$/, '')
  const store = mediaTokenStore()
  let absPath = store.resolve(token)
  if (absPath === undefined && healer !== undefined) {
    // The URL predates this process: the reply it belongs to is in a session log,
    // which still records which file the token was minted for. Recover it and serve
    // this very request, so an old reply plays without being rendered again.
    await healer.healToken(token)
    absPath = store.resolve(token)
  }
  if (absPath === undefined) {
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
