import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mediaRenderResult, normalizeMediaItems } from '../src/projection.js'
import { isHttpUrl } from '../src/shared/schema.js'
import { publishMediaUrl, registerMediaRoute, resolveMediaFile } from '../src/mediaServer.js'

describe('normalizeMediaItems', () => {
  it('narrows and validates canonical audio/video items', () => {
    const raw = [
      { kind: 'audio', url: 'https://example.com/a.mp3' },
      { kind: 'video', url: 'https://example.com/v.mp4', poster: 'https://example.com/p.jpg', title: 'Demo' },
    ]
    const items = normalizeMediaItems(raw)
    expect(items).toHaveLength(2)
    expect(items[0]!.kind).toBe('audio')
    expect(items[1]!.poster).toBe('https://example.com/p.jpg')
  })

  it('accepts http(s), local paths and file:// URLs (resolved later by the host)', () => {
    expect((normalizeMediaItems([{ kind: 'audio', url: 'https://e.com/a.mp3' }]))[0]!.url).toBe('https://e.com/a.mp3')
    expect((normalizeMediaItems([{ kind: 'audio', url: 'refs/clip.mp3' }]))[0]!.url).toBe('refs/clip.mp3')
    expect((normalizeMediaItems([{ kind: 'audio', url: 'file:///tmp/clip.mp3' }]))[0]!.url).toBe('file:///tmp/clip.mp3')
  })

  it('rejects an empty url', () => {
    expect(() => normalizeMediaItems([{ kind: 'audio', url: '' }])).toThrow(/must not be empty/)
  })

  it('rejects empty input gracefully', () => {
    expect(normalizeMediaItems([])).toEqual([])
    expect(normalizeMediaItems(undefined)).toEqual([])
  })
})

describe('isHttpUrl', () => {
  it('accepts absolute http(s) only', () => {
    expect(isHttpUrl('https://e.com/a.mp3')).toBe(true)
    expect(isHttpUrl('http://e.com/a.mp3')).toBe(true)
    expect(isHttpUrl('file:///tmp/a.mp3')).toBe(false)
    expect(isHttpUrl('refs/a.mp3')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('resolveMediaFile', () => {
  let cwd: string

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'dsh-media-'))
  })
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('resolves an absolute path', () => {
    const file = join(cwd, 'clip.mp3')
    writeFileSync(file, 'x')
    expect(resolveMediaFile(cwd, file)).toBe(resolve(file))
  })

  it('resolves a cwd-relative path', () => {
    const refsDir = join(cwd, 'refs')
    mkdirSync(refsDir, { recursive: true })
    const file = join(refsDir, 'demo.mp4')
    writeFileSync(file, 'x')
    expect(resolveMediaFile(cwd, 'refs/demo.mp4')).toBe(resolve(file))
  })

  it('resolves a ../ path that lands outside the workspace (user file)', () => {
    const outside = resolve(tmpdir(), `dsh-media-outside-${Math.random().toString(36).slice(2)}.m4a`)
    writeFileSync(outside, 'x')
    try {
      expect(resolveMediaFile(cwd, `../${basename(outside)}`)).toBe(outside)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('resolves a file:// URL', () => {
    const file = join(cwd, 'v.mp4')
    writeFileSync(file, 'x')
    expect(resolveMediaFile(cwd, `file://${file}`)).toBe(resolve(file))
  })

  it('rejects nonexistent or non-file references', () => {
    expect(resolveMediaFile(cwd, './does-not-exist.mp3')).toBeNull()
    expect(resolveMediaFile(cwd, 'refs/no.mp4')).toBeNull()
  })

  it('rejects relative references when there is no cwd', () => {
    expect(resolveMediaFile(undefined, 'clip.mp3')).toBeNull()
  })
})

describe('publishMediaUrl', () => {
  function ctxOf(host: string, port: number | undefined) {
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    return { webServer: { host, port }, logger } as unknown as Parameters<typeof publishMediaUrl>[0]
  }

  it('mints an http://127.0.0.1:<port>/media/<token> url', () => {
    const url = publishMediaUrl(ctxOf('127.0.0.1', 8080), '/tmp/a.mp3')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8080\/media\/[0-9a-f]+$/)
  })

  it('maps a 0.0.0.0 bind to 127.0.0.1', () => {
    const url = publishMediaUrl(ctxOf('0.0.0.0', 9090), '/tmp/a.mp3')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:9090\/media\/[0-9a-f]+$/)
  })

  it('returns undefined when the server is not yet listening', () => {
    expect(publishMediaUrl(ctxOf('127.0.0.1', undefined), '/tmp/a.mp3')).toBeUndefined()
  })
})

describe('registerMediaRoute', () => {
  it('registers the /media route WITHOUT a trailing slash so the webserver prefix matcher owns /media/<token>', () => {
    let captured: { kind: string; path: string } | undefined
    const ctx = {
      logger: { info: () => {} },
      webServer: {
        register: (route: { kind: string; path: string }) => {
          captured = route
          return () => {}
        },
      },
    } as unknown as Parameters<typeof registerMediaRoute>[0]

    registerMediaRoute(ctx)
    expect(captured?.kind).toBe('prefix')
    expect(captured?.path).toBe('/media')

    // Reproduce the host webserver's longest-prefix matcher against the
    // registered path: `/media` owns both itself and `/media/<token>`; a
    // trailing-slash path (`/media/`) never would.
    const match = (pathname: string) => {
      const prefix = captured!.path
      return pathname === prefix || pathname.startsWith(`${prefix}/`)
    }
    expect(match('/media/a3cb925b690f749e946be481')).toBe(true)
    expect(match('/media')).toBe(true)
    expect(match('/media/')).toBe(true)
    expect(match('/media-other')).toBe(false)
  })
})

describe('mediaRenderResult', () => {
  it('counts by kind', () => {
    const items = [
      { kind: 'audio', url: 'https://e.com/a.mp3' },
      { kind: 'video', url: 'https://e.com/v.mp4' },
      { kind: 'audio', url: 'https://e.com/b.mp3' },
    ] as const
    const result = mediaRenderResult([...items])
    expect(result.counts.audio).toBe(2)
    expect(result.counts.video).toBe(1)
  })
})
