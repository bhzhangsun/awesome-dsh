#!/usr/bin/env node
/**
 * dsh-agent-server — installer
 *
 * Installs BOTH halves of the headless agent server into the dsh home. They
 * ship together because dsh resolves each half from its own on-disk directory
 * convention, and neither is reachable from an installed package's
 * `node_modules`:
 *
 *     profile/  ->  $DSH_HOME/profiles/server/          (`dsh --profile server`)
 *     preset/   ->  $DSH_HOME/.agent-presets/server/    (roster auto-discovery)
 *
 * The profile disables the browser GUI, keeps the HTTP/WS API transport, and
 * defaults the roster to the `server` preset. The preset is the pure-reasoning
 * orchestration agent that the profile then mounts. Installing only one half
 * yields either a browser GUI with no server agent, or a preset nothing selects.
 *
 * Idempotent: re-installing overwrites both copies with this package's versions,
 * so upgrading the package and re-running is the whole update path.
 *
 * Options:
 *   --dry-run     print the resolved target paths and exit without writing
 *   --uninstall   remove both installed copies instead of installing
 *   --help        print this text
 *
 * Environment:
 *   DSH_HOME                      dsh home; defaults to ~/.dsh
 *   DSH_AGENT_SERVER_SKIP_INSTALL set to 1 to make the postinstall a no-op
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { cpSync, mkdirSync, existsSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The profile name, which is also the directory basename `--profile` resolves. */
const PROFILE_ID = 'server'
/** The agent preset id, which is also its directory basename in the user root. */
const PRESET_ID = 'server'

const USAGE = `dsh-agent-server — install the headless dsh agent server

Usage:
  dsh-agent-server [--dry-run] [--uninstall] [--help]

Installs:
  profile/  ->  $DSH_HOME/profiles/${PROFILE_ID}/
  preset/   ->  $DSH_HOME/.agent-presets/${PRESET_ID}/

Then boot:
  dsh --profile ${PROFILE_ID}
`

/**
 * Resolve the dsh home.
 *
 * `$DSH_HOME` wins; otherwise the convention home (`~/.dsh`), mirroring the
 * default the harness itself uses so both halves land where dsh actually looks.
 * @returns the absolute dsh home directory.
 */
function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) {
    return resolve(process.env.DSH_HOME)
  }
  return join(homedir(), '.dsh')
}

/**
 * The two install units this package owns.
 * @param home - the dsh home from {@link dshHome}.
 * @returns one entry per half, with its source directory and target directory.
 */
function units(home) {
  return [
    { label: 'profile', src: join(pkgRoot, 'profile'), dest: join(home, 'profiles', PROFILE_ID) },
    { label: 'preset', src: join(pkgRoot, 'preset'), dest: join(home, '.agent-presets', PRESET_ID) },
  ]
}

/**
 * Reject a package tree that cannot produce a working boot. A missing half or a
 * profile manifest without `dsh.profile.bundles` would install silently and fail
 * later inside dsh, so it fails here instead.
 * @param list - the units from {@link units}.
 */
function assertSources(list) {
  for (const unit of list) {
    if (!existsSync(unit.src)) {
      throw new Error(`source ${unit.label} directory missing: ${unit.src}`)
    }
  }

  const manifestPath = join(pkgRoot, 'profile', 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read profile manifest ${manifestPath}: ${error.message}`)
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error(`profile manifest has no dsh.profile.bundles: ${manifestPath}`)
  }
}

/** Install both halves, overwriting any previous copy. */
function install(list) {
  for (const unit of list) {
    mkdirSync(resolve(unit.dest, '..'), { recursive: true })
    cpSync(unit.src, unit.dest, { recursive: true, force: true })
    console.log(`[dsh-agent-server] installed ${unit.label} -> ${unit.dest}`)
  }
  console.log(`[dsh-agent-server] boot it with: dsh --profile ${PROFILE_ID}`)
}

/** Remove both installed halves. Absent targets are not an error. */
function uninstall(list) {
  for (const unit of list) {
    if (!existsSync(unit.dest)) {
      console.log(`[dsh-agent-server] ${unit.label} not installed, skipping: ${unit.dest}`)
      continue
    }
    rmSync(unit.dest, { recursive: true, force: true })
    console.log(`[dsh-agent-server] removed ${unit.label}: ${unit.dest}`)
  }
}

function main() {
  const args = new Set(process.argv.slice(2))

  if (args.has('--help') || args.has('-h')) {
    console.log(USAGE)
    return
  }

  if (args.has('--uninstall')) {
    const list = units(dshHome())
    console.log(`[dsh-agent-server] dsh home: ${dshHome()}`)
    uninstall(list)
    return
  }

  const list = units(dshHome())

  if (args.has('--dry-run')) {
    assertSources(list)
    console.log(`[dsh-agent-server] dsh home: ${dshHome()}`)
    for (const unit of list) {
      console.log(`[dsh-agent-server] would install ${unit.label}: ${unit.src} -> ${unit.dest}`)
    }
    return
  }

  assertSources(list)
  install(list)
}

/**
 * Whether a `postinstall` invocation may write into the dsh home on its own.
 *
 * Only a global install is the intended one-command setup (`npm install -g`).
 * Any other install — as another project's dependency, or inside this
 * repository's own pnpm workspace — must not silently overwrite the profile and
 * preset a developer is already running, so those installs write nothing and
 * print how to invoke the installer by hand.
 * @param env - the process environment.
 * @returns true when the postinstall may install without being asked to.
 */
export function shouldAutoInstall(env) {
  if (env.DSH_AGENT_SERVER_INSTALL === '1') return true
  if (env.DSH_AGENT_SERVER_SKIP_INSTALL === '1') return false
  return env.npm_config_global === 'true'
}

/** True when this file is the entry point rather than an imported module. */
function isMainModule() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(realpathSync(entry)).href
}

function run() {
  if (process.env.npm_lifecycle_event !== 'postinstall') {
    main()
    return
  }

  if (shouldAutoInstall(process.env)) {
    main()
    return
  }

  if (process.env.DSH_AGENT_SERVER_SKIP_INSTALL === '1') {
    console.log('[dsh-agent-server] DSH_AGENT_SERVER_SKIP_INSTALL=1, skipping install')
    return
  }

  console.log('[dsh-agent-server] not a global install, so the dsh home was left untouched.')
  console.log('[dsh-agent-server] install it explicitly with: npx @bhzhangsun/dsh-agent-server')
  console.log('[dsh-agent-server] (or re-run the postinstall with DSH_AGENT_SERVER_INSTALL=1)')
}

if (isMainModule()) {
  try {
    run()
  } catch (error) {
    console.error(`[dsh-agent-server] ${error.message}`)
    process.exit(1)
  }
}
