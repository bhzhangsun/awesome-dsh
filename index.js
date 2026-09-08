/**
 * dsh-computer-use —— Computer Use 插件：给 harness-desktop 增加“虚拟鼠标真人操作”。
 *
 * 工具集（Hermes 风格，模型友好）：
 *   screen_observe          看屏幕：AX 编号树 + 坐标 / 原生直读 / 视觉观察者
 *   screen_zoom             区域截图直读（≤500px JPEG，细节放大看）
 *   computer_click          点击（element 编号 或 x/y 坐标）
 *   computer_double_click   双击
 *   computer_right_click    右键
 *   computer_type           文本输入
 *   computer_key            按键 / 快捷键
 *   computer_scroll         滚动
 *   computer_drag           拖拽
 *   computer_wait           等待 / 轮询间隔
 *   computer_sequence       批量执行多个动作（一次调用=一轮推理，提速）
 *   app_list                列出应用
 *   app_launch              启动应用
 *
 *   浏览器驱动（CDP，DOM 级；Chrome / Edge 走同一条路径，Safari 退回 computer-use）：
 *   browser_prepare         绑定浏览器 DevTools 端点
 *   get_browser_state       读页面 / 取元素 ref
 *   browser_navigate        按 URL 打开
 *   browser_click            DOM 级点击
 *   browser_type             DOM 级输入
 *   browser_pointer         hover / 右键 / 双击 / 滚动 / 拖拽
 *   browser_dialog          处理 JS 弹窗
 *
 * 视觉能力（原生接入）：
 *   - mode="native"：截图经 attachments 持久化后以图片块返回，主对话模型
 *     （如 deepseek-v4-flash-vision-exp）直接看图 —— 零外部 API、零额外 key。
 *   - mode="vision"：DeepSeek 视觉观察者（ctx.llm）结构化描述截图（免 ZHIPU key），
 *     不可用时回退 GLM 免费模型。
 *   - ax：零成本 AX 树；AX 树为空时自动降级 native → vision → ax。
 *
 * 零配置（本分支）：加载时自动引导安装 cua-driver（缺失时）、自动起常驻 daemon、
 * 自动权限引导、自动自更新。正常运行期本插件仍只 spawn cua-driver；仅“首次引导”
 * 会联网+写一次文件，已在 package.json 的 dsh.permissions 与 PERMISSIONS.md 如实声明。
 *
 * 并发安全：DSH 插件每 profile 单实例、会话共享。因此
 *   - 快照按 harness 会话 id 分桶（lib/snapshot.js），避免会话间串号；
 *   - 每个 harness 会话使用唯一 cua session id（sid），daemon 侧光标隔离；
 *   - 所有触碰屏幕的工具套一把进程内全局锁（lib/lock.js），同一时刻只有一个会话动屏幕。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { screenObserve, screenZoom } from './lib/observe.js'
import {
  click, doubleClick, rightClick, typeText, key, scroll, drag, wait, listApps, launchApp,
} from './lib/actions.js'
import {
  browserPrepare, browserGetState, browserNavigate, browserClick, browserType, browserPointer, browserDialog,
} from './lib/browser.js'
import { guard } from './lib/guard.js'
import { cuaCall, ensureCuaSession, DEFAULT_SESSION } from './lib/cua.js'
import {
  ensureDriver, ensureDaemon, ensurePermissions, ensureVersion, endSessionOnUnload,
  restartDaemon, waitForGranted,
} from './lib/driver.js'
import { withLock } from './lib/lock.js'
import { getSnapshot, isFresh } from './lib/snapshot.js'

export const name = '@bhzhangsun/dsh-computer-use'

export const inject = ['tools', 'approval']

/** 插件配置。 */
export const Config = z.object({
  /** 观察快照的有效期（毫秒）。 */
  ttlMs: z.number().default(30000),
  /** screen_observe 最多返回多少编号元素。 */
  maxElements: z.number().default(500),
  /** 区域限制：允许操作的应用名白名单（空 = 不限制）。 */
  allowedApps: z.array(z.string()).default([]),
  /** 虚拟光标主题 id（空 = 不设置，用引擎默认）。 */
  cursorTheme: z.string().default('com.dsh.computeruse.rainbow'),
  /** 原生直读截图策略：auto（PNG 超限额时自动降级 zoom JPEG）/ full（始终原图 PNG）/ compact（始终 ≤500px JPEG）。 */
  nativeImage: z.union(['auto', 'full', 'compact']).default('auto'),
  /** Mode D 观察者 provider 路由。 */
  visionProvider: z.string().default('deepseek-official'),
  /** Mode D 观察者模型（需声明 image 输入）。 */
  visionModel: z.string().default('deepseek-v4-flash-vision-exp'),
  /** 零配置：cua-driver 缺失时自动引导安装。 */
  autoInstallDriver: z.boolean().default(true),
  /** 引导方式：official-installer（默认，运行 driverInstallCommand）/ direct（直连 Release 下载）。 */
  driverInstallMethod: z.union(['installer', 'direct']).default('installer'),
  /** 官方安装器命令（installer 模式使用）；默认 trycua 官方安装脚本，可覆盖。 */
  driverInstallCommand: z.string().default('curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/install.sh | sh'),
  /** 直连下载的 Release 资产 URL（direct 模式使用）。 */
  driverReleaseUrl: z.string().default(''),
  /** 直连下载的预期 SHA256（direct 模式校验用，空则不校验）。 */
  driverReleaseSha256: z.string().default(''),
  /** 权限引导：auto（尝试 permissions grant 触发系统弹窗）/ report（仅检测并提示）。 */
  permissionMode: z.union(['auto', 'report']).default('auto'),
  /** 零配置：过期则委托 cua-driver 自更新（update --apply）。 */
  autoUpdate: z.boolean().default(true),
})

/** 统一输出 schema：ok + result 文本。 */
const OUT = (extra = {}) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
      ...extra,
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.result }],
})

/** 图片块输出 schema 段（native 直读工具共用）。 */
const IMAGE_FIELD = {
  image: {
    oneOf: [{
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
        bytes: { type: 'integer', required: true },
        width: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        height: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        name: { type: 'string' },
      },
    }, { type: 'null' }],
  },
}

/** render：值含 image 时追加图片块（主模型原生直读）。 */
function renderWithImage(_args, value) {
  if (!value.image) return [{ type: 'text', text: value.result }]
  return [
    { type: 'text', text: value.result },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...value.image.name === undefined ? {} : { name: value.image.name },
      },
    },
  ]
}

/** 统一的坐标/编号参数块（坐标 = 窗口本地截图像素）。 */
const TARGET_PARAMS = {
  element: {
    type: 'integer',
    description: 'screen_observe 输出的元素编号（如 5）。与 x/y 二选一，优先。',
  },
  x: {
    type: 'integer',
    description: '窗口本地截图像素 x（screen_observe 的截图坐标系，模型所见即所点）。与 element 二选一。',
  },
  y: {
    type: 'integer',
    description: '窗口本地截图像素 y。',
  },
}

/**
 * 从 exec 派生本 harness 会话的稳定标识。DSH 多会话共享同一插件实例，
 * 必须用稳定 sid 区分快照与 cua session，避免串号。
 * @param {object} exec
 * @returns {string}
 */
function sessionKeyOf(exec) {
  const a = exec?.agent
  if (!a) return DEFAULT_SESSION
  const id = a.session?.id || a.id || a.options?.session || a.options?.id
  if (id) return `sess:${id}`
  const cfg = a.session?.requestHeader?.()?.config
  return `agent:${a.options?.provider || ''}:${a.options?.model || ''}:${cfg?.session || ''}`
}

export async function apply(ctx, config) {
  const cfg = {
    ttlMs: config.ttlMs,
    maxElements: config.maxElements,
    allowedApps: Array.isArray(config.allowedApps) ? config.allowedApps : [],
    cursorTheme: config.cursorTheme,
    nativeImage: config.nativeImage || 'auto',
    visionProvider: config.visionProvider || 'deepseek-official',
    visionModel: config.visionModel || 'deepseek-v4-flash-vision-exp',
    autoInstallDriver: config.autoInstallDriver !== false,
    driverInstallMethod: config.driverInstallMethod || 'installer',
    driverInstallCommand: config.driverInstallCommand
      || 'curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/install.sh | sh',
    driverReleaseUrl: config.driverReleaseUrl || '',
    driverReleaseSha256: config.driverReleaseSha256 || '',
    permissionMode: config.permissionMode || 'auto',
    autoUpdate: config.autoUpdate !== false,
  }

  // 零配置：加载期自动引导安装 + 起常驻 daemon（best-effort，不阻断工具注册）。
  try {
    await ensureDriver(cfg)
    await ensureDaemon(cfg, ctx)
  } catch (e) {
    ctx.logger?.error?.(`cua-driver 初始化失败（工具调用可能受限）: ${e.message}`)
  }
  // 权限引导与自更新为非阻塞 best-effort（不阻断启动）。
  void ensurePermissions(cfg, ctx).catch(() => undefined)
  void ensureVersion(cfg, ctx).catch(() => undefined)

  /** 是否命中“权限 pending”：引擎返回权限未授予、需用户在系统设置点允许。 */
  const isPermissionsPending = (value, err) => {
    const text = (value && (value.result || value.error)) || (err && err.message) || ''
    return /permissions_pending|permission.{0,8}pending|需要.{0,6}授权|permissions? required|屏幕录制|辅助功能|accessibility|screen recording|tcc/i.test(String(text))
  }

  /**
   * 授权重试链：检测 pending 时自动触发授权 → 等用户点“允许” → 重启 daemon 让授权立即生效 → 单次重试。
   * 仅 permissionMode=auto 时自动；否则返回手动指引，避免反复弹窗。
   */
  const recoverFromPending = async (runGuarded, sid) => {
    if ((cfg.permissionMode || 'auto') !== 'auto') {
      return { ok: false, result: '✗ 操作需要屏幕录制/辅助功能授权，请在“系统设置 → 隐私与安全性”授予后重试（当前 permissionMode=report，未自动授权）。' }
    }
    try {
      // 1) 触发授权弹窗（best-effort）
      await ensurePermissions(cfg, ctx)
      // 2) 等用户在系统设置点“允许”（轮询 TCC 态，最多 30s）
      const granted = await waitForGranted(ctx)
      // 3) 点完允许立即生效：重启 daemon 重新读取 TCC 态
      await restartDaemon(cfg, ctx)
      // 4) 单次重试（不循环，避免无限弹窗）
      const retry = await runGuarded()
      if (isPermissionsPending(retry, null)) {
        return {
          ok: false,
          result: granted
            ? '✗ 已授权但操作仍未通过，请稍候重试一次（daemon 重启后状态可能需片刻生效）。'
            : '✗ 授权未完成（未在超时内点“允许”），请在系统设置授予后重试。',
        }
      }
      return retry
    } catch (err) {
      return { ok: false, result: `✗ 授权重试失败: ${err.message}` }
    }
  }

  /**
   * 批量执行：一次调用顺序跑多个动作（输入→回车→等待 等界面稳定的连续动作），
   * 把多轮模型推理压成一轮，提速明显。不中途重新观察——只适用于界面稳定的连续动作；
   * 凡依赖中间结果的步骤（如"点搜索结果第一项"）仍应单独 screen_observe 后再做。
   */
  const STEP_OPS = {
    click: { fn: click, name: 'computer_click' },
    double_click: { fn: doubleClick, name: 'computer_double_click' },
    right_click: { fn: rightClick, name: 'computer_right_click' },
    type: { fn: typeText, name: 'computer_type' },
    key: { fn: key, name: 'computer_key' },
    scroll: { fn: scroll, name: 'computer_scroll' },
    drag: { fn: drag, name: 'computer_drag' },
    wait: { fn: wait, name: 'computer_wait' },
  }
  const COORD_OPS = new Set(['click', 'double_click', 'right_click', 'drag'])

  const runSequence = async (steps, exec, sid) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, result: '✗ computer_sequence 需要非空 steps 数组。' }
    }
    // 含坐标/编号动作的步骤：要求开场有新鲜快照（避免盲点到错误窗口）
    const needsSnap = steps.some((s) => COORD_OPS.has(s.op) || (s.op === 'scroll' && s.element !== undefined))
    if (needsSnap) {
      const snap = getSnapshot(sid)
      if (!snap || !isFresh(snap, cfg.ttlMs)) {
        return { ok: false, result: '✗ 序列含坐标/编号动作，请先 screen_observe 建立新鲜快照后再批量执行。' }
      }
    }
    const results = []
    for (const s of steps) {
      const op = STEP_OPS[s.op]
      if (!op) { results.push({ op: s.op, ok: false, result: `✗ 未知动作 op: ${s.op}` }); break }
      const g = await guard(ctx, cfg, op.name, s, exec, sid)
      if (!g.ok) { results.push({ op: s.op, ok: false, result: `✗ ${g.reason}` }); break }
      try {
        const r = await op.fn(s, cfg, sid)
        results.push({ op: s.op, ...r })
        if (!r.ok) break
      } catch (e) {
        results.push({ op: s.op, ok: false, result: `✗ ${e.message}` })
        break
      }
    }
    const allOk = results.every((r) => r.ok)
    const summary = results.map((r) => `[${r.op}] ${r.result}`).join('\n')
    return { ok: allOk, result: summary }
  }

  /** 统一包装：先过安全护栏，再执行实现；全程持全局锁，并按会话隔离。 */
  const wrap = (toolName, impl) => async (args, exec) => {
    // 每次工具调用先确保 daemon 在跑（幂等、合并并发；serve 前会清残留 socket）。
    // daemon 中途挂掉、或启动期被残留 socket 卡住时，无需重启 app 即可自愈。
    await ensureDaemon(cfg, ctx).catch(() => undefined)
    const sid = sessionKeyOf(exec)
    const runGuarded = () => withLock(async () => {
      const g = await guard(ctx, cfg, toolName, args, exec, sid)
      if (!g.ok) return { ok: false, result: `✗ ${g.reason}` }
      return await impl(args, cfg, exec, sid)
    }, sid)

    try {
      // 惰性建立本会话的 cua session（daemon 侧光标隔离），并应用光标主题。
      await ensureCuaSession(sid)
      if (cfg.cursorTheme) {
        await cuaCall('set_agent_cursor_theme', { theme_id: cfg.cursorTheme }, sid).catch(() => undefined)
      }
      const value = await runGuarded()
      // 引擎返回权限未授予（pending）——走授权重试链
      if (isPermissionsPending(value, null)) {
        return await recoverFromPending(runGuarded, sid)
      }
      return value
    } catch (err) {
      // 授权 pending 也可能以异常形式抛出
      if (isPermissionsPending(null, err)) {
        return await recoverFromPending(runGuarded, sid)
      }
      return { ok: false, result: `✗ ${err.message}` }
    }
  }

  ctx.tools.register(defineTool({
    name: 'screen_observe',
    description:
      '观察屏幕：对目标窗口生成"编号 + 控件 + 坐标"的界面树（AX 语义，零视觉 token 成本）。' +
      '操作电脑前必须先调用本工具取得快照；之后用 computer_click(element=[编号]) 或 computer_click(x=,y=) 操作（坐标为窗口本地截图像素）。' +
      'mode 选择：ax（默认，零成本树）/ vision（DeepSeek 视觉观察者结构化描述，免 ZHIPU key）/ native（截图直读，当前对话模型直接看图，需模型支持图片输入）。' +
      'AX 树无法解析（游戏/Canvas/Electron）时自动降级：native（若当前模型支持图片）→ vision → ax。' +
      '快照默认 30 秒过期，过期后需重新观察。',
    parameters: {
      window: {
        type: 'string',
        description: '可选：目标窗口，传 pid 数字或标题子串（如 "访达"）。缺省选最前窗口。',
      },
      mode: {
        type: 'string',
        enum: ['ax', 'vision', 'native'],
        description: 'ax（默认）= 零成本的界面树；vision = 视觉观察者描述；native = 截图直读（模型直接看图）。',
      },
      query: {
        type: 'string',
        description: '可选：按控件标签过滤界面树（如 "提交"）。',
      },
      maxElements: {
        type: 'integer',
        description: '可选：最多返回多少个编号元素（防上下文爆炸）。',
      },
    },
    output: { ...OUT({
      window: { type: 'object', additionalProperties: false, properties: {
        pid: { type: 'integer' }, windowId: { type: 'integer' },
        app: { type: 'string' }, title: { type: 'string' },
      } },
      elementCount: { type: 'integer' },
      mode: { type: 'string' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer' }, role: { type: 'string' },
            label: { type: 'string' },
            x: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
            y: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
      },
      screenshotFile: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      ...IMAGE_FIELD,
    }), render: renderWithImage },
    execute: wrap('screen_observe', (args, cfg2, exec, sid) => screenObserve(ctx, args, cfg2, exec, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'screen_zoom',
    description:
      '区域截图直读：裁剪窗口某块区域（截图像素坐标）为 ≤500px JPEG 并以图片返回，当前对话模型直接看图。' +
      '用于"放大某块区域细看"（小字、图标、图表），图片 token 远小于整窗截图。' +
      '坐标范围可用 screen_observe 的结果里的窗口截图尺寸（截图像素）估算；返回的图片即所见区域，' +
      '之后 computer_click(x=,y=) 的坐标仍指整窗截图像素 —— 若需要点击 zoom 图内坐标，请先看参照。',
    parameters: {
      pid: { type: 'integer', description: '可选：目标窗口所属进程 pid（screen_observe 输出）；缺省按 window_id 解析。' },
      window_id: { type: 'integer', required: true, description: '目标窗口 id（screen_observe 或 app_list 输出）。' },
      x1: { type: 'integer', description: '可选：区域左边界（整窗截图像素），默认 0。' },
      y1: { type: 'integer', description: '可选：区域上边界，默认 0。' },
      x2: { type: 'integer', description: '可选：区域右边界，默认窗口截图宽。' },
      y2: { type: 'integer', description: '可选：区域下边界，默认窗口截图高。' },
    },
    output: { ...OUT(IMAGE_FIELD), render: renderWithImage },
    execute: wrap('screen_zoom', (args, cfg2, exec, sid) => screenZoom(ctx, args, cfg2, exec, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click',
    description: '点击：传入 screen_observe 输出的元素编号（element），或窗口截图像素坐标（x,y）。点击的是 cua-driver 的虚拟光标，不抢真实鼠标。',
    parameters: { ...TARGET_PARAMS, count: { type: 'integer', description: '可选：点击次数，默认 1。' } },
    output: OUT(),
    execute: wrap('computer_click', (args, cfg2, _e, sid) => click(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_double_click',
    description: '双击：element 编号 或 x/y 坐标。',
    parameters: TARGET_PARAMS,
    output: OUT(),
    execute: wrap('computer_double_click', (args, cfg2, _e, sid) => doubleClick(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_right_click',
    description: '右键点击：element 编号 或 x/y 坐标。',
    parameters: TARGET_PARAMS,
    output: OUT(),
    execute: wrap('computer_right_click', (args, cfg2, _e, sid) => rightClick(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_type',
    description: '文本输入：向当前焦点（或指定元素）输入一段文本。注意：不要在密码框使用——密码必须由用户本人输入（敏感输入保护）。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本。' },
      element: TARGET_PARAMS.element,
    },
    output: OUT(),
    execute: wrap('computer_type', (args, cfg2, _e, sid) => typeText(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_key',
    description: '按键 / 快捷键：如 return、tab、escape、cmd+c、shift+tab。',
    parameters: {
      key: { type: 'string', required: true, description: '按键名或组合（示例: return / cmd+c / shift+tab / cmd+shift+p）。' },
    },
    output: OUT(),
    execute: wrap('computer_key', (args, cfg2, _e, sid) => key(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_scroll',
    description: '滚动：在目标窗口内向上/下/左/右滚动。',
    parameters: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向，默认 down。' },
      amount: { type: 'integer', description: '可选：滚动格数，默认 3。' },
      element: TARGET_PARAMS.element,
    },
    output: OUT(),
    execute: wrap('computer_scroll', (args, cfg2, _e, sid) => scroll(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_drag',
    description: '拖拽：在快照窗口内从 (from_x,from_y) 拖到 (to_x,to_y)，坐标为窗口本地截图像素。',
    parameters: {
      from_x: { type: 'integer', required: true, description: '起点 x（截图像素）。' },
      from_y: { type: 'integer', required: true, description: '起点 y。' },
      to_x: { type: 'integer', required: true, description: '终点 x。' },
      to_y: { type: 'integer', required: true, description: '终点 y。' },
      duration_ms: { type: 'integer', description: '可选：拖拽耗时毫秒，默认 500。' },
    },
    output: OUT(),
    execute: wrap('computer_drag', (args, cfg2, _e, sid) => drag(args, cfg2, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_wait',
    description: '等待：暂停一段时间（如等待界面加载/动画完成），不调用引擎。',
    parameters: {
      ms: { type: 'integer', required: true, description: '等待毫秒数（1-60000）。' },
    },
    output: OUT(),
    execute: wrap('computer_wait', (args) => wait(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_sequence',
    description:
      '批量执行多个动作（一次调用 = 一轮模型推理），把"输入→回车→等待"等界面稳定的连续动作压成一步，显著提速。' +
      '例：搜歌可 [{op:"type",text:"明天会更好"},{op:"key",key:"return"},{op:"wait",ms:1500}]。' +
      '注意：序列中途不重新观察屏幕，只适用于界面稳定的连续动作；凡依赖中间结果（如"点搜索结果第一项"）的步骤，' +
      '应先单独 screen_observe 取得坐标/编号，再发起序列。' +
      'op 可选：click/double_click/right_click/type/key/scroll/drag/wait；各 op 参数同对应 computer_* 工具' +
      '（click 用 element 或 x/y；type 用 text；key 用 key；scroll 用 direction/amount/element；drag 用 from_*/to_*；wait 用 ms）。',
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: '有序动作列表，每项 { op, ...对应参数 }。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            op: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'drag', 'wait'] },
            element: { type: 'integer' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            text: { type: 'string' },
            key: { type: 'string' },
            direction: { type: 'string' },
            amount: { type: 'integer' },
            from_x: { type: 'integer' },
            from_y: { type: 'integer' },
            to_x: { type: 'integer' },
            to_y: { type: 'integer' },
            count: { type: 'integer' },
            duration_ms: { type: 'integer' },
            ms: { type: 'integer' },
          },
        },
      },
    },
    output: OUT(),
    execute: wrap('computer_sequence', (args, cfg2, exec, sid) => runSequence(args.steps, exec, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'app_list',
    description: '列出当前正在运行的应用（名称 + pid），用于选择要操作的目标。',
    parameters: {},
    output: OUT({ apps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' }, pid: { type: 'integer' }, active: { type: 'boolean' },
        },
      },
    } }),
    execute: wrap('app_list', (_a, _c, _e, sid) => listApps(sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'app_launch',
    description: '启动一个应用（后台启动，不抢焦点；可选 bring_to_front 前置到前台）。用于"打开应用"这一步。',
    parameters: {
      name: {
        type: 'string',
        description: '应用显示名（如 "备忘录"）。与 bundle_id 二选一。',
      },
      bundle_id: {
        type: 'string',
        description: '应用 bundle id（如 com.apple.Notes）。优先于 name。',
      },
      bring_to_front: {
        type: 'boolean',
        description: '可选：启动后是否前置到前台（默认 false，后台启动）。',
      },
      creates_new_instance: {
        type: 'boolean',
        description: '可选：强制启动新实例（open -n），用于并发多会话隔离。',
      },
    },
    output: OUT({ pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] } }),
    execute: wrap('app_launch', (args, _c, _e, sid) => launchApp(args, sid)),
  }))

  // ───── 浏览器驱动（CDP / Chrome DevTools Protocol）─────
  // 仅透传 cua-driver 的 browser_* 引擎调用，不做封装；sid 由 cuaCall 自动注入为 session。
  // 兼容性：Chrome / Edge（同为 Chromium）完整支持；Safari 走不了 CDP，相关任务由提示词退回 computer-use。
  ctx.tools.register(defineTool({
    name: 'browser_prepare',
    description:
      '绑定一个浏览器的 DevTools 端点，为后续 browser_* 工具建立会话作用域的 target_id / tab_id。' +
      '两种用法：① 自主 / 公开站点任务用 `{ allow_launch: true, profile: { mode: "isolated_new" } }` 在后台启动一个隔离浏览器（不碰用户数据）；' +
      '② 接管用户已打开的 Chrome / Edge：传其 `pid`（来自 app_list）。返回 target_id / tab_id，供后续 navigate / click / type 逐次透传。',
    parameters: {
      allow_launch: { type: 'boolean', description: '是否允许启动一个 driver 拥有的隔离 Chromium（默认 false）。与 pid 二选一。' },
      pid: { type: 'integer', description: '目标浏览器进程 pid（app_list 输出）。与 allow_launch 二选一；接管用户浏览器时传此值。' },
      profile: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['isolated_new', 'isolated_named'], required: true, description: '隔离 profile 模式：isolated_new（全新隔离）/ isolated_named（命名隔离，需 name）。' },
          name: { type: 'string', description: 'isolated_named 时必填，1-64 个路径安全 ASCII 字符。' },
        },
        description: '仅 allow_launch=true 时使用，描述启动的隔离 profile。',
      },
    },
    output: OUT(),
    execute: wrap('browser_prepare', (args, _c, _e, sid) => browserPrepare(args, _c, _e, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'get_browser_state',
    description:
      '只读检查浏览器：读取页面的 DOM / 语义大纲 / 元素 ref（用于定位与校验网页内容）。' +
      '传 target_id + tab_id 读取该标签页快照（返回可点击元素的 ref 与文本）；' +
      '若 browser_prepare 只返回 pid，也可传 pid + window_id 重新取 target_id / tab_id。' +
      '多步任务每步前重新调用以取最新 ref（导航 / 新快照会让旧 ref 失效）。',
    parameters: {
      target_id: { type: 'string', description: 'browser_prepare / 本工具返回的 target id（会话作用域）。' },
      tab_id: { type: 'string', description: '标签页 id（会话作用域）。与 target_id 一起传表示读快照。' },
      pid: { type: 'integer', description: '可选：原生浏览器进程 pid（bind 模式，配合 window_id）。' },
      window_id: { type: 'integer', description: '可选：pid 拥有的原生窗口 id（bind 模式）。' },
      query: { type: 'string', description: '可选：按角色 / 名称 / 可见文本做语义匹配过滤。' },
      include_screenshot: { type: 'boolean', description: '可选：是否附带标签页视口截图（PNG）。默认 false。' },
      snapshot_format: { type: 'string', enum: ['dom_refs_v1', 'semantic_v2'], description: '快照格式，默认 dom_refs_v1。' },
    },
    output: OUT(),
    execute: wrap('get_browser_state', (args, _c, _e, sid) => browserGetState(args, _c, _e, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: '在已绑定的标签页打开 URL（仅 http / https / about）。导航会使该标签页的旧 ref 失效。',
    parameters: {
      target_id: { type: 'string', required: true, description: 'browser_prepare 返回的 target id。' },
      tab_id: { type: 'string', required: true, description: '标签页 id。' },
      url: { type: 'string', required: true, description: '目标网址（http / https / about）。' },
    },
    output: OUT(),
    execute: wrap('browser_navigate', (args, _c, _e, sid) => browserNavigate(args, _c, _e, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: '点击页面元素：传 get_browser_state 返回的 ref，或视口 x/y 坐标（CSS px）。默认走可信硬件级输入。',
    parameters: {
      target_id: { type: 'string', required: true, description: 'target id。' },
      tab_id: { type: 'string', required: true, description: '标签页 id。' },
      ref: { type: 'string', description: '元素 ref（p<snapshot>:<index>），来自 get_browser_state。与 x/y 二选一。' },
      x: { type: 'number', description: '视口 x（CSS px），替代 ref。' },
      y: { type: 'number', description: '视口 y（CSS px），替代 ref。' },
      input_route: { type: 'string', enum: ['trusted', 'dom_event'], description: '输入路由：trusted（默认）/ dom_event（仅显式请求时用）。' },
    },
    output: OUT(),
    execute: wrap('browser_click', (args, _c, _e, sid) => browserClick(args, _c, _e, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: '向页面元素输入文本：传 get_browser_state 返回的 ref。默认在光标处插入（追加到已有文本）；replace:true 先全选再输入（清空则清框）。',
    parameters: {
      target_id: { type: 'string', required: true, description: 'target id。' },
      tab_id: { type: 'string', required: true, description: '标签页 id。' },
      ref: { type: 'string', required: true, description: '可编辑元素 ref，来自 get_browser_state。' },
      text: { type: 'string', required: true, description: '要输入的文本。' },
      replace: { type: 'boolean', description: 'true=先全选再替换（空文本则清空）；默认 false=光标处插入。' },
      mode: { type: 'string', enum: ['insert_text', 'keystrokes'], description: 'insert_text（默认）/ keystrokes（逐字符按键）。' },
    },
    output: OUT(),
    execute: wrap('browser_type', (args, _c, _e, sid) => browserType(args, _c, _e, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_pointer',
    description: '在标签页内做 hover / 右键 / 双击 / 滚动 / 拖拽。ref 或 x/y 定位；scroll 用 delta_x/delta_y；drag 用 destination_ref 或 to_x/to_y。',
    parameters: {
      target_id: { type: 'string', required: true, description: 'target id。' },
      tab_id: { type: 'string', required: true, description: '标签页 id。' },
      action: { type: 'string', enum: ['hover', 'right_click', 'double_click', 'scroll', 'drag'], required: true, description: '动作类型。' },
      ref: { type: 'string', description: '原点 ref，或 x/y。' },
      x: { type: 'number', description: '原点视口 x。' },
      y: { type: 'number', description: '原点视口 y。' },
      destination_ref: { type: 'string', description: '拖拽目标 ref（与原点同帧）。' },
      to_x: { type: 'number', description: '拖拽目标视口 x。' },
      to_y: { type: 'number', description: '拖拽目标视口 y。' },
      delta_x: { type: 'number', description: '横向滚动增量（CSS px）。' },
      delta_y: { type: 'number', description: '纵向滚动增量（CSS px）。' },
      input_route: { type: 'string', enum: ['trusted', 'dom_event'], description: '输入路由（默认 trusted）。' },
    },
    output: OUT(),
    execute: wrap('browser_pointer', (args, _c, _e, sid) => browserPointer(args, _c, _e, sid)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_dialog',
    description: '处理页面 JS 弹窗（alert / confirm / prompt / beforeunload）：inspect 取 dialog_id，accept / dismiss 处理。注意：不处理浏览器权限 / 扩展 / 原生对话框。',
    parameters: {
      target_id: { type: 'string', required: true, description: 'target id。' },
      tab_id: { type: 'string', required: true, description: '标签页 id。' },
      action: { type: 'string', enum: ['inspect', 'accept', 'dismiss'], required: true, description: 'inspect 取 id / accept 确认 / dismiss 取消。' },
      dialog_id: { type: 'string', description: 'inspect 返回的当前 dialog id（accept / dismiss 时必填）。' },
      prompt_text: { type: 'string', description: '仅 accept prompt 弹窗时有效。' },
      delivery_mode: { type: 'string', enum: ['background', 'foreground'], description: '默认 background。' },
    },
    output: OUT(),
    execute: wrap('browser_dialog', (args, _c, _e, sid) => browserDialog(args, _c, _e, sid)),
  }))

  // 系统提示注入：让 agent 知道自身拥有 Computer Use 能力，由 LLM 自行权衡何时调用。
  // 用 ctx.inject 动态注入——systemPrompt 服务缺失（如部分 profile）时自动跳过，不影响加载。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'dsh-computer-use:capabilities',
      order: 400, // 紧随 persona(order 0) 之后、plan/team policy(500/600) 之前
      text: [
        '## Computer Use 能力',
        '你拥有操作当前用户本机（macOS / Windows / Linux）的能力：通过一个独立的虚拟光标，像真人一样“看屏幕、移动、点击、输入”。下列工具已就绪，请按需自行决定何时使用：',
        '',
        '- 看屏：`screen_observe`（返回可点击元素的编号与坐标，支持 native / vision / ax 三模式；游戏 / Canvas / Electron 等无 AX 树的界面用 native 截图直读）、`screen_zoom`（区域截图放大直读）。',
        '- 操作：`computer_click` / `computer_double_click` / `computer_right_click`（真实像素级点击）、`computer_type`（文本输入）、`computer_key`（按键 / 快捷键）、`computer_scroll`（滚动）、`computer_drag`（拖拽）、`computer_wait`（等待）、`computer_sequence`（多步编排）。',
        '- 应用：`app_list`（列出正在运行的应用）、`app_launch`（启动应用）。',
        '- 浏览器驱动（CDP，DOM 级）：`browser_prepare`（绑定浏览器）、`get_browser_state`（读页面 / 取元素 ref）、`browser_navigate`（按 URL 打开）、`browser_click` / `browser_type`（DOM 级点击 / 输入）、`browser_pointer`（hover / 右键 / 双击 / 滚动 / 拖拽）、`browser_dialog`（处理 JS 弹窗）。',
        '',
        '**使用流程**：当用户要你操作本机 / 桌面 / 某个 App、打开窗口、点击某按钮、填写表单，或读取屏幕上可见的内容时——',
        '1. 先调用 `screen_observe` 获取当前屏幕的元素编号与坐标；',
        '2. 再用 `computer_*` 工具按编号 / 坐标执行操作；',
        '3. 多步任务每步前重新 `screen_observe`（屏幕状态会变，且快照有有效期）。',
        '所有坐标与元素编号都来自 `screen_observe` 的输出，所见即所点。',
        '',
        '### 浏览器任务：优先用浏览器驱动（而非像素操作）',
        '当任务涉及「网站 / 网页应用 / 某个 URL / 读取或校验网页上的内容」时，**优先使用浏览器驱动**（DOM 级，比 screen_observe + computer_click 点像素更可靠）。仅在以下情况退回通用 computer-use：',
        '- 需要**登录态**或**人机协作**（v1 暂不做无头登录态桥接，直接用 computer-use 操作用户可见的浏览器窗口）；',
        '- **Safari**（本引擎走 CDP，绑定不了 Safari，退回 computer-use 的 AX 路径）；',
        '- 浏览器驱动不可用（浏览器未装 / 绑定失败 / 引擎拒绝）时，**不要卡在浏览器工具上，立即退回 computer-use**。',
        '',
        '**标准流程（默认 Chrome；用户指名 Edge 用 Edge，二者同为 Chromium 走同一驱动）**：',
        '1. `browser_prepare`（自主 / 公开站点任务用 `{ allow_launch: true, profile: { mode: "isolated_new" } }` 在后台启动隔离浏览器；不碰用户数据）绑定 DevTools 端点，取回 `target_id` / `tab_id`；',
        '2. `browser_navigate({ target_id, tab_id, url })` 打开目标网址；',
        '3. `get_browser_state({ target_id, tab_id })` 读取页面 DOM 与元素 ref（用于校验 / 定位）；',
        '4. 用 `browser_click({ target_id, tab_id, ref })`（或 x/y 视口坐标）、`browser_type({ target_id, tab_id, ref, text })`（输入，可 `replace:true` 替换整框）操作；多步之间重新 `get_browser_state` 取最新 ref（导航 / 新快照会让旧 ref 失效）。',
        '5. 需要时 `browser_pointer`（hover / 右键 / 双击 / 滚动 / 拖拽）、`browser_dialog`（处理 JS 弹窗）。',
        '所有 `target_id` / `tab_id` / `ref` 都来自 `browser_prepare` / `get_browser_state` 的返回，逐次透传，不要凭空编造。',
        '',
        '注意：这些操作是真实且可见的，会实际改变用户屏幕状态；涉及删除 / 支付 / 转账等危险操作时你会被要求先获得用户批准，密码框不会被自动填写。请只有在用户意图明确指向“操作这台电脑 / 这个网页”时才使用上述工具。',
      ].join('\n'),
    })
  })

  // 插件卸载/上下文销毁时：只结束本插件持有的 cua session（清自己的光标/录制），
  // 绝不 stop 共享 daemon（其他会话可能还在用）。
  ctx.on?.('dispose', () => { void endSessionOnUnload() })

  ctx.logger?.info('dsh-computer-use: 20 个工具已注册（13 通用 Computer Use + 7 浏览器驱动；零配置：自动引导/起 daemon/权限/自更新）')
}

export default { name, inject, Config, apply }
