/**
 * driver.js —— cua-driver 生命周期编排（对标 ChatGPT 客户端 ComputerUse 的“隐形引擎”）。
 *
 * 解决用户痛点：不再需要手动安装/配置 cua-driver，也不再需要手动起常驻 server。
 * 插件在加载时自动完成四件事：
 *   1. ensureDriver      —— 二进制缺失则按配置引导安装（官方安装器 / 直连 Release）。
 *   2. ensureDaemon      —— 缺则起 cua-driver serve（机器级单例，detached+unref）。
 *   3. ensurePermissions —— 检测 macOS TCC 状态，必要时经 LaunchServices 触发授权弹窗。
 *   4. ensureVersion     —— 过期则委托 cua-driver 自更新（update --apply）。
 * 卸载时只 end_session（清自己的 cua session，见 cua.js endAllCuaSessions），绝不 stop 共享 daemon。
 *
 * CLI 事实（cua-driver 0.23.2，已实测）：
 *   - 引擎工具走 `cua-driver call <tool> <json>`（封装在 cua.js 的 cuaCall）。
 *   - 生命周期/查询是顶层子命令，不走 call：serve / stop / status /
 *     permissions status|grant / check-update / update --apply。本文件的 cliRun 专跑这些。
 *   - cua-driver 用机器级单例 daemon（默认 socket ~/Library/Caches/cua-driver/cua-driver.sock），
 *     serve 与 call 共用同一默认 socket，无需显式 --socket。
 *
 * 合规说明：除“首次引导”会联网+写一次文件外，正常运行期本插件仍只 spawn cua-driver
 * （serve/permissions/update 都是子命令），自身不联网、不写文件。首次引导的有界网络/写
 * 行为已在 package.json 的 dsh.permissions 与 PERMISSIONS.md 中如实声明。
 *
 * 跨会话：插件在 DSH 内每 profile 单实例、会话共享。daemon 是机器级单例（多会话共用），
 * 本模块只负责“确保它起来”，不在卸载时杀它；每会话的隔离由 index.js 的 per-session
 * 状态 + 唯一 cua session id（sid）+ 全局锁负责。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, chmodSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findBin, endAllCuaSessions } from './cua.js'

/** 插件托管缓存目录（二进制引导安装/直连下载落这里；同时参与 getBin 解析）。 */
export function cacheBinDir() {
  return join(homedir(), '.cache', 'dsh-computer-use', 'bin')
}

/** 我们托管的二进制预期路径。 */
export function cacheBinPath() {
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  return join(cacheBinDir(), exe)
}

/** 当前已知良好版本（首次引导锁版本，之后交给 cua-driver 自更新）。 */
const PINNED_VERSION = '0.23.2'

let _daemonChild = null
let _startedHere = false
// 并发合并：确保同一时刻只有一个 ensureDaemon 真正在跑（避免多会话/多工具并发各起一个 daemon）。
let _ensurePromise = null
// 授权-重启链是否正在执行，防止重复触发。
let _grantRestartChain = null

/**
 * 1. 确保 cua-driver 二进制存在；缺失则引导安装。
 * @param {object} cfg 插件配置（autoInstallDriver / driverInstallMethod / driverInstallCommand / driverRelease*）
 * @returns {Promise<{installed:boolean, method?:string, path:string}>}
 */
export async function ensureDriver(cfg) {
  const existing = findBin()
  if (existing) return { installed: true, path: existing }

  if (!cfg.autoInstallDriver) {
    throw new Error(
      '未找到 cua-driver，且 autoInstallDriver 关闭。请手动安装 cua-driver（官方安装器或 brew/npm），' +
      '或设 CUA_DRIVER_BIN 指向二进制，或在插件配置中开启 autoInstallDriver。',
    )
  }

  const method = cfg.driverInstallMethod || 'installer'
  if (method === 'direct') {
    await bootstrapDirect(cfg)
  } else {
    await bootstrapInstaller(cfg)
  }

  const after = findBin()
  if (!after) {
    throw new Error('cua-driver 引导安装后仍未在 PATH / 缓存目录找到。请检查 driverInstallCommand 或手动安装并设置 CUA_DRIVER_BIN。')
  }
  return { installed: true, method, path: after }
}

/**
 * 引导方式 A：运行官方安装器（默认）。
 * 安装器命令可配置（driverInstallCommand）；默认走 trycua 官方安装脚本。
 * 注意：这是插件唯一使用 shell:true 的地方（curl|sh 类管道必需），且仅在二进制缺失的
 * 一次性引导时发生，受 autoInstallDriver 开关控制，已在合规声明中如实说明。
 */
async function bootstrapInstaller(cfg) {
  const cmd = cfg.driverInstallCommand
    || 'curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/install.sh | sh'
  await runShell(cmd, 'official-installer')
}

/**
 * 引导方式 B：直连 GitHub Release 下载平台/架构对应的预编译二进制 + SHA256 校验。
 * 由配置提供 URL 模板与校验和（driverReleaseUrl / driverReleaseSha256），不依赖外部脚本。
 */
async function bootstrapDirect(cfg) {
  const url = cfg.driverReleaseUrl
  const expectedSha = cfg.driverReleaseSha256
  if (!url) throw new Error('driverInstallMethod=direct 但未配置 driverReleaseUrl。')
  const dir = cacheBinDir()
  mkdirSync(dir, { recursive: true })
  const target = cacheBinPath()

  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载 cua-driver 失败: HTTP ${res.status} (${url})`)
  const buf = Buffer.from(await res.arrayBuffer())

  if (expectedSha) {
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha.toLowerCase() !== String(expectedSha).toLowerCase()) {
      throw new Error(`cua-driver 校验和不匹配（期望 ${expectedSha}，实际 ${sha}），已中止以防投毒。`)
    }
  }
  writeFileSync(target, buf, { mode: 0o755 })
  chmodSync(target, 0o755)
}

/** 运行 shell 命令（仅用于一次性引导），捕获退出码与输出。 */
function runShell(command, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`${label} 启动失败: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${label} 失败 (exit ${code}): ${(err || out).slice(0, 600)}`))
    })
  })
}

/**
 * 跑 cua-driver 的“顶层子命令”（serve/stop/status/permissions/update/check-update）。
 * 这些不走 `call`，必须用独立子进程直接调。成功返回文本（json:true 时解析为对象）。
 * @param {string[]} args 子命令参数，如 ['permissions','status','--json']
 * @param {{json?:boolean}} [opts]
 */
function cliRun(args, opts = {}) {
  const bin = findBin() || 'cua-driver'
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`cua-driver 无法启动 (${bin}): ${e.message}`)))
    child.on('close', (code) => {
      const text = (out || err).trim()
      if (code !== 0) {
        reject(new Error(`cua-driver ${args.join(' ')} 失败 (exit ${code}): ${text.slice(0, 600)}`))
        return
      }
      if (opts.json) {
        try { resolve(JSON.parse(text)) }
        catch { reject(new Error(`cua-driver ${args.join(' ')} 返回非 JSON: ${text.slice(0, 400)}`)) }
      } else {
        resolve(text)
      }
    })
  })
}

/**
 * cua-driver 默认 socket 所在缓存目录（macOS / Linux）。Windows 走命名管道，无文件可清。
 * 见模块顶部注释：默认 socket ~/Library/Caches/cua-driver/cua-driver.sock。
 */
const SOCKET_CACHE_DIRS = [
  join(homedir(), 'Library', 'Caches', 'cua-driver'), // macOS
  join(homedir(), '.cache', 'cua-driver'), // Linux / XDG
]

/**
 * 清理残留的 stale socket：daemon 进程已死（崩溃 / kill -9 / 重启）但 socket 文件仍留在磁盘，
 * 会导致后续 `cua-driver serve` 永远报 "Address already in use" 而起不来（cua-driver 自身不清理）。
 * 只在 daemon 明确未运行（ensureDaemon 已先判 daemonRunning() 为 false）时调用，不会动活 daemon 的
 * socket；只删 *.sock，不碰目录里的其它文件（日志 / 配置）。
 * @returns {number} 实际删除的 socket 数量（用于日志）
 */
function cleanupStaleSockets() {
  let removed = 0
  for (const dir of SOCKET_CACHE_DIRS) {
    if (!existsSync(dir)) continue
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.sock')) continue
      try { unlinkSync(join(dir, name)); removed++ }
      catch { /* 权限 / 占用等删不掉则留给下次或人工处理 */ }
    }
  }
  return removed
}

/**
 * 2. 确保 daemon 在运行（机器级单例，缺才起，幂等）。
 * 用默认 socket（与 cua-driver call 一致）。起后轮询 status 直到就绪。
 * @param {object} cfg
 * @param {object} [ctx] 用于日志
 */
export async function ensureDaemon(cfg, ctx) {
  // 合并并发：多个会话/工具同时触发时，只跑一份真实启动逻辑，其余复用同一结果。
  if (_ensurePromise) return _ensurePromise

  _ensurePromise = (async () => {
    // 单实例护栏：任何已存在的 daemon 都直接复用（机器级单例，socket 唯一）。
    if (await daemonRunning()) {
      return // 已在运行：保留 _startedHere 归属标记（不翻转为 false，以免覆盖“我们之前起过”的状态）
    }

    const bin = findBin()
    if (!bin) {
      ctx?.logger?.warn?.('ensureDaemon: 二进制缺失，跳过起 daemon（请先 ensureDriver）。')
      return
    }

    // 清掉残留 socket：daemon 已死但 ~/Library/Caches/cua-driver/*.sock 还在，
    // 会让 serve 永远报 "Address already in use" 而起不来（cua-driver 自身不清理）。
    // 仅在 daemon 明确未运行（上方 daemonRunning() 已判）时清理，不动活 daemon 的 socket；无残留则 no-op。
    const removed = cleanupStaleSockets()
    if (removed > 0) ctx?.logger?.info?.(`ensureDaemon: 清理了 ${removed} 个残留 socket，准备重新 serve`)

    // detached + unref：脱离父进程成为机器级单例，父进程退出也不被杀。
    // stderr 收进缓冲仅用于诊断（serve 失败时能看见 EADDRINUSE 等真实原因，便于自愈）。
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    })
    let _serveErr = ''
    child.stderr?.on('data', (d) => { if (_serveErr.length < 4096) _serveErr += d })
    child.on('exit', (code) => {
      if (code !== 0) {
        ctx?.logger?.warn?.(`ensureDaemon: cua-driver serve 异常退出(code ${code})${_serveErr ? ': ' + _serveErr.slice(0, 400) : ''}`)
      }
    })
    child.unref?.()
    _daemonChild = child
    _startedHere = true

    // 轮询 readiness（最多 ~10s）
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await daemonRunning()) return
      await sleep(300)
    }
    ctx?.logger?.warn?.('ensureDaemon: daemon 未在预期时间内就绪，后续工具调用可能失败。')
  })()

  try {
    return await _ensurePromise
  } finally {
    _ensurePromise = null
  }
}

/** daemon 是否运行（读 cua-driver status 的退出/输出）。 */
async function daemonRunning() {
  try {
    const text = await cliRun(['status'])
    return /is running/i.test(text) || /"daemon_running":\s*true/.test(text)
  } catch {
    return false
  }
}

/**
 * 3. 权限引导（macOS）。检测 TCC 状态，必要时经 LaunchServices 触发授权弹窗。
 * 全程 best-effort：任何失败仅告警，绝不阻断插件加载。
 * @param {object} cfg（permissionMode: 'auto' 尝试 grant / 'report' 仅检测）
 * @param {object} [ctx]
 */
export async function ensurePermissions(cfg, ctx) {
  if (process.platform !== 'darwin') return
  let status
  try {
    status = await cliRun(['permissions', 'status', '--json'], { json: true })
  } catch (e) {
    ctx?.logger?.warn?.(`权限检测失败（可忽略）: ${e.message}`)
    return
  }
  const granted = status && (status.status === 'granted' || /granted|authorized|full/i.test(JSON.stringify(status)))
  if (granted) return

  if ((cfg.permissionMode || 'auto') === 'auto') {
    try {
      await grantPermissions(ctx)
    } catch (e) {
      ctx?.logger?.warn?.(`自动授权触发失败（请手动在系统设置授予）: ${e.message}`)
    }
  } else {
    ctx?.logger?.info?.('cua-driver 权限未授予：请在“系统设置 → 隐私与安全性”授予辅助功能与屏幕录制。')
  }
}

/**
 * 触发 cua-driver 权限授权（macOS）。经 LaunchServices 弹出系统授权请求。
 * 提取为独立函数，供授权重试链（grant + 重启 daemon）复用。
 * @param {object} [ctx]
 */
export async function grantPermissions(ctx) {
  await cliRun(['permissions', 'grant'])
  ctx?.logger?.info?.('已触发 cua-driver 权限授权流程，请按系统弹窗授予辅助功能 / 屏幕录制权限。')
  return true
}

/**
 * 停止本插件持有的 daemon（仅当我们起的才停）。
 * 先清合并态，再发 stop（stop 是顶层子命令，由 cliRun 跑）。
 */
export async function stopDaemon() {
  _ensurePromise = null
  _grantRestartChain = null
  if (!_startedHere) return false
  try {
    await cliRun(['stop'])
  } catch {
    /* stop 可能因 daemon 已不在而失败，忽略 */
  }
  _daemonChild = null
  _startedHere = false
  return true
}

/**
 * 重启 daemon：授权生效需要 daemon 重新读取 TCC 态。
 * 先停（仅当我们起的），再按需起。合并并发调用，避免抖动。
 * @param {object} cfg
 * @param {object} [ctx]
 */
export async function restartDaemon(cfg, ctx) {
  if (_grantRestartChain) return _grantRestartChain
  _grantRestartChain = (async () => {
    await stopDaemon()
    // 重置 _startedHere 标记，让 ensureDaemon 重新判定归属
    await ensureDaemon(cfg, ctx)
  })()
  try {
    return await _grantRestartChain
  } finally {
    _grantRestartChain = null
  }
}

/**
 * 轮询等待权限被授予（macOS TCC）。最多等待 timeoutMs。
 * 用于授权重试链：点完“允许”后确认 TCC 态落定再重启 daemon。
 * @param {object} [ctx]
 * @param {number} [timeoutMs=30000]
 */
export async function waitForGranted(ctx, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const status = await cliRun(['permissions', 'status', '--json'], { json: true })
      const granted = status && (status.status === 'granted' || /granted|authorized|full/i.test(JSON.stringify(status)))
      if (granted) return true
    } catch {
      /* 状态读取失败则继续轮询 */
    }
    await sleep(500)
  }
  ctx?.logger?.warn?.('waitForGranted: 超时仍未检测到授权（可能用户未点允许）。')
  return false
}

/**
 * 4. 版本自检：过期则委托 cua-driver 自更新（网络/写在 cua 进程内，插件只 spawn）。
 * @param {object} cfg（autoUpdate: boolean）
 * @param {object} [ctx]
 */
export async function ensureVersion(cfg, ctx) {
  if (cfg.autoUpdate === false) return
  try {
    const check = await cliRun(['check-update', '--json'], { json: true }).catch(() => null)
    const updateAvailable = check && (check.update_available || check.updateAvailable)
    if (!updateAvailable) return
    ctx?.logger?.info?.('发现 cua-driver 新版本，委托自更新（update --apply）…')
    await cliRun(['update', '--apply']).catch((e) => ctx?.logger?.warn?.(`自更新失败（可忽略）: ${e.message}`))
  } catch (e) {
    ctx?.logger?.warn?.(`版本自检失败（可忽略）: ${e.message}`)
  }
}

/**
 * 卸载时调用：结束本插件持有的全部 cua session（清光标/录制等），
 * 若 daemon 是本插件拉起的（_startedHere），则一并停止，使 cua-driver 生命周期与插件一致。
 * 若 daemon 是别的会话/进程拉起的，绝不 stop（避免误杀共享单例）。
 */
export async function endSessionOnUnload() {
  await endAllCuaSessions().catch(() => undefined)
  if (_startedHere) {
    await stopDaemon().catch(() => undefined)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 供测试/诊断：当前是否由本模块起过 daemon。 */
export function startedDaemonHere() {
  return _startedHere
}
