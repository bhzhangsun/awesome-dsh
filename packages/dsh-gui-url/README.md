# @bhzhangsun/dsh-gui-url

一个模型工具 `gui_url`：返回**本进程** DSH Web GUI 的带 token 访问地址，让 agent 自己去
浏览器里核对界面，而不必每次重启后请人粘贴一遍地址。

## 它解决什么

DSH Web GUI 每次重启都会换一个新 token，于是「请 agent 帮我看看界面」这件事每次都要人工
粘贴 `http://127.0.0.1:<port>/?token=<…>`。

这个 token **不可能从磁盘上找回来**：

```js
function processLaunchToken(owner) {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)   // WeakMap
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
}
```

`randomBytes` 生成、只活在 WeakMap 里。所以日志或任何残留文件里捡到的 token 必定属于
**某个已死进程**，配的端口也是死端口——拿它访问只会得到 `401 dsh web authentication required`。

而**活着的进程自己知道**这两半：

```
ctx.webServer.port                      它实际监听的端口
ctx.connection.authenticatedUrl(base)   本进程的 token
```

本插件把它做成一个模型工具：**用的时候调，值就是当下的**。

## 为什么是工具，而不是写一个文件

第一版是"启动时把地址写到一个文件"。它可以工作，但有一个无法消除的失败方式：

> 一个过期的文件和一个有效的文件**长得完全一样**。

读的人无法分辨，只能靠"记得它可能是旧的"来防御——而 agent 每轮都是新的，没有这个记忆。

工具没有这个状态：它要么回答，要么明确说自己现在答不了。三种明确的回答：

| 情况 | 返回 |
| --- | --- |
| 正常 | 地址 + 一句说明 |
| 服务器还没开始监听 | `the web server is not listening yet; retry in a moment`（**不给地址**） |
| 该 profile 没有 Web GUI | `this profile has no Web GUI (webServer/connection unavailable)` |

第二条尤其重要：如果那时给一个地址，就是把「还没到时候」伪装成「地址就是这样」。

## 依赖为什么钉死版本，而不是跟本仓约定写 `*`

本仓其他插件把 DSH 包写成 `"@deepseek-ai/dsh-tools": "*"`（`dependencies`）配一个钉死的
`devDependencies`。**这里不行**，实测：

```
'*'             → 解析到 @deepseek-ai/dsh-tools@0.0.1-rc.1
                  该版本 import 即失败：
                  SyntaxError: The requested module '@deepseek-ai/dsh-llm'
                  does not provide an export named 'CallId'
'0.1.2-rc.1'    → 正常
```

也就是说这个包的 `*` 会装进一个**连加载都失败的版本**。所以这里在 `dependencies` 里直接
钉死。`defineTool` 不是可以手搓的空壳（它把参数 spec 转成 JSON Schema 并校验入参），
所以这个依赖不能省。

> ⚠️ 同一个坑对本仓其他包也成立：一旦 lockfile 被重建，它们的 `*` 也可能落到那个坏版本上。
> 现在没炸只是因为 lockfile 里存着早已解析好的 `0.1.2-rc.1`。

## 安装

由 profile 引入（host 平面的一行，因为要读的 `webServer` 与 `connection` 都只存在于宿主进程）：

```json
"dsh": { "profile": { "bundles": ["@bhzhangsun/dsh-gui-url"] } },
"dependencies": {
  "@bhzhangsun/dsh-gui-url": "link:/path/to/packages/dsh-gui-url"
}
```

然后 `pnpm install`，重启。

## 工具

`gui_url`，无参数。描述里明确告诉模型：

> The token in the URL is minted per process, so it CHANGES ON EVERY RESTART: never reuse a
> URL you saw earlier in the conversation, and never try to find one in a log or a leftover
> file -- those belong to dead processes and will return 401.

## 边界

- 只读本进程内**已经存在**的两个宿主服务，不写文件、不联网、不起子进程、不持有凭证。
- 工具本身不抛异常；拿不到就明确说拿不到。

## 测试

```
npm test
```
