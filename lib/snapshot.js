/**
 * snapshot.js —— 观察快照缓存（per-session）。
 *
 * screen_observe 的结果有 TTL：过期后任何依赖编号/坐标的动作都会被拒绝，
 * 要求重新观察（对应项目书安全设计第 5 条“过期状态拒绝”）。
 * element_token 自带引擎侧 snapshot 校验，双重保险。
 *
 * 多会话共享：DSH 插件在每 profile 单实例、会话共享同一模块。因此快照不能再是模块
 * 级全局（否则会话 A 的快照会被会话 B 的动作误用）。改为按 harness 会话 id 分桶的 Map。
 */

/** 每会话一份快照：sessionId -> snapshot。 */
const _snapshots = new Map()

/**
 * 保存一次 screen_observe 的快照（归属到指定会话）。
 * @param {string} sessionId 本 harness 会话的唯一标识
 * @param {object} s
 * @param {Map<number,{token:string,role?:string,label?:string}>} s.entries 编号 → 元素信息
 */
export function setSnapshot(sessionId, s) {
  if (!sessionId) return
  _snapshots.set(sessionId, s)
}

/** 读取指定会话的快照（可能为 null）。 */
export function getSnapshot(sessionId) {
  return sessionId ? _snapshots.get(sessionId) ?? null : null
}

/** 指定会话的快照是否新鲜（在 TTL 内）。 */
export function isFresh(sessionId, ttlMs) {
  const snap = getSnapshot(sessionId)
  return Boolean(snap) && Date.now() - snap.at <= ttlMs
}

/** 清除指定会话的快照（如发生明显环境变化）。 */
export function clearSnapshot(sessionId) {
  if (sessionId) _snapshots.delete(sessionId)
}

/**
 * 校验并取回编号对应的元素信息。
 * @param {string} sessionId
 * @param {number} index screen_observe 输出的编号（= element_index）
 * @param {number} ttlMs 快照 TTL
 * @returns {{pid:number, token:string, windowId:number, role?:string, label?:string}}
 */
export function resolveToken(sessionId, index, ttlMs) {
  const snap = getSnapshot(sessionId)
  if (!snap) {
    throw new Error('没有可用的观察快照：请先调用 screen_observe 再执行动作。')
  }
  if (!isFresh(sessionId, ttlMs)) {
    clearSnapshot(sessionId)
    throw new Error(`观察快照已过期（超过 ${Math.round(ttlMs / 1000)} 秒）：请重新调用 screen_observe。`)
  }
  const entry = snap.entries?.get(index)
  if (!entry || !entry.token) {
    throw new Error(`编号 [${index}] 不在当前快照中：请重新调用 screen_observe 获取最新编号。`)
  }
  return {
    pid: snap.pid,
    token: entry.token,
    windowId: snap.windowId,
    role: entry.role,
    label: entry.label,
  }
}

/**
 * 取回快照的窗口定位信息（坐标模式使用 window-local 像素）。
 */
export function resolveWindow(sessionId, ttlMs) {
  const snap = getSnapshot(sessionId)
  if (!snap) {
    throw new Error('没有可用的观察快照：请先调用 screen_observe 再执行动作。')
  }
  if (!isFresh(sessionId, ttlMs)) {
    clearSnapshot(sessionId)
    throw new Error(`观察快照已过期（超过 ${Math.round(ttlMs / 1000)} 秒）：请重新调用 screen_observe。`)
  }
  return { pid: snap.pid, windowId: snap.windowId }
}
