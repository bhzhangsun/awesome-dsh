# 功能请求：让 assistant 内容块模型可扩展（注册块 kind + 按 kind 注册渲染器 + agent 侧发块通道），富媒体只是其中一个用例

**背景**

我在做一个 DSH 插件（`@bhzhangsun/dsh-media`），给 agent 提供 `media_render` 工具：解析本地/远程媒体文件，通过 DSH 自己的 webserver（`/media/<token>`）对外提供，并在会话里渲染 HTML5 `<audio>`/`<video>` 播放器。在尝试让播放器**内联进助手最终消息**时，我发现真正的瓶颈不是"缺音频功能"，而是 DSH 的 **assistant 内容块模型是封闭的**——限制的不止音频，任何"agent 产出的结构化富内容"都会撞上同一堵墙。

**现状：DSH 已经有块模型，不是纯 Markdown**

`assistant` 消息的正文是一组结构化块 `AssistantBlock[]`：

```ts
type AssistantBlock =
  | { kind: 'text'; text: string }        // 内部是 markdown
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: ImageAttachmentRef } // 走可插拔槽
  | { kind: 'tool-call'; callId; name; argsRaw }
  | { kind: 'other'; block: unknown }     // 兜底，渲染成 JSON
```

Markdown 只是 `text` 块内部的语法，消息本身是"结构化块数组"。`image` 已经是结构化富内容，走可插拔的 `conversation.message.images` 槽。所以壳已经存在，问题只是它**封闭**。

**缺口：封闭的三个方面**

1. **块种类封闭**：只有 `text / reasoning / image / tool-call / other`，无法注册新的 kind（媒体/音频/视频/附件等）。新增 kind 没有入口，`other` 落到 JSON。

2. **渲染可插拔性有限**：只有 `image` 被路由到槽；`other` 硬编码成 JSON；没有"按块 kind 注册渲染器"的通用机制（`AssistantMarkdown` 里是 `switch (block.kind)`，无扩展点）。

3. **agent 侧没有发块通道**：模型只能输出文本 token，富块（如 `image`）靠 adapter/附件**在带外**注入。agent 无法"发出一个媒体块"，生产 adapter 目前也只声明文本输出。这与 https://github.com/deepseek-ai/deepseek-harness/discussions/2995 （"agent-emitted images inline in assistant messages"）提到的"agent-side channel to persist an image into the attachment store and emit an ImageBlock"是同一个缺口。

**建议方向**

- 把 `AssistantBlock` / 内容块模型做成**可扩展**：提供"注册块 kind + 注册该 kind 的渲染器"的公开机制，各 kind 走统一 dispatch（而非写死 switch），`image` 现有的 slot 通道作为其中一种实现保留。
- 提供 agent **在带外发出结构化富块**的通道（在 #2995 基础上扩展到媒体）：让 `media_render` 等工具产出的内容能作为一个内联富块打进助手消息正文，而不是作为会被折叠的工具结果节点。
- 顺带让折叠判断对插件**可达/可扩展**：`media_render` 的节点是 `tool/result` 驱动、锚在 turn 的 process 窗口内，compact 时间线会把它收进可折叠的 `N 次工具调用`（`TurnProcessNodeView`），展开才可见。决定"哪些 kind 能跳出折叠"的是 `TURN_PROCESS_INDEPENDENT_KINDS` 这个 `Set`——它在 `d.ts`（`turn-process.d.ts`）里声明为导出，但运行时 bundle 实际并没有导出（`client.js` 只导出 `EMPTY_CHAT_SNAPSHOT`、`apply`、`inject`、`isRunningTool`、`isSettledTool`），插件 `import` 不到，也没有 service/config/slot 入口能摘出某 kind。建议要么真正导出它，要么提供注册入口，让插件注册的 kind（如 `audio`/`video`）能选择不参与 turn-process 披露。

**环境**

- `@deepseek-ai/*` 各包版本 `0.1.2-rc.1`
- DSH Desktop Beta（macOS arm64）
- 插件：`@bhzhangsun/dsh-media`，依赖 `@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-conversation`

如需最小可复现插件或更多细节，我可以提供。
