import { zstdDecompressSync } from 'node:zlib'

/**
 * Recovery of `media_render` calls from a persisted session log.
 *
 * Before the token map was persisted, every render minted a token that died with
 * the process, so the players in older replies pointed at a `/media/<token>` that
 * no longer resolved. The log still holds everything needed to rebuild those
 * mappings: the tool call carries the file reference the tool was given, and the
 * tool result carries the token URL it minted. Pairing them revives a reply's
 * player without the file being rendered again.
 *
 * A session log is JSONL **appended in zstd frames** — one frame per flush, so a
 * long session is thousands of frames in one file. Decompressing the file as a
 * single stream returns only the first frame (just the session header), which is
 * why the reader walks the frame magic itself.
 */

/** zstd frame magic (little-endian 0xFD2FB528): every flush starts a new frame. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** `/media/<token>` at the end of a published URL, with any query/fragment removed. */
const MEDIA_PATH_RE = /\/media\/([A-Za-z0-9_-]+)(?:[?#].*)?$/

export interface RecoveredMedia {
  /** The token the reply's URL carries, minted by whichever process rendered it. */
  token: string
  /** The reference the tool was called with — usually relative to the session cwd. */
  ref: string
}

export interface SessionLogMedia {
  /** The session workspace, from the log's header event; `undefined` when absent. */
  cwd: string | undefined
  recovered: RecoveredMedia[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Offsets of every zstd frame in the log, in order. */
function frameOffsets(buf: Buffer): number[] {
  const offsets: number[] = []
  let at = buf.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  return offsets
}

/** Every line of the log, across every frame. Corrupt frames are skipped. */
function* logLines(buf: Buffer): Generator<string> {
  const offsets = frameOffsets(buf)
  for (let i = 0; i < offsets.length; i += 1) {
    const frame = buf.subarray(offsets[i], offsets[i + 1] ?? buf.length)
    let text: string
    try {
      text = zstdDecompressSync(frame).toString('utf8')
    } catch {
      continue // a truncated tail frame: the rest of the log is still readable
    }
    for (const line of text.split('\n')) if (line !== '') yield line
  }
}

/** The token in a published media URL, or `undefined` for any other URL. */
export function mediaTokenOf(url: string): string | undefined {
  return MEDIA_PATH_RE.exec(url)?.[1]
}

/** The stored tool-call arguments: a JSON string in the log, an object in tests. */
function callArguments(value: unknown): Record<string, unknown> | undefined {
  const args = typeof value === 'string' ? asRecord(parseJson(value)) : asRecord(value)
  return args
}

function itemUrls(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items.map((item) => {
    const url = asRecord(item)?.url
    return typeof url === 'string' ? url : ''
  })
}

/** `- audio: <url> (title)` lines of the tool result text, used when meta is absent. */
function textUrls(text: string): string[] {
  const urls: string[] = []
  for (const line of text.split('\n')) {
    const url = /^\s*-\s*\w+:\s*(\S+)/.exec(line)?.[1]
    if (url !== undefined) urls.push(url)
  }
  return urls
}

function resultUrls(data: Record<string, unknown>, message: Record<string, unknown> | undefined): string[] {
  const media = itemUrls(asRecord(data.meta)?.dshMedia)
  if (media.length > 0) return media
  const content = message?.content
  if (!Array.isArray(content)) return []
  const urls: string[] = []
  for (const part of content) {
    const inner = asRecord(part)?.content
    if (!Array.isArray(inner)) continue
    for (const chunk of inner) {
      const text = asRecord(chunk)?.text
      if (typeof text === 'string') urls.push(...textUrls(text))
    }
  }
  return urls
}

/**
 * Read one session log and return every `media_render` file it can still serve.
 *
 * Only lines that could matter are parsed: the log of a busy session holds
 * hundreds of thousands of events, and recovery must stay cheap enough to run in
 * the background at startup.
 */
export function readSessionLog(buf: Buffer): SessionLogMedia {
  let cwd: string | undefined
  /** callId → the references the tool was called with, in item order. */
  const calls = new Map<string, string[]>()
  /** callId → the URLs the tool returned, in item order. */
  const results = new Map<string, string[]>()

  for (const line of logLines(buf)) {
    // A busy session logs hundreds of thousands of events; parse only the ones
    // that can carry a render (the tool's own arguments, and any tool result —
    // the result's meta is not guaranteed to be there).
    if (!line.includes('"type":"tool/result"') && !line.includes('media_render') && !(cwd === undefined && line.includes('"type":"session"'))) {
      continue
    }
    const event = asRecord(parseJson(line))
    if (event === undefined) continue

    if (event.type === 'session' && cwd === undefined && typeof event.cwd === 'string') {
      cwd = event.cwd
      continue
    }
    const data = asRecord(event.data)
    if (data === undefined) continue

    if (event.type === 'tool/call') {
      if (data.name !== 'media_render' || typeof data.callId !== 'string') continue
      calls.set(data.callId, itemUrls(callArguments(data.arguments)?.items))
      continue
    }

    if (event.type === 'tool/result') {
      const message = asRecord(data.message)
      const callId = asRecord(message?.source)?.callId
      // Only results of a call this log still holds can be paired with a file.
      if (typeof callId !== 'string' || !calls.has(callId)) continue
      results.set(callId, resultUrls(data, message))
    }
  }

  const recovered: RecoveredMedia[] = []
  for (const [callId, refs] of calls) {
    const urls = results.get(callId)
    if (urls === undefined) continue
    for (let i = 0; i < refs.length && i < urls.length; i += 1) {
      const ref = refs[i]
      const published = urls[i]
      // A remote reference was passed through, not published: nothing to recover.
      if (ref === undefined || ref === '' || published === undefined) continue
      const token = mediaTokenOf(published)
      if (token === undefined || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) continue
      recovered.push({ token, ref })
    }
  }
  return { cwd, recovered }
}
