# 实测事实：token-hub 的限流口径

本文件记录的每个数字都来自**真实观测**，不是文档推断。后续实现决策以这里的
事实为准；若某条被推翻，请连同证据一起更新本文件。

探测脚本已收进本包 `scripts/probe/`（它们必须绕过闸门才能测到真实限额），可复跑：

| 脚本 | 用途 |
|---|---|
| `cache-probe.py` | 前缀缓存是否命中（对照三次调用的 `cached_tokens`） |
| `scope-probe2.py` | 限额是按模型还是按账号（打爆 A 后立刻探 B/C） |
| `infer-tpm2.py` | 从全部会话日志反推 TPM 计费口径 |
| `infer-tpm.py` | 早期版本，按会话主模型归因，精度较低，保留作对照 |

---

## 1. 额度按【模型】独立计算

**结论：per-model。不是账号级，也不是 provider 级。**

在 `deepseek/deepseek-v4-flash` 上以 45 并发打 180 个请求，2.7 秒内完成
（峰值密度 180 请求/60s），**同一时刻**探测另外两个模型：

| 模型 | 结果 |
|---|---|
| `deepseek/deepseek-v4-flash` | **429**（429001，超过 RPM 阈值 60） |
| `deepseek/deepseek-v4-flash-vision-exp` | 200 OK |
| `kimi-k3` | 200 OK |

旁证：`glm-5.3` 返回 402「**该服务**免费体验额度已耗尽」，而 `glm-5.3-flash`
正常 200 —— 配额账本同样按模型/服务分记。

**实现含义**：闸门的桶键是 `model`。顺带一个立刻可用的缓解手段——既然按模型独立，
把并发会话与子代理**分流到不同模型**就是实打实的扩容。

---

## 2. 每个模型有两个门槛：TPM 1,000,000/min 与 RPM 60/min

从 503 次历史 `RATE_LIMIT` 失败的报错文案里直接提取：

| 报错文案 | 次数 |
|---|---|
| `The request rate exceeds the current model TPM limit 1000000` | 414 |
| `The request rate exceeds the current model RPM limit 60` | 38 |
| `429006 The model service is currently busy or has reached...` | 2 |

**每个模型报出的 TPM 上限都是 1000000** —— 包括 `flash`、`flash-vision-exp`、
`kimi-k2.7-code-highspeed`。

`429006` 是第三种、也是最无奈的一种：平台侧容量饱和。自己怎么调度都没用。

**实现含义**：闸门必须双账本。RPM 60/min = **每模型 1 请求/秒**，并发会话一多，
RPM 比 TPM 更早撞线；而一个会话的 5 次重试就是 5 个请求，重试在 RPM 维度上是纯放大器。

---

## 3. 缓存命中【计入】TPM

**这条推翻了一个很自然的假设：前缀缓存不能换 TPM 额度。**

先用 `cache-probe.py` 确认缓存确实生效——同一段 ~3,300 token 的前缀连发三次：

| 次序 | prompt_tokens | cached_tokens |
|---|---|---|
| 冷 | 3694 | 0 |
| 温 | 3694 | **3456**（94%） |
| 温 | 3694 | **3456** |

再用 `infer-tpm2.py` 反推计费口径：解析全部 74 份会话日志，取 5,183 条真实
`usage` 事件（含 `totalTokens`、`cacheReadTokens`）与 286 次 429 的时间戳，
对每次 429 统计**同一模型**在其前 60 秒窗口内的 token 量：

| 模型 | 429 次数 | 含缓存中位 | 不含缓存中位 |
|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 210 | **1,028,608**（103%） | 58,905 |
| `kimi-k2.7-code-highspeed` | 14 | **913,430**（91%） | 5,682 |

含缓存口径稳定贴合 1,000,000；不含缓存口径只有 5% 量级，**不可能是计费基础**。

> 保留意见：`deepseek/deepseek-v4-flash-vision-exp` 的重建窗口是 2.2M（222%），
> 但它报出的上限同样是 1,000,000。该模型的重建值偏高，原因未查明（怀疑图像 token
> 在限流侧与 `usage` 侧的计价权重不同）。因此**不要**把重建值当精确额度用——
> 它只用来判定"哪个口径更贴近上限"。

**实现含义**：账本记 `totalTokens`，不做任何缓存折扣；减量只能靠真压 prompt、
压步数、分流模型。

---

## 4. 429 带 `Retry-After: 60`，但没有限流响应头

- **200 响应**：没有任何 `x-ratelimit-*` 头，只有 `X-Request-Id`。
  → 剩余额度不可见，闸门只能自记账 + 用 429 反馈纠正。
- **429 响应**：
  ```
  HTTP/1.1 429 Too Many Requests
  Retry-After: 60
  ```

**框架侧的两个坑**（这是"重试永远无效"的真正原因）：

1. `dsh-llm-pi-ai`（token-hub 走的适配器）**完全不读** `retry-after`——
   全文 grep 零命中。对照组 `dsh-llm-deepseek/lib/index.js:1786` 是读的。
2. `dsh-llm-retry/lib/index.js:168-172`：`normal` 模式下若
   `providerRetryAfterMs > policy.maxDelayMs`，直接 `return next()` = **放弃重试**。
   默认 `maxDelayMs = 10_000`，而真实值是 `60_000`。

于是现状是：

| 路由 | 读头？ | 429 时的实际行为 |
|---|---|---|
| `token-hub`（pi-ai） | 否 | 盲目退避 5 次，累计 ≈15.5s，全部落在同一个 60s 窗口内，全败 |
| `deepseek-official` | 是 | 60s > 10s 上限 → 放弃，**零重试** |

`settings.yaml` 里 `retryPolicy` 出现次数为 **0**，两条路由都在跑默认值。

**实现含义**：闸门应把限流类失败从 `llm-retry` 手里接管过来（`prepend` +
不调 `next()`），等待时间**优先用 `providerRetryAfterMs`，缺失则自行计算兜底**。
这样既不需要改 pi-ai 源码，也不需要动 `retryPolicy`。

---

## 5. 参考：模型 id 的两个命名空间

同一份额度口径下存在两套 id，容易混淆：

| 前缀 | provider | 例子 |
|---|---|---|
| `deepseek/...` | `token-hub`（腾讯 MaaS，OpenAI 兼容） | `deepseek/deepseek-v4-flash` |
| 无前缀 | `deepseek-official`（DeepSeek 官方） | `deepseek-v4-flash` |

子代理的 `subagent-model-selection.allowedModels` 里列的是 `deepseek-official` 的
flash / pro / flash-vision —— 也就是说**两条路由都在实际使用中**，改动要同时考虑。
