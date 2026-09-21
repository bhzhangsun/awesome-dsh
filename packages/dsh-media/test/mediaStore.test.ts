import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MediaTokenStore, defaultStorePath } from '../src/mediaStore.js'
import { publishMediaUrl, registerMediaRoute } from '../src/mediaServer.js'

/**
 * The bug these cover: a `dsh-media` fence is persisted text, so its URL is
 * requested again after the host restarts (and after every client reload). A
 * memory-only token map turned every older reply's player into a 404 — a bar at
 * 0:00 and a black video frame.
 */

const root = mkdtempSync(join(tmpdir(), 'dsh-media-store-'))
const clipPath = join(root, 'clip.mp3')
writeFileSync(clipPath, 'ID3-fake-audio-bytes')

/** A fresh store over one file, i.e. the state a process starts with. */
function storeAt(file: string): MediaTokenStore {
  return new MediaTokenStore(file)
}

function newStoreFile(name: string): string {
  return join(root, name)
}

/** Minimal ServerResponse: collects what the route writes. */
function fakeResponse() {
  const chunks: Buffer[] = []
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & { statusCode?: number; headers: Record<string, string> }
  res.headers = {}
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status
    Object.assign(res.headers, headers ?? {})
    return res
  }
  const finished = new Promise<void>((resolve) => res.on('finish', () => resolve()))
  return { res, finished, body: () => Buffer.concat(chunks).toString() }
}

/** Drive the real `/media/<token>` handler for one request. */
async function request(url: string): Promise<{ status: number | undefined; headers: Record<string, string>; body: string }> {
  let handler: ((req: unknown, res: unknown) => void) | undefined
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: {
      register: (route: { handler: (req: unknown, res: unknown) => void }) => {
        handler = route.handler
        return () => {}
      },
    },
  } as unknown as Parameters<typeof registerMediaRoute>[0]
  registerMediaRoute(ctx)
  const { res, finished, body } = fakeResponse()
  // The handler is async: an unknown token first tries to recover it from session
  // history, so the response may only be produced after that pass.
  await handler?.({ method: 'GET', url, headers: {} }, res)
  await finished
  return { status: res.statusCode, headers: res.headers, body: body() }
}

beforeEach(() => {
  process.env.DSH_HOME = root
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('MediaTokenStore', () => {
  it('serves a token minted by an earlier process (the restart case)', async () => {
    const file = newStoreFile('restart.json')
    const token = storeAt(file).mint(clipPath)
    process.env.DSH_HOME = root

    // Restart: nothing carried over but the file on disk.
    const after = storeAt(file)
    expect(after.resolve(token)).toBe(clipPath)
  })

  it('serves the persisted url through the real /media route after a restart', async () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: { host: '127.0.0.1', port: 8080 },
    } as unknown as Parameters<typeof publishMediaUrl>[0]
    const url = publishMediaUrl(ctx, clipPath) ?? ''
    const token = url.split('/').pop() ?? ''

    // The next process only sees the store file: it must resolve the same token.
    expect(storeAt(defaultStorePath()).resolve(token)).toBe(clipPath)
    const served = await request(`/media/${token}`)
    expect(served.status).toBe(200)
    expect(served.body).toBe('ID3-fake-audio-bytes')
  })

  it('404s an unknown token', async () => {
    const served = await request('/media/deadbeefdeadbeefdeadbeef')
    expect(served.status).toBe(404)
  })

  it('writes the map to disk as soon as a token is minted', () => {
    const file = newStoreFile('written.json')
    const token = storeAt(file).mint(clipPath)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { version: number; files: Record<string, { path: string }> }
    expect(persisted.version).toBe(1)
    expect(persisted.files[token]?.path).toBe(clipPath)
  })

  it('reuses the token of a file it already published', () => {
    const file = newStoreFile('reuse.json')
    const store = storeAt(file)
    expect(store.mint(clipPath)).toBe(store.mint(clipPath))
  })

  it('keeps a token alive with no expiry (an old reply still plays)', () => {
    const file = newStoreFile('no-ttl.json')
    const token = storeAt(file).mint(clipPath)
    // The old implementation expired tokens after an hour; a fence older than
    // that broke without any restart at all.
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { files: Record<string, { at: number }> }
    expect(persisted.files[token]).toBeDefined()
    expect(storeAt(file).resolve(token)).toBe(clipPath)
  })

  it('forgets a token whose file is gone, and drops it from disk', () => {
    const file = newStoreFile('gone.json')
    const store = storeAt(file)
    const token = store.mint(clipPath)
    const copy = join(root, 'doomed.mp3')
    writeFileSync(copy, 'x')
    const doomed = store.mint(copy)
    unlinkSync(copy)

    expect(store.resolve(doomed)).toBeUndefined()
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { files: Record<string, unknown> }
    expect(persisted.files[doomed]).toBeUndefined()
    expect(persisted.files[token]).toBeDefined()
  })

  it('drops missing files when it loads the map', () => {
    const file = newStoreFile('stale.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      files: {
        dead: { path: join(root, 'never-existed.mp3'), at: 1 },
        live: { path: clipPath, at: 2 },
      },
    }))
    const store = storeAt(file)
    expect(store.resolve('dead')).toBeUndefined()
    expect(store.resolve('live')).toBe(clipPath)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(persisted.files)).toEqual(['live'])
  })

  it('starts empty instead of throwing on a corrupt store file', () => {
    const file = newStoreFile('corrupt.json')
    writeFileSync(file, '{ not json')
    const store = storeAt(file)
    expect(store.size).toBe(0)
    expect(() => store.mint(clipPath)).not.toThrow()
    expect(store.size).toBe(1)
  })

  it('does not resolve an unknown token', () => {
    expect(storeAt(newStoreFile('unknown.json')).resolve('deadbeefdeadbeefdeadbeef')).toBeUndefined()
  })

  it('shares one store file with another process (no last-writer-wins loss)', () => {
    const file = newStoreFile('shared.json')
    const first = storeAt(file)
    const second = storeAt(file)
    const a = first.mint(clipPath)
    const other = join(root, 'second.mp3')
    writeFileSync(other, 'y')
    const b = second.mint(other)

    // Both wrote the same file; neither entry may be lost, and each process can
    // serve the other's token.
    expect(storeAt(file).resolve(a)).toBe(clipPath)
    expect(storeAt(file).resolve(b)).toBe(other)
    expect(first.resolve(b)).toBe(other)
    expect(second.resolve(a)).toBe(clipPath)
  })

  it('resolves DSH_HOME for the default store path', () => {
    expect(defaultStorePath()).toBe(join(root, 'storages', 'dsh-media', 'served.json'))
  })
})

describe('publishMediaUrl across a restart', () => {
  it('returns the same absolute url for a file it has already published', async () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: { host: '127.0.0.1', port: 8080 },
    } as unknown as Parameters<typeof publishMediaUrl>[0]
    const first = publishMediaUrl(ctx, clipPath)
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:8080\/media\/[0-9a-f]{24}$/)
    expect(publishMediaUrl(ctx, clipPath)).toBe(first)
    const token = (first ?? '').split('/').pop() ?? ''
    expect(storeAt(defaultStorePath()).resolve(token)).toBe(clipPath)
    expect((await request(`/media/${token}`)).status).toBe(200)
  })
})
