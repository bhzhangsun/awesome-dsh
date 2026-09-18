/**
 * browser.js —— 浏览器驱动工具实现（CDP / Chrome DevTools Protocol）。
 *
 * 这些工具直接透传 cua-driver 的 browser_* 引擎调用，不做额外封装：
 * 引擎已负责绑定浏览器 DevTools 端点、维护 target_id / tab_id / ref 的作用域。
 * 所有调用都带 sid（本 harness 会话的 cua session id），由 cuaCall 自动注入为
 * 浏览器工具的 `session` 参数，保证并发会话隔离。
 *
 * 定位（重要）：本组工具是**兜底**。任务涉及网页时应先探测系统里是否已有
 *   - 专用浏览器插件的工具（成体系的一族），或
 *   - 浏览器 / 网页类 MCP 工具（`mcp__<server>__*`）。
 * 有则一律用它们；本组 `browser_*` 只在两者都没有、或用户明确同意时才用。
 * 完整优先级写在 index.js 注入的系统提示里。
 *
 * 命名：工具名与 cua-driver 引擎的 `browser_*` 调用一一对应，便于对照引擎文档排查。
 *
 * 兼容性（v1）：
 *   - Chrome / Edge（同为 Chromium）→ 完整支持，走同一条 CDP 路径。
 *   - Safari / Firefox → 本引擎是 CDP，绑定不了；相关任务由提示词引导退回 computer-use(AX)。
 *   - 无头浏览器 → **不支持**：bind 模式要求 pid + window_id（原生窗口），无头无窗口。
 *   - 「传 pid 接管用户已在用的浏览器」→ **实测大概率被拒**。引擎认领端点的依据是
 *     "哪个 pid 拥有本机 loopback 上的调试监听 socket"，日常双击启动的 Chrome 没有该端口，
 *     browser_prepare 会返回 refusal: browser_requires_setup。当前 daemon 为 standard
 *     权限模式、无 existing-profile 授权，因此这条路径实际是关闭的；正解见系统提示第 0 步。
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
