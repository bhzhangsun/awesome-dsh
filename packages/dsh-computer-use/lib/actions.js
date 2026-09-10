/**
 * actions.js —— 动作工具实现：点击 / 双击 / 右键 / 输入 / 按键 / 滚动 / 拖拽。
 *
 * 每个动作都基于 screen_observe 的快照（per-session）：
 *  - element 编号模式 → 透传 element_token（引擎校验快照是否过期）
 *  - x/y 坐标模式 → 使用快照窗口的 window-local 像素坐标
 * 所有 cua-driver 调用都带 sid（本会话 cua session id），保证并发会话隔离。
 */
import { cuaCall, normalizeMcp, withSession } from './cua.js'
import { getSnapshot } from './snapshot.js'
import { resolveToken, resolveWindow } from './snapshot.js'
import { humanClick, resolveClickTarget, windowLocalOf } from './human.js'

/**
 * 构造一次“基于编号或坐标”的引擎调用参数。
 * @param {object} args
 * @param {object} cfg
 * @param {object} extra
 * @param {string} sid 本会话 cua session id
 */
function targetArgs(args, cfg, extra = {}, sid = null) {
  const out = {}
  const snap = getSnapshot(sid)
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(sid, Number(args.element), cfg.ttlMs)
    out.pid = pid
    out.element_token = token
  } else if (args.x !== undefined || args.y !== undefined) {
    if (args.x === undefined || args.y === undefined) {
      throw new Error('坐标模式必须同时提供 x 和 y。')
    }
    const { pid, windowId } = resolveWindow(sid, cfg.ttlMs)
    const local = windowLocalOf(Number(args.x), Number(args.y), snap)
    out.pid = pid
    out.window_id = windowId
    out.x = local.x
    out.y = local.y
  } else {
    throw new Error('必须提供 element（观察编号）或 x/y 坐标。')
  }
  return withSession({ ...out, ...extra }, sid)
}

/** 通用动作执行：调用引擎并返回统一结果。 */
async function runAction(label, tool, args, cfg, extra = {}, sid = null) {
  const payload = targetArgs(args, cfg, extra, sid)
  const value = normalizeMcp(await cuaCall(tool, payload, sid))
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `${label} 被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `${label} 完成：${detail}` }
}

/**
 * 引擎侧拒绝检测：cua-driver 常以 200 + 结构化错误返回。
 */
function engineRefusal(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const effect = value.effect
    if (effect === 'refused' || effect === 'rejected') {
      const code = value.code ? ` (${value.code})` : ''
      const reason = value.escalation?.reason || value.reason || value.message || ''
      return `${effect}${code}${reason ? ' ' + reason : ''}`
    }
    if (typeof value.error === 'string') return value.error.slice(0, 200)
  }
  return null
}

/**
 * 真人点击：解析目标（编号或坐标）→ 光标滑行 → 像素级点击。
 */
async function humanAction(label, args, cfg, extra = {}, sid = null) {
  let target
  const snap = getSnapshot(sid)
  if (args.element !== undefined && args.element !== null) {
    target = resolveClickTarget(Number(args.element), cfg.ttlMs, sid)
  } else if (args.x !== undefined && args.y !== undefined) {
    const { pid, windowId } = resolveWindow(sid, cfg.ttlMs)
    const sx = Number(args.x)
    const sy = Number(args.y)
    const local = windowLocalOf(sx, sy, snap)
    target = { pid, windowId, x: local.x, y: local.y, sx, sy }
  } else {
    throw new Error('必须提供 element（观察编号）或 x/y 坐标。')
  }
  const value = await humanClick({ ...target, sessionId: sid, ...extra })
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `${label} 被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `${label} 完成（虚拟光标滑行+点击）：${detail}` }
}

/** computer_click —— 真人操作：光标滑行 + 像素点击 */
export async function click(args, cfg, sid) {
  const extra = {}
  if (args.count) extra.count = Number(args.count)
  return humanAction('点击', args, cfg, extra, sid)
}

/** computer_double_click */
export async function doubleClick(args, cfg, sid) {
  return humanAction('双击', args, cfg, { count: 2 }, sid)
}

/** computer_right_click */
export async function rightClick(args, cfg, sid) {
  return humanAction('右键点击', args, cfg, { button: 'right' }, sid)
}

/** computer_type —— 文本输入（可指定元素，否则输入到前台应用当前焦点） */
export async function typeText(args, cfg, sid) {
  if (!args.text) throw new Error('computer_type: 缺少 text 参数。')
  const payload = withSession({ text: String(args.text) }, sid)
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(sid, Number(args.element), cfg.ttlMs)
    payload.pid = pid
    payload.element_token = token
  } else {
    payload.scope = 'desktop'
  }
  const value = normalizeMcp(await cuaCall('type_text', payload, sid))
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `输入完成：${detail}` }
}

/** computer_key —— 按键 / 快捷键（如 return、cmd+c） */
export async function key(args, cfg, sid) {
  if (!args.key) throw new Error('computer_key: 缺少 key 参数。')
  const parts = String(args.key).toLowerCase().split('+').map((s) => s.trim())
  const MODS = new Set(['cmd', 'command', 'ctrl', 'control', 'option', 'alt', 'shift', 'fn'])
  const modifiers = parts.filter((p) => MODS.has(p)).map((p) => {
    if (p === 'command') return 'cmd'
    if (p === 'control') return 'ctrl'
    if (p === 'option') return 'alt'
    return p
  })
  const keyName = parts.filter((p) => !MODS.has(p))[0]
  if (!keyName) throw new Error('computer_key: 无法解析按键（示例: return / cmd+c / shift+tab）。')
  const payload = withSession({ key: keyName }, sid)
  if (modifiers.length > 0) payload.modifiers = modifiers
  try {
    const { pid, windowId } = resolveWindow(sid, cfg.ttlMs)
    payload.pid = pid
    payload.window_id = windowId
  } catch {
    payload.scope = 'desktop'
  }
  const value = normalizeMcp(await cuaCall('press_key', payload, sid))
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `按键完成 (${String(args.key)})：${detail}` }
}

/** computer_scroll */
export async function scroll(args, cfg, sid) {
  const dir = args.direction || 'down'
  if (!['up', 'down', 'left', 'right'].includes(dir)) {
    throw new Error('computer_scroll: direction 必须是 up/down/left/right。')
  }
  const payload = withSession({ direction: dir }, sid)
  if (args.amount) payload.amount = Number(args.amount)
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(sid, Number(args.element), cfg.ttlMs)
    payload.pid = pid
    payload.element_token = token
  } else {
    const { pid } = resolveWindow(sid, cfg.ttlMs)
    payload.pid = pid
  }
  const value = normalizeMcp(await cuaCall('scroll', payload, sid))
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `滚动完成 (${dir})：${detail}` }
}

/** computer_drag —— 拖拽（坐标 = 窗口本地截图像素，与观察输出同空间） */
export async function drag(args, cfg, sid) {
  const { pid } = resolveWindow(sid, cfg.ttlMs)
  if ([args.from_x, args.from_y, args.to_x, args.to_y].some((v) => v === undefined)) {
    throw new Error('computer_drag: 需要 from_x/from_y/to_x/to_y。')
  }
  const payload = withSession({
    pid,
    from_x: Number(args.from_x),
    from_y: Number(args.from_y),
    to_x: Number(args.to_x),
    to_y: Number(args.to_y),
  }, sid)
  if (args.duration_ms) payload.duration_ms = Number(args.duration_ms)
  const value = normalizeMcp(await cuaCall('drag', payload, sid))
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `拖拽完成：${detail}` }
}

/** computer_wait —— 本地等待（不调引擎） */
export async function wait(args) {
  const ms = Math.max(0, Math.min(Number(args.ms) || 1000, 60000))
  await new Promise((r) => setTimeout(r, ms))
  return { ok: true, result: `已等待 ${ms}ms。` }
}

/** app_list —— 列出应用 */
export async function listApps(sid) {
  const value = await cuaCall('list_apps', {}, sid)
  const apps = (value.apps || []).filter((a) => a.running)
  const lines = apps.map((a) => {
    const win = a.windows && a.windows.length > 0 ? ` (${a.windows.length} 窗口)` : ''
    return `- ${a.name}${win} [pid=${a.pid}]${a.active ? ' ★活动' : ''}`
  })
  const result = `正在运行的应用（${apps.length} 个）：\n${lines.join('\n')}`
  return { ok: true, result, apps: apps.map((a) => ({ name: a.name, pid: a.pid, active: a.active })) }
}

/** app_launch —— 启动应用（后台），可选前置 */
export async function launchApp(args, sid) {
  if (!args.name && !args.bundle_id) {
    throw new Error('app_launch: 需要 name（应用名）或 bundle_id。')
  }
  const payload = {}
  if (args.bundle_id) payload.bundle_id = String(args.bundle_id)
  else payload.name = String(args.name)
  if (args.creates_new_instance) payload.creates_new_instance = true
  const launched = await cuaCall('launch_app', payload, sid)

  let pid = launched?.pid ?? null
  let frontNote = ''
  if (args.bring_to_front && pid) {
    await cuaCall('bring_to_front', { pid }, sid)
    frontNote = ' 已前置'
  }

  const detail = typeof launched === 'string' ? launched : JSON.stringify(launched)
  return {
    ok: true,
    result: `应用已启动${frontNote}：${detail}`,
    pid,
  }
}
