# Feature: agent-emitted audio/video rendered inline in the assistant's final message (media_render), and not folded into the "N tool calls" disclosure

**Context**

I'm building a DSH plugin (`@bhzhangsun/dsh-media`) that gives the agent a `media_render` tool. It resolves a local or remote media file, serves it over DSH's own webserver (`/media/<token>`), and renders an HTML5 `<audio>`/`<video>` player in the conversation. The host side works; the client side produces the node and the player renders — but I'm hitting two DSH-side gaps around *where* the player shows up and whether it stays visible to the user.

**Ask 1 — inline agent-side content in the final assistant message**

The player is rendered as a chat node driven by the tool's `output.presentationMeta` (`meta.dshMedia`) on the known `tool/result` event, and materialized into `conversation.chat.node` (`audio` / `video`). That works, but the final message body (`AssistantMarkdown`) only renders `text` / `reasoning` / `image` / `tool-call` / `other`; `other` falls back to a JSON block and there is no pluggable inline media block. So there is no way for the agent to surface a playable audio/video *inside* its answer message text (where the user actually reads the reply).

This is the same gap as https://github.com/deepseek-ai/deepseek-harness/discussions/2995 ("agent-emitted images inline in assistant messages"), but for audio/video produced by a tool. If the "assistant-side inline rich content / attachments" capability lands, it would be ideal if it covered media (audio/video) as well as images.

**Ask 2 — tool-result chat nodes are folded into the "N tool calls" disclosure**

Because the media node is a `tool/result`-driven node anchored in the turn's process window, in compact-transcript mode it is treated as a "turn process member" and folded into the collapsible `N 次工具调用` (`TurnProcessNodeView`) disclosure. The player only shows once the user expands it; the final answer text is visible but the media is hidden. Effectively "the rendered media isn't in the user-visible result unless they click expand."

**Why a plugin can't work around Ask 2**

The fold-membership decision uses `TURN_PROCESS_INDEPENDENT_KINDS` (a `Set` of chat-node kinds that stay out of the process disclosure). It is declared as an exported `const` in the shipped `d.ts` (`turn-process.d.ts`), but at runtime the bundle does **not** actually export it — I inspected `client.js` and the only runtime exports are `EMPTY_CHAT_SNAPSHOT`, `apply`, `inject`, `isRunningTool`, `isSettledTool`. So a plugin cannot `import`/mutate it, and there is no service, config, or slot seam to opt a node kind out of the fold. The only current mitigation is the transcript view being in non-compact (full) mode.

**Proposed direction**

- Treat chat-node kinds a plugin registers (e.g. `audio` / `video`) as eligible to opt out of the turn-process disclosure, in a way that is reachable/extensible from a plugin (export the set, or expose a registration seam), **or**
- Provide an inline assistant-content channel for rich/attachment blocks (extending #2995 to media), so `media_render` output can render inside the final answer message rather than as a foldable tool-result node.

**Environment**

- `@deepseek-ai/*` packages at `0.1.2-rc.1`
- DSH Desktop Beta (macOS arm64)
- Plugin: `@bhzhangsun/dsh-media`, using `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-client-ui-chat`, `@deepseek-ai/dsh-client-ui-conversation`

Happy to provide a minimal repro plugin or more details.
