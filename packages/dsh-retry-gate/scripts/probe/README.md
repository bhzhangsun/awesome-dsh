# 限流探测脚本（probe）

这三个脚本**绕过 DSH、直接打供应商 HTTP**。这不是偷懒，而是唯一可行的办法——
闸门的存在就是为了让调用撞不到真实限额，所以**在 DSH 内部测不出真实阈值**。
要定「额度是多少、按什么口径算、按模型还是按账号」，只能绕过它。

密钥从 `~/.dsh/.credentials.yaml` 的 `TOKEN_HUB_API_KEY` 读取（与 DSH 用同一份），
脚本内**没有任何硬编码凭证**。

| 脚本 | 回答什么问题 | 成本 |
|---|---|---|
| `scope-probe.py` | 限额按模型独立，还是跨模型共享？ | ~70 次请求（很小，用便宜的 RPM 门槛做探针） |
| `cache-probe.py` | 重复前缀是否命中 `cached_tokens`；缓存按什么口径计入 TPM | 3 次 × 4k token，可忽略 |
| `infer-tpm.py` | 从历史会话日志反推 TPM 口径：`totalTokens`（含缓存）还是 `input+output`（不含）与 429 前的窗口峰值吻合 | 只读本地日志，零成本 |

```sh
cd packages/dsh-retry-gate/scripts/probe
python3 scope-probe.py        # 会真的把目标模型的 RPM 打爆，几分钟内自愈
python3 infer-tpm.py          # 纯本地分析，随时可跑
```

## 关于版本

`infer-tpm.py` 与 `scope-probe.py` 都是**第二版**。第一版按「会话主模型」给
usage 事件归因，切换过模型的会话会把结果污染掉；第二版改为按
「同 turn/step 的下一条 assistant 消息」逐条配对。第一版已删除——保留一个
已知有缺陷的脚本只会让人误用。

## `raw/` 是抓包证据

`h429_*.txt`（4 份 429 响应）与 `h_*.txt` / `b_*.json`（200 响应）是
「**429 与 200 响应都不带任何限流头部**」这一结论的原始证据——正因为拿不到
`Retry-After`，闸门才必须自己记账并自行兜底计算等待时间。
