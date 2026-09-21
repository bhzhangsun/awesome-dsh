import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MediaHistoryHealer } from '../src/historyHeal.js'
import { MediaTokenStore } from '../src/mediaStore.js'
import { resolveMediaFile } from '../src/mediaServer.js'
import { mediaCall, mediaResult, sessionLogPath, writeSessionLog } from './logFixture.js'

/**
 * The bug these cover: a reply's media URL outlives the process that minted it, so
 * a host restart left every older reply pointing at a token that no longer
 * resolved. The log of that reply still records both the file reference the tool
 * was given and the token its result published — reading it revives the player
 * without rendering the file again.
 */

let root: string
let sessionsRoot: string
let clip: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-media-heal-'))
  sessionsRoot = join(root, 'sessions')
  clip = join(root, 'clip.mp3')
  writeFileSync(clip, 'audio-bytes')
})

const url = (token: string) => `http://127.0.0.1:43120/media/${token}`

/** A healer over a throwaway store, exactly as the plugin wires one up. */
function healerAt(storeFile: string, options: { budgetMs?: number } = {}): { healer: MediaHistoryHealer; store: MediaTokenStore } {
  const store = new MediaTokenStore(storeFile)
  const healer = new MediaHistoryHealer({
    store,
    resolve: (cwd, ref) => resolveMediaFile(cwd, ref) ?? undefined,
    sessionsRoot,
    budgetMs: options.budgetMs,
  })
  return { healer, store }
}

/** Write a log whose reply published `token` for a file in the session workspace. */
function plantLog(workspace: string, sessionId: string, token: string, ref = 'clip.mp3', cwd = root): string {
  return writeSessionLog(sessionLogPath(sessionsRoot, workspace, sessionId), cwd, [
    mediaCall('call-1', [{ url: ref }]),
    mediaResult('call-1', [url(token)]),
  ])
}

describe('MediaHistoryHealer', () => {
  it('revives a token minted by a previous process', async () => {
    plantLog('--Users-me-proj--', 'abc', 'oldtoken1')
    const { healer, store } = healerAt(join(root, 'served.json'))

    const report = await healer.heal()
    expect(report.adopted).toBe(1)
    expect(report.scanned).toBe(1)
    expect(store.resolve('oldtoken1')).toBe(clip)
  })

  it('resolves a relative reference against the session cwd, not this process cwd', async () => {
    writeFileSync(join(root, 'sub.mp3'), 'x')
    plantLog('--Users-me-proj--', 'abc', 'oldtoken1', 'sub.mp3')
    const { healer, store } = healerAt(join(root, 'served.json'))

    await healer.heal()
    expect(store.resolve('oldtoken1')).toBe(join(root, 'sub.mp3'))
  })

  it('skips a reference whose file is gone', async () => {
    plantLog('--Users-me-proj--', 'abc', 'oldtoken1', 'deleted.mp3')
    const { healer, store } = healerAt(join(root, 'served.json'))

    const report = await healer.heal()
    expect(report.adopted).toBe(0)
    expect(store.resolve('oldtoken1')).toBeUndefined()
  })

  it('recovers a url on demand, the path a 404 request takes', async () => {
    const { healer, store } = healerAt(join(root, 'served.json'))
    expect(store.resolve('oldtoken2')).toBeUndefined()

    plantLog('--Users-me-proj--', 'abc', 'oldtoken2')
    expect(await healer.healToken('oldtoken2')).toBe(true)
    expect(store.resolve('oldtoken2')).toBe(clip)
  })

  it('answers false for a token no log describes', async () => {
    plantLog('--Users-me-proj--', 'abc', 'oldtoken1')
    const { healer } = healerAt(join(root, 'served.json'))
    expect(await healer.healToken('nope')).toBe(false)
  })

  it('reads an unchanged log only once, and a changed one again', async () => {
    const file = plantLog('--Users-me-proj--', 'abc', 'oldtoken1')
    const { healer, store } = healerAt(join(root, 'served.json'))

    expect((await healer.heal()).scanned).toBe(1)
    const second = await healer.heal()
    expect(second.scanned).toBe(0)
    expect(second.skipped).toBe(1)

    // The same log grows: a second render in that session must be picked up.
    writeSessionLog(file, root, [mediaCall('call-2', [{ url: 'clip.mp3' }]), mediaResult('call-2', [url('oldtoken2')])])
    utimesSync(file, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
    expect((await healer.heal()).adopted).toBe(1)
    expect(store.resolve('oldtoken2')).toBe(clip)
  })

  it('reads the newest log first', async () => {
    const olderWorkspace = join(root, 'older-workspace')
    const newerWorkspace = join(root, 'newer-workspace')
    mkdirSync(olderWorkspace, { recursive: true })
    mkdirSync(newerWorkspace, { recursive: true })
    writeFileSync(join(olderWorkspace, 'clip.mp3'), 'older-audio')
    writeFileSync(join(newerWorkspace, 'clip.mp3'), 'newer-audio')
    const older = plantLog('--Users-me-older--', 'older', 'oldertoken', 'clip.mp3', olderWorkspace)
    const newer = plantLog('--Users-me-newer--', 'newer', 'newertoken', 'clip.mp3', newerWorkspace)
    utimesSync(older, new Date(1_000_000), new Date(1_000_000))
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000))

    const order: string[] = []
    const store = new MediaTokenStore(join(root, 'served.json'))
    const healer = new MediaHistoryHealer({
      store,
      resolve: (cwd, ref) => {
        order.push(cwd ?? '')
        return resolveMediaFile(cwd, ref) ?? undefined
      },
      sessionsRoot,
    })
    await healer.heal()
    // Newest first: the session a user is most likely to open is healed first.
    expect(order).toEqual([newerWorkspace, olderWorkspace])
    expect(store.resolve('newertoken')).toBe(join(newerWorkspace, 'clip.mp3'))
    expect(store.resolve('oldertoken')).toBe(join(olderWorkspace, 'clip.mp3'))
    expect(await healer.heal()).toMatchObject({ scanned: 0, skipped: 2 })
  })

  it('stops at the budget and leaves the rest for a later pass', async () => {
    plantLog('--Users-me-proj--', 'abc', 'oldtoken1')
    const { healer } = healerAt(join(root, 'served.json'), { budgetMs: -1 })
    const report = await healer.heal()
    expect(report.scanned).toBe(0)
    expect(report.skipped).toBeGreaterThan(0)
  })

  it('does nothing when there is no history at all', async () => {
    const { healer, store } = healerAt(join(root, 'served.json'))
    expect(await healer.heal()).toMatchObject({ adopted: 0, scanned: 0, skipped: 0 })
    expect(store.size).toBe(0)
  })

  it('keeps a token that is already known', async () => {
    const storeFile = join(root, 'served.json')
    const { store } = healerAt(storeFile)
    const keep = store.mint(clip)
    plantLog('--Users-me-proj--', 'abc', keep)
    const { healer } = healerAt(storeFile)

    expect((await healer.heal()).adopted).toBe(0)
    expect(store.resolve(keep)).toBe(clip)
  })

  it('survives a session directory it cannot read', async () => {
    mkdirSync(join(sessionsRoot, '--broken--', 'session-x'), { recursive: true })
    writeFileSync(join(sessionsRoot, '--broken--', 'session-x', 'session.jsonl.zstd'), Buffer.from('not zstd'))
    const { healer } = healerAt(join(root, 'served.json'))
    await expect(healer.heal()).resolves.toMatchObject({ adopted: 0, scanned: 1 })
  })
})
