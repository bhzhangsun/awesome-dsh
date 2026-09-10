/**
 * Installer tests: the auto-install gate, the two target paths, and the
 * fail-loud guard. Each file-touching case runs the CLI as a subprocess against
 * a throwaway DSH_HOME, so nothing here can reach a real dsh home.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shouldAutoInstall } from '../bin/install.js'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const installer = join(pkgRoot, 'bin', 'install.js')

/**
 * Whether this environment can run a plain Node child at all.
 *
 * A sandboxed runner can alias `process.execPath` to a wrapper whose nested
 * sandbox initialization is refused; the child then exits without running the
 * script, which would look like a product failure. Probe with a trivial exit
 * code instead of trusting the spawn.
 * @returns true when a nested child cannot be trusted to run.
 */
function nestedSpawnBlocked() {
  const probe = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' })
  return probe.status !== 7
}

const skipReason = nestedSpawnBlocked()
  ? 'this environment cannot spawn a nested Node child; run the suite with a plain node'
  : false

/** Run the installer as a subprocess with a scoped environment. */
function runInstaller(home, args = [], env = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, ...env },
  })
}

describe('shouldAutoInstall', () => {
  it('installs on a global install', () => {
    assert.equal(shouldAutoInstall({ npm_config_global: 'true' }), true)
  })

  it('writes nothing for a dependency or workspace install', () => {
    assert.equal(shouldAutoInstall({}), false)
    assert.equal(shouldAutoInstall({ npm_config_global: 'false' }), false)
  })

  it('honours the explicit opt-in and opt-out', () => {
    assert.equal(shouldAutoInstall({ DSH_AGENT_SERVER_INSTALL: '1' }), true)
    assert.equal(shouldAutoInstall({ npm_config_global: 'true', DSH_AGENT_SERVER_SKIP_INSTALL: '1' }), false)
  })
})

describe('installer CLI', { skip: skipReason }, () => {
  let home

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-agent-server-'))
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('--dry-run reports both targets and writes nothing', () => {
    const result = runInstaller(home, ['--dry-run'])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /profiles\/server/)
    assert.match(result.stdout, /\.agent-presets\/server/)
    assert.deepEqual(readdirSync(home), [])
  })

  it('installs both halves into the dsh home', () => {
    const result = runInstaller(home)
    assert.equal(result.status, 0)
    assert.ok(existsSync(join(home, 'profiles', 'server', 'package.json')))
    assert.ok(existsSync(join(home, 'profiles', 'server', 'cordis.patch.yml')))
    assert.ok(existsSync(join(home, 'profiles', 'server', 'cordis.yml')))
    assert.ok(existsSync(join(home, 'profiles', 'server', 'pnpm-workspace.yaml')))
    assert.ok(existsSync(join(home, '.agent-presets', 'server', 'agent.cordis.yml')))
    assert.ok(existsSync(join(home, '.agent-presets', 'server', 'preset.yml')))
    assert.match(result.stdout, /dsh --profile server/)
  })

  it('--uninstall removes both halves and is safe to repeat', () => {
    assert.equal(runInstaller(home, ['--uninstall']).status, 0)
    assert.equal(existsSync(join(home, 'profiles', 'server')), false)
    assert.equal(existsSync(join(home, '.agent-presets', 'server')), false)

    const again = runInstaller(home, ['--uninstall'])
    assert.equal(again.status, 0)
    assert.match(again.stdout, /not installed, skipping/)
  })

  it('a postinstall that is not global writes nothing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dsh-agent-server-'))
    try {
      const result = runInstaller(bare, [], { npm_lifecycle_event: 'postinstall' })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /not a global install/)
      assert.deepEqual(readdirSync(bare), [])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('a postinstall with DSH_AGENT_SERVER_INSTALL=1 installs', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dsh-agent-server-'))
    try {
      const result = runInstaller(bare, [], {
        npm_lifecycle_event: 'postinstall',
        DSH_AGENT_SERVER_INSTALL: '1',
      })
      assert.equal(result.status, 0)
      assert.ok(existsSync(join(bare, 'profiles', 'server', 'package.json')))
      assert.ok(existsSync(join(bare, '.agent-presets', 'server', 'agent.cordis.yml')))
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('fails loud when a half is missing', () => {
    const broken = mkdtempSync(join(tmpdir(), 'dsh-agent-server-'))
    const target = mkdtempSync(join(tmpdir(), 'dsh-agent-server-home-'))
    try {
      cpSync(join(pkgRoot, 'bin'), join(broken, 'bin'), { recursive: true })
      cpSync(join(pkgRoot, 'profile'), join(broken, 'profile'), { recursive: true })
      const result = spawnSync(process.execPath, [join(broken, 'bin', 'install.js')], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: target },
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /source preset directory missing/)
      assert.deepEqual(readdirSync(target), [])
    } finally {
      rmSync(broken, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('rejects a profile manifest without dsh.profile.bundles', () => {
    const broken = mkdtempSync(join(tmpdir(), 'dsh-agent-server-'))
    const target = mkdtempSync(join(tmpdir(), 'dsh-agent-server-home-'))
    try {
      cpSync(join(pkgRoot, 'bin'), join(broken, 'bin'), { recursive: true })
      cpSync(join(pkgRoot, 'preset'), join(broken, 'preset'), { recursive: true })
      mkdirSync(join(broken, 'profile'))
      const result = spawnSync(process.execPath, [join(broken, 'bin', 'install.js')], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: target },
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /cannot read profile manifest|no dsh\.profile\.bundles/)
      assert.deepEqual(readdirSync(target), [])
    } finally {
      rmSync(broken, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})
