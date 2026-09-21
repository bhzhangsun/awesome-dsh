import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import { mediaTokenOf, readSessionLog } from '../src/sessionLog.js'
import { mediaCall, mediaResult, writeSessionLog } from './logFixture.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-media-log-'))
})

const read = (path: string) => readFileSync(path)
const url = (token: string) => `http://127.0.0.1:43120/media/${token}`

describe('mediaTokenOf', () => {
  it('reads the token out of a published url, ignoring query and fragment', () => {
    expect(mediaTokenOf(url('abc123'))).toBe('abc123')
    expect(mediaTokenOf(`${url('abc123')}?x=1#t`)).toBe('abc123')
  })

  it('ignores anything that is not a media url', () => {
    expect(mediaTokenOf('https://example.com/clip.mp3')).toBeUndefined()
    expect(mediaTokenOf('/media/')).toBeUndefined()
  })
})

describe('readSessionLog', () => {
  it('pairs a media_render call with the token its result published', () => {
    const path = writeSessionLog(join(root, 'a.jsonl.zstd'), root, [
      mediaCall('call-1', [{ url: 'clip.mp3' }]),
      mediaResult('call-1', [url('aaa111')]),
    ])
    expect(readSessionLog(read(path))).toEqual({ cwd: root, recovered: [{ token: 'aaa111', ref: 'clip.mp3' }] })
  })

  it('reads every frame of a log appended one flush at a time', () => {
    const path = writeSessionLog(
      join(root, 'b.jsonl.zstd'),
      root,
      [mediaCall('call-1', [{ url: 'clip.mp3' }])],
      [{ type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } }],
      [mediaResult('call-1', [url('bbb222')])],
    )
    expect(readSessionLog(read(path)).recovered).toEqual([{ token: 'bbb222', ref: 'clip.mp3' }])
  })

  it('falls back to the result text when the meta is missing', () => {
    const path = writeSessionLog(join(root, 'c.jsonl.zstd'), root, [
      mediaCall('call-1', [{ url: 'clip.mp3' }]),
      mediaResult('call-1', [url('ccc333')], { meta: false }),
    ])
    expect(readSessionLog(read(path)).recovered).toEqual([{ token: 'ccc333', ref: 'clip.mp3' }])
  })

  it('ignores a call whose result is missing, and a result whose call is gone', () => {
    const orphanCall = writeSessionLog(join(root, 'd.jsonl.zstd'), root, [mediaCall('call-1', [{ url: 'clip.mp3' }])])
    expect(readSessionLog(read(orphanCall)).recovered).toEqual([])
    const orphanResult = writeSessionLog(join(root, 'e.jsonl.zstd'), root, [mediaResult('call-9', [url('ddd444')])])
    expect(readSessionLog(read(orphanResult)).recovered).toEqual([])
  })

  it('skips a reference that was passed through as a remote url', () => {
    const remote = 'https://example.com/clip.mp3'
    const path = writeSessionLog(join(root, 'f.jsonl.zstd'), root, [mediaCall('call-1', [{ url: remote }]), mediaResult('call-1', [remote])])
    expect(readSessionLog(read(path)).recovered).toEqual([])
  })

  it('keeps the item order of a multi-item render', () => {
    const path = writeSessionLog(join(root, 'g.jsonl.zstd'), root, [
      mediaCall('call-1', [{ kind: 'audio', url: 'a.mp3' }, { kind: 'video', url: 'b.mp4' }]),
      mediaResult('call-1', [url('t1'), url('t2')]),
    ])
    expect(readSessionLog(read(path)).recovered).toEqual([
      { token: 't1', ref: 'a.mp3' },
      { token: 't2', ref: 'b.mp4' },
    ])
  })

  it('survives a corrupt frame in the middle of a log', () => {
    const good = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', cwd: root })}\n`))
    const bad = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not a frame')])
    const events = [mediaCall('call-1', [{ url: 'clip.mp3' }]), mediaResult('call-1', [url('eee555')])]
    const tail = zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`))
    const path = join(root, 'h.jsonl.zstd')
    writeFileSync(path, Buffer.concat([good, bad, tail]))
    expect(readSessionLog(read(path)).recovered).toEqual([{ token: 'eee555', ref: 'clip.mp3' }])
  })

  it('returns nothing for a log with no media and no header', () => {
    const path = join(root, 'i.jsonl.zstd')
    writeFileSync(path, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', seq: 1, data: {} })}\n`)))
    expect(readSessionLog(read(path))).toEqual({ cwd: undefined, recovered: [] })
  })
})
