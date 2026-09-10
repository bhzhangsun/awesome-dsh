#!/usr/bin/env node
/**
 * Point git at this repository's committed hooks (`.githooks`).
 *
 * The hook that matters most is `pre-push`, which refuses to publish foreign
 * tags — a rule that is easy to forget and expensive to get wrong (`git push
 * --tags` in a repository that also fetches a fork's tags). Wiring it up from
 * `pnpm install` means nobody has to remember `git config core.hooksPath`.
 *
 * This script never fails: a missing git binary, or a context with no
 * repository (an installed tarball), must not break an install.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HOOKS_PATH = '.githooks'

const git = (...args) => spawnSync('git', args, { stdio: 'pipe' })

if (git('rev-parse', '--git-dir').status !== 0) {
  console.log('[hooks] no git repository here — skipping core.hooksPath setup')
  process.exit(0)
}

if (git('config', '--get', 'core.hooksPath').stdout?.toString().trim() === HOOKS_PATH) {
  process.exit(0)
}

// Keep the hooks executable even if a checkout lost the mode bit.
try {
  for (const name of readdirSync(HOOKS_PATH)) {
    chmodSync(join(HOOKS_PATH, name), 0o755)
  }
} catch {
  // Best effort only; the config below is what matters.
}

if (git('config', 'core.hooksPath', HOOKS_PATH).status !== 0) {
  console.warn(`[hooks] could not set core.hooksPath — run: git config core.hooksPath ${HOOKS_PATH}`)
  process.exit(0)
}

console.log(`[hooks] core.hooksPath -> ${HOOKS_PATH} (committed hooks are now active)`)
