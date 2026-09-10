/**
 * browser.js —— 浏览器驱动工具实现（CDP / Chrome DevTools Protocol）。
 *
 * 这些工具直接透传 cua-driver 的 browser_* 引擎调用，不做额外封装：
 * 引擎已负责绑定浏览器 DevTools 端点、维护 target_id / tab_id / ref 的作用域。
 * 所有调用都带 sid（本 harness 会话的 cua session id），由 cuaCall 自动注入为
 * 浏览器工具的 `session` 参数，保证并发会话隔离。
 *
 * 兼容性（v1，详见 index.js 系统提示）：
 *   - Chrome / Edge（同为 Chromium）→ 完整支持，走同一条 CDP 路径。
 *   - Safari → 本引擎是 CDP，绑定不了 Safari；相关任务由提示词引导退回 computer-use(AX)。
 *   - 登录态 / 人机协作 → v1 暂不做无头登录态桥接，退回 computer-use。
 *   - 任何浏览器驱动不可用 / 被拒绝 → 退回 computer-use（提示词已写明）。
 */
import { cuaCall, normalizeMcp } from './cua.js'

/**
 * 统一浏览器调用：透传引擎返回，归一为 { ok, result }。
 * 引擎常以 200 + 结构化 { effect:'refused'|'rejected' } 或 { error } 表达拒绝/失败。
 */
async function callBrowser(tool, args, sid) {
  let value
  try {
    value = normalizeMcp(await cuaCall(tool, args, sid))
  } catch (e) {
    return { ok: false, result: `✗ 浏览器工具 ${tool} 调用失败：${e.message}` }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.effect === 'refused' || value.effect === 'rejected') {
      const reason = value.escalation?.reason || value.reason || value.message || value.code || ''
      return { ok: false, result: `✗ 浏览器工具 ${tool} 被引擎拒绝：${reason}` }
    }
    if (typeof value.error === 'string') {
      return { ok: false, result: `✗ 浏览器工具 ${tool} 出错：${value.error}` }
    }
  }
  return { ok: true, result: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
}

export const browserPrepare = (args, _cfg, _exec, sid) => callBrowser('browser_prepare', args, sid)
export const browserGetState = (args, _cfg, _exec, sid) => callBrowser('get_browser_state', args, sid)
export const browserNavigate = (args, _cfg, _exec, sid) => callBrowser('browser_navigate', args, sid)
export const browserClick = (args, _cfg, _exec, sid) => callBrowser('browser_click', args, sid)
export const browserType = (args, _cfg, _exec, sid) => callBrowser('browser_type', args, sid)
export const browserPointer = (args, _cfg, _exec, sid) => callBrowser('browser_pointer', args, sid)
export const browserDialog = (args, _cfg, _exec, sid) => callBrowser('browser_dialog', args, sid)
