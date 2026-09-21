/**
 * dsh-gui-url —— 一个模型工具，返回本进程 Web GUI 的带 token 访问地址。
 *
 * ## 它解决什么
 *
 * DSH 的 Web GUI 每次重启都会换一个新的访问 token，于是想请 agent 自己去浏览器里
 * 核对界面的人，每次都得手动粘贴一遍 `http://127.0.0.1:<port>/?token=<…>`。
 *
 * 这个 token **不可能从磁盘上找回来**：
 *
 * ```js
 * function processLaunchToken(owner) {
 *   const existing = PROCESS_LAUNCH_TOKENS.get(owner)   // WeakMap
 *   if (existing !== undefined) return existing
 *   const created = encodeBase64Url(randomBytes(SECRET_BYTES))
 *   PROCESS_LAUNCH_TOKENS.set(owner, created)
 * }
 * ```
 *
 * 它由 `randomBytes` 生成、只活在 WeakMap 里。所以日志或任何残留文件里捡到的 token
 * 必定属于**某个已死进程**，配的端口也是死端口 —— 拿它访问只会得到
 * `401 dsh web authentication required`。
 *
 * 而**活着的进程自己知道**这两半：
 *
 * ```
 * ctx.webServer.port                      它实际监听的端口
 * ctx.connection.authenticatedUrl(base)   本进程的 token
 * ```
 *
 * 本插件把两者拼成一个模型工具。用的时候调，值就是当下的、有效的 —— 不落盘，
 * 因此也不存在"文件过期但看起来还行"这种失败方式。
 *
 * ## 为什么是工具而不是写文件
 *
 * 写成文件时，一个过期的文件和一个有效的文件**长得完全一样**，读的人无法分辨，
 * 只能靠"记得它可能是旧的"来防御。工具没有这个状态：它要么回答，要么明确说自己
 * 现在答不了（服务器还没监听 / 这个 profile 没有 Web GUI）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-gui-url'

/** 声明本插件依赖的服务：tools —— 没有它，ctx.tools 会抛 "cannot get property without inject"。 */
export const inject = ['tools']

/** 模型看到的工具名。 */
export const TOOL_NAME = 'gui_url'

/*
 * 描述是工具能不能被"命中"的唯一入口 —— 模型不会因为一个工具名叫 gui_url，就在需要
 * 调试客户端时想起它。选择发生在**场景匹配**上，所以这里必须把场景点名，而不是写一句
 * 概括。三件事缺一不可：
 *
 *   1. 说清它是什么（本进程客户端的地址，token 已内嵌，打开即用）；
 *   2. 罗列真实触发场景（改了客户端代码要验证、用户要地址、要读界面的真实状态）；
 *   3. 接上后续动作（改动要刷新才可见、别只凭源码就说界面改好了）。
 *
 * 定稿前请对照测试里的触发词断言 —— 有人"精简"掉场景列表时，那条测试会红。
 */
const DESCRIPTION = [
  'Return this process\'s DSH Web GUI URL, with its authentication token already embedded so',
  'it opens in a browser without a login prompt. This GUI is the client you are running in --',
  'the page the user is reading.',
  '',
  'Use it when the work needs the CLIENT, not the terminal:',
  '- you changed client-side code (a client plugin, a Slot, a tab, a theme token, the web',
  '  shell) and need to see whether it actually renders;',
  '- the user asks for the GUI address, the debug URL, or how to open the client;',
  '- you need the live UI\'s real state rather than inferring it from source.',
  '',
  'A client-side change only shows after the page is REFRESHED, and outside `pnpm run dev:web`',
  'the web artifacts must be rebuilt first: fetch this URL, refresh, and verify there -- never',
  'report a UI change as working from source alone.',
  '',
  'The token is minted per process, so it CHANGES ON EVERY RESTART: never reuse a URL from',
  'earlier in the conversation, and never reconstruct one from a log or a leftover file --',
  'those belong to dead processes and will return 401. Call this tool again instead.',
  '',
  'Call it with no arguments.',
].join('\n')

/**
 * 拼出当前进程的 GUI 地址。
 * @param ctx - 宿主插件上下文。
 * @returns 地址与一句给模型看的说明；无法给出时只返回说明。
 */
function currentUrl(ctx) {
  const server = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (server === undefined || connection === undefined) {
    return { text: `${TOOL_NAME}: this profile has no Web GUI (webServer/connection unavailable)` }
  }
  const port = server.port
  /* 明确说"还没有"，而不是给一个看起来正常却必然失败的地址。 */
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    return { text: `${TOOL_NAME}: the web server is not listening yet; retry in a moment` }
  }
  const bound = String(server.host ?? '')
  const authority = bound === '' || bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound
  const url = connection.authenticatedUrl(`http://${authority}:${String(port)}/`)
  return {
    url,
    text: `${url}\n\n(token is minted per process: it is valid now and will be replaced on the next restart)`,
  }
}

/**
 * 挂载：向工具注册表注册 `gui_url`。
 *
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value),
      }],
    },
    execute() {
      return Promise.resolve(currentUrl(ctx))
    },
  }))
}

export default { name, inject, apply }
