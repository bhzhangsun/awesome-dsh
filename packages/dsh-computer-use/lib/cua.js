/**
 * cua.js —— cua-driver 引擎调用封装。
 *
 * 通过 `cua-driver call <tool> '<json-args>'` 的子进程方式调用引擎。零外部依赖：
 * 不需要 MCP SDK，CLI 即接口。
 *
 * 引擎二进制定位见 findBin()：CUA_DRIVER_BIN → 插件托管缓存目录 → PATH → 常见安装路径。
 * getBin() 动态解析（每次调用重算），便于引导安装后无需重启即可找到新二进制。
 *
 * 会话隔离：cua-driver 的 daemon 是机器级单例，但支持多 lifecycle session（各自独立虚拟
 * 光标）。本插件每个 harness 会话使用唯一的 cua session id（由 index.js 从 exec 派生），
 * 通过 cuaCall 的 sessionId 参数透传，确保并发会话在 daemon 侧互不干扰。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cacheBinPath } from './driver.js'

/** 兜底默认 session（仅在调用方未传入会话 id 时使用）。 */
export const DEFAULT_SESSION = 'dsh-computer-use'

/** 已 start_session 的 cua session 集合（按 harness 会话 id 去重，best-effort）。 */
const _startedSessions = new Set()

/**
 * 解析引擎二进制路径（优先级）：
 *   1. 环境变量 CUA_DRIVER_BIN（显式指定）
 *   2. 插件托管缓存目录（引导安装/直连下载落点）
 *   3. PATH 目录扫描（cua-driver / cua-driver.exe）
 *   4. 常见安装路径：~/.local/bin、/usr/local/bin、/opt/homebrew/bin、Windows %LOCALAPPDATA%
 * @returns {string|null} 找到返回绝对/相对路径，否则 null（交由调用方决定是否引导安装）。
 */
export function findBin() {
  const explicit = process.env.CUA_DRIVER_BIN
  if (explicit && existsSync(explicit)) return explicit

  if (existsSync(cacheBinPath())) return cacheBinPath()

  const sep = process.platform === 'win32' ? ';' : ':'
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue
    try { if (existsSync(join(dir, exe))) return join(dir, exe) } catch { /* 忽略 */ }
  }
  const common = [
    join(homedir(), '.local', 'bin', exe),
    `/usr/local/bin/${exe}`,
    `/opt/homebrew/bin/${exe}`,
    join(homedir(), 'AppData', 'Local', 'cua-driver', exe),
  ]
  for (const p of common) {
    try { if (existsSync(p)) return p } catch { /* 忽略 */ }
  }
  return null
}

/**
 * 给调用方判断二进制是否存在（引导安装用）。返回 null 表示未安装。
 */
export function getBin() {
  return findBin()
}

/**
 * 结束本插件持有的全部 cua session（插件卸载/上下文销毁时调用）。
 * 只 end_session 自己的会话，绝不动共享 daemon。Best-effort：单条失败不阻断其余。
 * @returns {Promise<void>}
 */
export async function endAllCuaSessions() {
  const ids = [..._startedSessions]
  _startedSessions.clear()
  await Promise.all(ids.map(async (id) => {
    try { await rawCall('end_session', { session: id }) } catch { /* 已结束或 daemon 不在，忽略 */ }
  }))
}

/**
 * 确保某个 cua session 已在 daemon 侧建立（惰性、幂等）。
 * @param {string} sessionId 本 harness 会话的唯一 cua session id
 */
export async function ensureCuaSession(sessionId) {
  if (!sessionId || _startedSessions.has(sessionId)) return
  try {
    await rawCall('start_session', { session: sessionId })
    _startedSessions.add(sessionId)
  } catch {
    // 若 daemon 未就绪，稍后首次 call 会触发自愈；此处 best-effort。
  }
}

/**
 * 调用一个 cua-driver 工具（带会话自愈）。
 * 若会话已结束（daemon 空闲回收/重启导致），自动 start_session 恢复后重试一次。
 * @param {string} tool 工具名
 * @param {object} args 参数对象
 * @param {string} [sessionId] 本 harness 会话的 cua session id（并发隔离用）
 * @returns {Promise<any>}
 */
export async function cuaCall(tool, args = {}, sessionId = null) {
  const fullArgs = sessionId ? { ...args, session: sessionId } : args
  try {
    return await rawCall(tool, fullArgs)
  } catch (err) {
    if (tool !== 'start_session' && /session '.*' has ended|revive it/.test(err.message)) {
      await rawCall('start_session', { session: sessionId || DEFAULT_SESSION }).catch(() => undefined)
      return rawCall(tool, fullArgs)
    }
    throw err
  }
}

/** 给动作类调用注入会话（观察类只读工具通常不需要）。 */
export function withSession(args = {}, sessionId = null) {
  return sessionId ? { session: sessionId, ...args } : { ...args }
}

/** 底层单次调用（不含会话自愈）。 */
function rawCall(tool, args = {}) {
  const bin = findBin() || 'cua-driver'
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['call', tool, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      const hint = e.code === 'ENOENT'
        ? `未找到 cua-driver：请确保它已安装并在 PATH 中，或设置环境变量 CUA_DRIVER_BIN 指向完整路径（如 CUA_DRIVER_BIN=/path/to/cua-driver），或开启插件的 autoInstallDriver 自动引导。`
        : ''
      reject(new Error(`cua-driver 无法启动 (${bin}): ${e.message}${hint ? ' ' + hint : ''}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = (err || out).trim()
        reject(new Error(`cua-driver ${tool} 失败 (exit ${code}): ${msg.slice(0, 800)}`))
        return
      }
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error(`cua-driver ${tool} 返回非 JSON: ${out.slice(0, 500)}`))
      }
    })
  })
}

/**
 * 归一化 MCP 形状的返回：若结果带 content 数组（[{type:'text',text}]），
 * 提取文本拼接；否则原样返回。
 */
export function normalizeMcp(value) {
  if (value && Array.isArray(value.content)) {
    const texts = value.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return value
}
