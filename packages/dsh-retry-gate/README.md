# @bhzhangsun/dsh-retry-gate

按模型分桶的 **TPM/RPM 准入闸门**：在请求发出**之前**做全局排队，而不是让每个会话
各自发出去撞 429、再各自盲目重试。

> 名字里的 `retry` 是刻意的：它不是要取代重试执行器，而是与
> `@deepseek-ai/dsh-llm-retry` **分工**——闸门负责"什么时候该发"，重试负责
> "失败了怎么办"。

## 为什么需要它

现有重试是**每会话独立、事后**的。它不知道这一分钟全局烧了多少 token，也不知道
别的会话正在同一秒重试。并发会话一多：

1. 每个会话各自退避、各自重发**整个 prompt** → 重试本身在制造下一次限流；
2. 默认退避上限 10s，而限流窗口是 60s → **数学上永远等不过去**；
3. RPM 60/min = 每模型 1 请求/秒，几个会话同时重试就撞线。

完整的实测依据见 [`docs/findings.md`](docs/findings.md)，要点：

- 额度**按模型**独立（打爆 A 模型时 B/C 同时可用）
- 每模型两个门槛：**TPM 1,000,000/min** 与 **RPM 60/min**
- 响应头**不暴露**剩余额度 → 只能自记账 + 靠 429 反馈纠正
- **缓存命中计入 TPM** → 前缀缓存换不来额度，只能换成本与延迟
- 429 带 `Retry-After: 60`，但 `dsh-llm-pi-ai` 不读这个头

## 设计

两个挂载点，职责严格分开：

| 挂载点 | 职责 | 关键点 |
|---|---|---|
| `llm/stream`（`global` + `prepend`） | 准入 · 结算 · 观测 429 | **唯一睡觉的地方**。每次 attempt 都穿过它（含重试的 attempt），等待发生在 attempt **内部**，因此**不消耗重试次数** |
| `agent/request-error`（`prepend`） | 接管 `RATE_LIMIT` | **只做决定，不睡觉**。记录全局冷却后立刻返回 `{ kind: 'retry' }`，真正的等待交给下一次 attempt |

非 `RATE_LIMIT` 的失败（`SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`）
一律 `next()` 交给 `dsh-llm-retry`，两套退避语义不打架。

控制回路：

```
估算输入 token ──┐
                 ├─→ 桶内查询 waitMs = max(冷却余量, TPM 排空时间, RPM 排空时间)
输出预留 ────────┘         │
                           ├─ 0 ──→ 放行，占用预留
                           └─ >0 ─→ 等（带抖动，可被 signal 取消）
                                     ↓
                        流末尾 usage chunk → 用真实值替换预留、退还差额
                        finish=RATE_LIMIT → 全局冷却 = Retry-After ?? 兜底 60s
```

**fail-open**：闸门自身任何异常、等待超预算、service 缺失，都放行。限流插件绝不能
变成全局单点故障。

### 额度是学出来的，不是假设出来的

`tpm` 配置**只是起点，不是真值**。原因是实测：同一个 provider、同一句
「TPM limit 1000000」的报错，`flash` 的触发点紧贴在 102%，而 `flash-vision-exp`
的触发点在 103%–324% 之间散开（3 倍跨度）。所以「按 TPM 的报错文案当额度」是靠不住的。

每个模型一个自学习状态（单位仍是 token，窗口仍是滑动的 60s）：

| 观测 | 含义 | 对策略的作用 |
|---|---|---|
| **429 时的窗口读数** | 真额度 **≤** 这个数（上界） | 取历史**最紧**的一次作为硬顶；每个窗口最多砍半一次 |
| 成功放行时的窗口读数 | 真额度 **>** 这个数（下界） | 不参与控制（见下），只用于诊断 |

规则（AIMD）：

```
放行条件:   窗口 + 本次预留  ≤  min(自学习额度, 最紧触发点) × safetyFactor
撞 429:     最紧触发点 ← min(历史, 本次读数)；额度 × 0.5  ← 每窗口最多一次
无 429 且 token 预算卡住过调用: 额度 × 1.05             ← 每窗口最多一次
```

四个刻意的约束，每条都对应一个踩过的坑：

- **取最紧的触发点，而不是第一次**。429 到来时账本读数会**过冲**（准入判断发生在
  用量落地之前），拿第一次当额度就是拿过冲值当额度，下一次照样撞。
- **每个窗口最多砍一次**。一场重试风暴会在同一秒里报 6 次 429，每次都砍半会让额度
  瞬间崩到没法用——**有效样本量是「起数」，不是「报错行数」**。
- **只有 token 预算真的卡住过调用才上探**——而且要分清是谁卡住的。一次纯 RPM 的
  等待（实测：token 窗口只有 780/850000）不能拿来证明 token 额度还有余量，否则
  一个只被 RPM 约束的模型会把 TPM 预算一路空涨上去。
- **空载期不上探**。否则每个窗口涨 5%，一天之后涨到离谱的值，等负载回来时一口气
  冲过真实额度，那不是自学习，是攒雷。

**下界为什么不参与控制**：它永远 ≤ 当前额度（能放行就说明没越线），所以它不可能
论证「还能更高」。想往上走只能靠那 5% 的主动试探——这跟 TCP 拥塞控制是同一个道理。

**学到的额度活不过一次重启**。账本在内存里，这是刻意的：持久化一份可能早已过期的
额度，比重学一遍更危险。代价是进程重启后额度回到配置的起点，要重新爬——按
5%/窗口的速率，从 1,000,000 爬到 1,480,000 需要 8 个窗口（实测：今天在持续负载下
正好用了 8 分钟）。所以**重启后的一段时间会明显比稳定态更容易被拦**，这不是故障。
它的真实用途是**检测账本漏记流量**：如果触发点比「曾经成功放行过的窗口」还低，
逻辑上不可能，说明同 key 的其他客户端在消耗同一个额度，此时上界不可信，会打一条警告。

## 配置

`cordis.patch.yml` 里已经给了可用的默认值。关键项：

| 项 | 默认 | 说明 |
|---|---|---|
| `defaultTpm` / `defaultRpm` | `1000000` / `60` | **只是起点**，之后由自学习修正（见上）。不是「真额度」 |
| `safetyFactor` | `0.85` | 只用 85% 额度，给预估误差留余量 |
| `fallbackCooldownMs` | `60000` | 429 未给 `Retry-After` 时的兜底冷却 |
| `maxWaitMs` | `120000` | 单请求等待上限，超过就放行（宁可撞一次 429，不挂死会话）。**别调大**：窗口只有 60s，等更久几乎没有收益，而每次等待在 UI 上都是静默的（见「可见性」） |
| `maxRetriesPerStep` | `6` | 本路径绕开了 `llm-retry` 的预算，自己管次数 |
| `outputReserveTokens` | `8192` | TPM 按 token 总量卡，输出也要预留 |
| `models` | `{}` | 按模型覆盖 `tpm` / `rpm` / `safetyFactor` |

行内校验：`maxWaitMs >= windowMs`，否则闸门永远等不过一个完整窗口，直接报错拒绝启动。

## 可见性（这个插件最容易出事的地方）

闸门等待期间**会话在 UI 上完全静默**：没有 chunk、没有事件、没有任何提示。
第一次上线时，远程会话出现的 20–25s 静默停顿就被当成了「会话静默中断」。

等待本身是对的——它把 429 挡在门外（这正是本插件存在的理由），
所以问题不是「不该等」，而是**等的时候必须留下痕迹**。三条日志覆盖全部路径：

```
[I] [dsh-retry-gate] 拦住本次调用，等 39ms（冷却中）— model=deepseek/... 窗口=851599/850000 token(+本次预留 150000) 额度估计=1000000(起点 1000000, 最紧触发点 未观测) rpm=6/60 冷却余=39ms
[I] [dsh-retry-gate] 放行（等了 20140ms）— model=deepseek/... 窗口=642732/850000 token(+本次预留 150000) 额度估计=1050000(起点 1000000, 最紧触发点 未观测) rpm=5/60 冷却余=0ms
[W] [dsh-retry-gate] 收到 429，冷却 60000ms（提供方 Retry-After=60000ms）— model=deepseek/... provider=token-hub turn=91 step=10
[W] [dsh-retry-gate] 429 反馈生效（agent/request-error），额度下调 2100000 → 1050000（最紧触发点 2222888）— model=deepseek/...
[I] [dsh-retry-gate] 额度上探 1050000 → 1102500（连续无 429，且预算确实卡住过调用）— model=deepseek/...
```

自学习的每一步都留痕：**上探**、**下调**、以及**触发点低于已成功放行过的窗口**
（= 账本很可能漏记了同 key 的其他客户端流量，上界不再可信）都会各打一条。

- **正常调用不打日志**，只有真的等过、或额度真的变过才记录，不会淹没日志。
- 日志落在 `~/Library/Application Support/DSH Desktop Beta/logs/dsh-<日期>.log`
  （格式 `[I] [<行 id>] <消息>`）。排查「会话为什么不动了」先看这里。

还有一个**必须**保留的保护：当 `本次预留 > 整个预算`（例如上下文极大，
估算输入 + `outputReserveTokens` 超过 `生效额度 × safetyFactor`）时，窗口再空也放不下
这次调用。早期实现在这种情况下会一路等到 `maxWaitMs` 耗尽才放行——**每一次调用
都白白烧满等待预算**，表现就是反复出现的长时间静默卡顿。现在这种预留会被识别、
跳过窗口等待并立即放行（附一条 `超过整个预算` 警告）——但**冷却照样要等**：
那是提供方下的暂停，不是窗口排空的估算，一起跳掉会让重试立刻撞回去。有回归用例
锁住这两条。

**仍然缺的**：会话内的实时状态指示（"正在等待限流，约 20s"）。这需要
Client 平面在某个 Slot 里渲染状态，目前只有日志可查。

## 安装

这是 **HOST 平面**的一行，不是 agent preset 的一行——额度按模型全局计算，所有会话
必须共用同一份账本；放进 preset 会退化成"每会话各算各的账"。

```sh
# 方式一：从 npm 安装（已发布：@bhzhangsun/dsh-retry-gate@0.1.0）
dsh plugin --profile desktop add @bhzhangsun/dsh-retry-gate

# 方式二：本地开发，link 进 profile（与 @bhzhangsun/dsh-media 同款）
#   1) 在 ~/.dsh/profiles/desktop/package.json 的 dependencies 加：
#        "@bhzhangsun/dsh-retry-gate": "link:/Users/bhzhangsun/Documents/studio/awesome-dsh/packages/dsh-retry-gate"
#   2) 在同一个文件的 dsh.profile.bundles 数组里加上 "@bhzhangsun/dsh-retry-gate"
#   3) 在 profile 目录执行 pnpm install，然后重启该 profile
```

本包**零运行时依赖**（不 import cordis / schemastery / zod），所以 link 安装不需要
额外装依赖。

## 测试

```sh
node --test test/*.test.js     # 或 pnpm test
```

`src/ledger.js` 是纯数据结构（无定时器、无 Cordis、无 I/O），26 个用例覆盖：
TPM 排空时间计算、预留不被重复计数、结算退还差额、无 usage 时释放、RPM 独立生效、
冷却只增不减、provider 级冷却兜底、按模型分桶互不影响、按模型覆盖配置，以及
**自学习的全部规则**（起点只是起点、取最紧触发点、每窗口最多砍一次、只被卡住过才上探、
空载不空涨、上探不越上界、下限防退化、漏记流量信号）。

`test/plugin.test.js` 20 个用例覆盖两个挂载点的契约、配置校验、透传/结算/释放、
失败归因、可见性回归（等待要留日志、fail-open 要留警告、预留超过预算不许烧满
`maxWaitMs` 但冷却仍要等），以及自学习的**接线**（观测真的写进了账本、上探/下调
真的留了日志）。合计 46 个用例。

## 当前状态与已知缺口

**已上线并验证**：已 link 进 desktop profile 并真实挂载运行（2026-09-15）。
启动行确认激活：

```
[I] [dsh-retry-gate] dsh-retry-gate: active (额度自学习=on 起点tpm=1000000 rpm=60 safety=0.85 window=60000ms maxWait=120000ms)
```

端到端行为也已从真实会话日志反推确认：闸门生效后，全局 60s 窗口占用达到
**100.2%** 的那次调用，TTFT 从历史中位 1.7s 拉长到 **24.8s**；占用 ≤95% 的
11 次调用则全部落在 1.3–6.4s。**相关性干净，且期间零 429、零错误事件。**

**已知缺口**：

1. **会话内的实时等待提示**（需要 Client 平面，见「可见性」）。
2. **一个异常偏低的触发点会永久收紧该模型**。最紧触发点只降不升，如果某次 429
   是日志外流量造成的（读数偏低），它会一直压着这个模型，极端情况下额度会低到
   放不下任何调用——此时闸门退化为「只等冷却、不等窗口」（fail-open 方向，不会
   挂死，但也不再限流）。目前只有警告可查，没有遗忘/衰减机制。
3. **上探速率是拍的**（5%/窗口）。偏慢的代价是多等几个窗口才摸到真实额度，
   偏快的代价是每撞一次要等一个完整冷却。等有了真实运行数据再定。


**待办**：

- [x] 端到端验证（TPM 路径）：已在真实会话中确认闸门按窗口占用等待。**未做**的是
      人为打爆一个没在用的模型的 RPM 60，验证 `llm/retry` → 等待 → 成功且不再撞 429。
- [ ] 可见性的下一步：会话内实时提示（Client 平面某个 Slot），目前只有日志。
- [ ] 诊断面：窗口用量 / 在途 / 冷却剩余 / 最近 429。等待路径已打日志；仍需一个
      随时可查的只读面（不发布 Service，避免和 isolate realm 规则纠缠）。
- [ ] 会话公平：目前只有排队，还没有"每会话在途 ≤ 1 + 会话间轮转"。
- [ ] 估计校准：用实测的 `estimateDrift` 自动修正 `outputReserveTokens`。
- [ ] 配置热更新：现在只能通过组合行配置（profile 的 `patchReload: live` 可热重载），
      后续换成 settings 命名空间更顺手。

## 与现有重试策略的关系（明确边界）

- **不做**的事：不改 `Retry-After` 的读取（pi-ai 缺这个头是适配器的事，且"某个模型
  有"不代表"别的模型有"）；不改 `retryPolicy`（限流已由本插件接管，不再走
  `llm-retry` 那条 `Retry-After > maxDelayMs → 放弃` 的路径）。
- **做**的事：接管 `RATE_LIMIT`，其余失败原样交给 `llm-retry`。
- 因此本插件的存在**不会**让 `llm-retry` 失效或重复等待：睡觉的地方只有一个。

## 预览图

`docs/preview/` 下有三张 archify 生成的交互式图（内联 SVG 单文件 HTML，可离线打开、
可导出 PNG/SVG）：

| 文件 | 类型 | 讲什么 |
|---|---|---|
| `docs/preview/gate-architecture.html` | architecture | 闸门在调用链的位置、HOST 平面、按模型分桶的账本、与 `llm-retry` 的分工边界 |
| `docs/preview/gate-retry-sequence.html` | sequence | 一次 429 的完整回路，以及为什么隔壁模型不受影响 |
| `docs/preview/gate-admission.html` | workflow | 逐次模型调用的判定：估算 → 查三本账 → 等待或直接过 → 放行并结算 |

三张图都以 archify 的 `showcase` 档位通过全部 9 项 artifact 检查、0 error / 0 warning。
spec 在同目录 `specs/`，重新生成的命令与改图时必须遵守的布局约束见
[`docs/preview/README.md`](docs/preview/README.md)。

## 参考

**重启后怎么确认它真的活了**：host 插件的 `ctx.logger.info` 落在
`~/Library/Application Support/DSH Desktop Beta/logs/dsh-<日期>.log`，格式是
`[I] [<行 id>] <消息>`。启动序列以 `--- dsh-plugin-desktop-beta … run <ts> ---` 分隔，
搜这一行即可：

```sh
grep "dsh-retry-gate: active" "$HOME/Library/Application Support/DSH Desktop Beta/logs/dsh-$(date +%F).log"
```

看到 `dsh-retry-gate: active (额度自学习=on 起点tpm=1000000 rpm=60 safety=0.85 window=60000ms maxWait=120000ms)`
就说明这一行已经激活、账本已就绪。

**让它跑着看的时候，用这个代替肉眼翻日志**：

```sh
python3 scripts/gate-report.py                 # 汇总最近一次启动以来每个模型的状态
python3 scripts/gate-report.py --since 14:25   # 再按时间截断
```

输出每个模型的：等待次数与总等待时长、等待原因（窗口将满 / 冷却中）、当时预算区间、
额度上探与下调的每一步，以及「预留超预算」「fail-open」「疑似漏记流量」这几类异常。
**它按最近一次启动自动截断**——跨重启累加会得出错误结论（账本是进程内的，重启即清空）。

- 实测事实与探测脚本：[`docs/findings.md`](docs/findings.md)
- 上游契约：`@deepseek-ai/dsh-llm`（`retry-policy.js`、`llm/stream` 事件）、
  `@deepseek-ai/dsh-llm-retry`（`agent/request-error` 恢复流程）、
  `@deepseek-ai/dsh-agent-loop`（`lib/index.js:660-670` 的 action 判定）

## License

MIT