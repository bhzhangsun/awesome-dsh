# 预览图（archify 生成）

三张图都由 [Archify](https://github.com/tt-a1i/archify) 的 `showcase` 档位生成，
每张都通过 9 项 artifact 检查 + 0 error / 0 warning。HTML 是**单文件、内联 SVG**，
双击即可打开，支持深浅色主题与 PNG/SVG 导出。

唯一的外部请求是 Google Fonts 的 JetBrains Mono（等宽字体）。字体栈带了完整的本地回退
（`ui-monospace, SFMono-Regular, Menlo, PingFang SC, Hiragino Sans GB, Microsoft YaHei, monospace`），
所以离线打开只是字形回退，版式与换行不受影响。

| 图 | 类型 | 讲什么 |
|---|---|---|
| `gate-architecture.html` | architecture | 闸门在调用链的位置、HOST 平面、按模型分桶的账本、与 `llm-retry` 的分工边界 |
| `gate-retry-sequence.html` | sequence | 一次 429 的完整回路：为什么「重试 5 次全败」变成「一次等到窗口恢复」，以及隔壁模型不受影响 |
| `gate-admission.html` | workflow | 闸门对每一次模型调用的判定：估算 → 查三本账 → 等待或直接过 → 放行并结算 |

## 重新生成

渲染器来自 web profile 的 archify skill bundle（本仓库不内置），所以先确认它的位置：

```sh
SKILL="$HOME/.dsh/profiles/web/node_modules/@tt-a1i/archify-dsh/skills/archify"
node "$SKILL/bin/archify.mjs" doctor        # 应输出 "Archify is ready."
```

然后逐张校验 / 交付（`validate` 只校验，`deliver` 落盘 HTML）：

```sh
cd packages/dsh-retry-gate/docs/preview
for t in architecture sequence workflow; do
  node "$SKILL/bin/archify.mjs" validate "$t" "specs/gate-$( [ $t = architecture ] && echo architecture || ([ $t = sequence ] && echo retry-sequence || echo admission) ).$t.json" --quality showcase
done
```

更直白地逐条敲：

```sh
node "$SKILL/bin/archify.mjs" deliver architecture specs/gate-architecture.architecture.json   gate-architecture.html   --quality showcase
node "$SKILL/bin/archify.mjs" deliver sequence     specs/gate-retry-sequence.sequence.json     gate-retry-sequence.html --quality showcase
node "$SKILL/bin/archify.mjs" deliver workflow     specs/gate-admission.workflow.json          gate-admission.html      --quality showcase
```

## 改图时的两条约束

这两条是从渲染器实现里读出来的，不遵守必定校验失败：

1. **列坐标是交错的**：`colXs = [88, 220, 300, 430, 500, 625]`，列间距依次是
   132 / 80 / 130 / 70 / 125。节点默认宽 92，所以 `1→2` 和 `3→4` 是**窄间隔**，
   同泳道内相邻两列放节点会重叠。同泳道链式只能走 `0→1`、`2→3`、`4→5`，跨间隔
   只能跳列（如 `1→3`、`3→5`）。
2. **一个 (lane, col) 单元格只能放一个节点**，workflow 不会自动堆叠。

另外 workflow 的纵向扇入（同一列三条边汇入）会让下行的垂直段贴着下方节点右边缘
擦过（实测 2px 间隙），所以三本账被合并成一个 `ledger` 节点，细节放在 sublabel 与卡片里。
