import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The token → file map behind `/media/<token>`.
 *
 * A `dsh-media` fence is *persisted text*: it carries the resolved media URL into
 * the conversation transcript, where it is re-rendered on every page load, in
 * every future session, and long after the process that minted it exited. A
 * memory-only map therefore breaks every older reply as soon as the host
 * restarts: the fence still renders, but its `<audio>`/`<video>` gets a 404 and
 * the bar sits at 0:00 over a black frame.
 *
 * So the map is persisted next to the other plugin state and restored at load.
 * Entries never expire (an old reply must keep playing); the only eviction is a
 * safety cap plus the removal of entries whose file is gone. Several DSH
 * processes can share one store file, so a write merges what is already on disk
 * and a miss re-reads it once before reporting 404.
 */

/** token → the file it serves, plus when it was minted (for the cap). */
interface StoredToken {
  path: string
  at: number
}

interface StoreFile {
  version: number
  files: Record<string, StoredToken>
}

const STORE_VERSION = 1
/** Safety cap for a file that would otherwise grow with every rendered clip. */
const MAX_TOKENS = 4096

/** `${DSH_HOME:-~/.dsh}/storages/dsh-media/served.json`. */
export function defaultStorePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-media', 'served.json')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export class MediaTokenStore {
  private readonly tokens = new Map<string, StoredToken>()
  private readonly filePath: string
  private loaded = false

  constructor(filePath: string = defaultStorePath()) {
    this.filePath = filePath
  }

  /** Every entry the store file currently holds, whatever this process knows. */
  private readRaw(): Map<string, StoredToken> {
    const entries = new Map<string, StoredToken>()
    let parsed: StoreFile
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile
    } catch {
      return entries // missing or corrupt: start from nothing rather than fail
    }
    const files = parsed?.files
    if (files === null || typeof files !== 'object') return entries
    for (const [token, entry] of Object.entries(files)) {
      if (typeof entry?.path !== 'string') continue
      entries.set(token, { path: entry.path, at: typeof entry.at === 'number' ? entry.at : 0 })
    }
    return entries
  }

  /**
   * Merge the store file into memory, dropping entries whose file is gone: a
   * deleted clip must not keep a token alive. Never fails — a missing, corrupt
   * or half-written store simply contributes nothing.
   */
  private loadFromDisk(): void {
    let dropped = 0
    for (const [token, entry] of this.readRaw()) {
      if (!isFile(entry.path)) {
        dropped += 1
        continue
      }
      if (this.tokens.get(token)?.path !== entry.path) this.tokens.set(token, entry)
    }
    if (dropped > 0) this.persist()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    this.loadFromDisk()
  }

  /**
   * Atomically replace the store file, merged with whatever another DSH process
   * wrote since we loaded. This process's entries win on a token collision. A
   * failure here never breaks serving.
   */
  private persist(): void {
    const merged = this.readRaw()
    // An entry whose file is gone is never written back, whoever minted it.
    for (const [token, entry] of merged) {
      if (!isFile(entry.path)) merged.delete(token)
    }
    for (const [token, entry] of this.tokens) {
      if (isFile(entry.path)) merged.set(token, entry)
    }
    while (merged.size > MAX_TOKENS) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [token, entry] of merged) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = token
        }
      }
      if (oldestKey === undefined) break
      merged.delete(oldestKey)
    }

    const payload: StoreFile = { version: STORE_VERSION, files: Object.fromEntries(merged) }
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
      renameSync(temp, this.filePath)
    } catch {
      try {
        unlinkSync(temp)
      } catch {
        // The temp file may never have been created; nothing to clean up.
      }
    }
  }

  /** Mint (or reuse) the token for one absolute path and persist the map. */
  mint(absPath: string): string {
    this.ensureLoaded()
    for (const [token, entry] of this.tokens) {
      if (entry.path === absPath) return token
    }
    const token = randomBytes(12).toString('hex')
    this.tokens.set(token, { path: absPath, at: Date.now() })
    while (this.tokens.size > MAX_TOKENS) {
      const oldest = this.tokens.keys().next().value
      if (oldest === undefined) break
      this.tokens.delete(oldest)
    }
    this.persist()
    return token
  }

  /** The file a live token serves, or `undefined` when it is unknown or gone. */
  resolve(token: string): string | undefined {
    this.ensureLoaded()
    let entry = this.tokens.get(token)
    if (entry === undefined) {
      // Another process may have minted it after we loaded (one store file is
      // shared by every DSH process on this machine): read it once more before
      // reporting a 404 for a URL that is actually fine.
      this.loadFromDisk()
      entry = this.tokens.get(token)
    }
    if (entry === undefined) return undefined
    if (!isFile(entry.path)) {
      this.tokens.delete(token)
      this.persist()
      return undefined
    }
    return entry.path
  }

  /** Number of live tokens — the store file's own health, exposed for diagnostics. */
  get size(): number {
    this.ensureLoaded()
    return this.tokens.size
  }
}

let store: MediaTokenStore | undefined

/** The process-wide store, created on first use. */
export function mediaTokenStore(): MediaTokenStore {
  store ??= new MediaTokenStore()
  return store
}
