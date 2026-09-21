import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MediaTokenStore } from './mediaStore.js'
import { readSessionLog } from './sessionLog.js'

/**
 * Recovery of `/media/<token>` mappings from session history.
 *
 * A reply keeps its media URL forever, but the token behind it used to live only
 * in the memory of the process that minted it. Rebuilding those mappings from the
 * session logs is what makes the players in *existing* replies work again, without
 * the agent rendering every file a second time.
 *
 * The pass is deliberately cheap and incremental: newest log first, logs whose
 * size and mtime are unchanged since the previous pass are skipped, and one
 * wall-clock budget bounds the whole walk.
 */

/** How the healer reports what it did; `ctx.logger` satisfies it. */
export interface HealLogger {
  info(message: string): void
  warn(message: string): void
}

export interface HealReport {
  /** Tokens that were recovered and adopted into the store. */
  adopted: number
  /** Logs actually read in this pass. */
  scanned: number
  /** Logs skipped as unchanged, or left for a later pass once the budget ran out. */
  skipped: number
  ms: number
}

export interface MediaHistoryHealerOptions {
  store: MediaTokenStore
  /** Resolve a tool reference against its session cwd; `undefined` when unusable. */
  resolve: (cwd: string | undefined, ref: string) => string | undefined
  /** Sessions root; defaults to `$DSH_HOME/sessions`. */
  sessionsRoot?: string
  logger?: HealLogger
  /** Safety valve for a pathological log tree, in milliseconds. */
  budgetMs?: number
  now?: () => number
}

/** `${DSH_HOME:-~/.dsh}/sessions`, where every session log lives. */
export function defaultSessionsRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

interface LogFile {
  path: string
  mtimeMs: number
  size: number
}

/** Every `*.jsonl.zstd` log under `dir` (the store nests them by workspace). */
function logFiles(dir: string, depth = 0): LogFile[] {
  if (depth > 4) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // no history yet, or not readable from this process
  }
  const found: LogFile[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...logFiles(path, depth + 1))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue
    try {
      const stat = statSync(path)
      found.push({ path, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {
      // Removed between readdir and stat; nothing to heal from it.
    }
  }
  return found
}

export class MediaHistoryHealer {
  private readonly store: MediaTokenStore
  private readonly resolve: MediaHistoryHealerOptions['resolve']
  private readonly sessionsRoot: string
  private readonly logger: HealLogger | undefined
  private readonly budgetMs: number
  private readonly now: () => number
  /** path → `mtimeMs:size` of the last pass that read it. */
  private readonly seen = new Map<string, string>()
  private running: Promise<HealReport> | undefined

  constructor(options: MediaHistoryHealerOptions) {
    this.store = options.store
    this.resolve = options.resolve
    this.sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot()
    this.logger = options.logger
    this.budgetMs = options.budgetMs ?? 15_000
    this.now = options.now ?? Date.now
  }

  /** Recover every token one log still holds, and adopt those whose file exists. */
  private scanFile(file: LogFile): number {
    let recovered
    try {
      recovered = readSessionLog(readFileSync(file.path))
    } catch (error) {
      this.logger?.warn(`[dsh-media] could not read ${file.path}: ${String(error)}`)
      return 0
    }
    const entries: { token: string; path: string }[] = []
    for (const media of recovered.recovered) {
      const abs = this.resolve(recovered.cwd, media.ref)
      if (abs !== undefined) entries.push({ token: media.token, path: abs })
    }
    return this.store.adoptAll(entries)
  }

  /**
   * Read every log that changed since the last pass, newest first, and adopt the
   * tokens they still describe. Overlapping calls share one pass.
   */
  heal(signal?: AbortSignal): Promise<HealReport> {
    this.running ??= this.runPass(signal).finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async runPass(signal: AbortSignal | undefined): Promise<HealReport> {
    const started = this.now()
    const files = logFiles(this.sessionsRoot).sort((a, b) => b.mtimeMs - a.mtimeMs)
    let adopted = 0
    let scanned = 0
    let skipped = 0

    for (const file of files) {
      if (signal?.aborted === true) break
      if (this.now() - started > this.budgetMs) {
        skipped += 1
        break
      }
      const key = `${file.mtimeMs}:${file.size}`
      if (this.seen.get(file.path) === key) {
        skipped += 1
        continue
      }
      const found = this.scanFile(file)
      this.seen.set(file.path, key)
      scanned += 1
      adopted += found
      // Yield between logs so the pass never blocks the event loop for long.
      await new Promise((resolveTurn) => setImmediate(resolveTurn))
    }

    const report = { adopted, scanned, skipped, ms: this.now() - started }
    if (report.adopted > 0) {
      this.logger?.info(`[dsh-media] recovered ${report.adopted} media url(s) from session history`)
    }
    return report
  }

  /**
   * Try to recover one specific token — the path taken when a request arrives for
   * a URL that predates this process. Files already read are skipped, so repeated
   * misses only ever pay for logs that changed in between.
   */
  async healToken(token: string, signal?: AbortSignal): Promise<boolean> {
    if (this.store.resolve(token) !== undefined) return true
    try {
      await this.heal(signal)
    } catch (error) {
      this.logger?.warn(`[dsh-media] history recovery failed: ${String(error)}`)
    }
    return this.store.resolve(token) !== undefined
  }
}
