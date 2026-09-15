#!/usr/bin/env python3
"""改进版：usage 事件按"同 turn/step 的下一条 assistant/message"精确归属模型。

上一版按"会话主模型"归因，把切换过模型的会话污染了。这里逐条配对。
仍只读本地日志。
"""
import json
import statistics
import subprocess
from collections import defaultdict
from pathlib import Path

SESSIONS = Path.home() / ".dsh" / "sessions"
WINDOW_MS = 60_000
LIMIT = 1_000_000


def events(path: Path):
    raw = subprocess.run(["zstd", "-dc", str(path)], capture_output=True).stdout
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def main() -> None:
    usage = []   # (time, model, total, noncached)
    limits = []  # (time, model)

    for path in SESSIONS.rglob("session.jsonl.zstd"):
        evs = list(events(path))
        if not evs:
            continue
        # (turn, step) -> model，取自 assistant/message
        step_model: dict[tuple, str] = {}
        for ev in evs:
            if ev.get("type") != "assistant/message":
                continue
            d = ev.get("data") or {}
            src = (d.get("message") or {}).get("source") or {}
            if src.get("model") and d.get("turn") is not None:
                step_model[(d.get("turn"), d.get("step"))] = src["model"]

        for ev in evs:
            d = ev.get("data") or {}
            ch = d.get("chunk") or {}
            t = ev.get("time")
            if not isinstance(t, int):
                continue
            model = step_model.get((d.get("turn"), d.get("step")))
            if model is None:
                continue
            if ch.get("type") == "usage":
                u = ch.get("usage") or {}
                usage.append((t, model, u.get("totalTokens") or 0,
                              (u.get("inputTokens") or 0) + (u.get("outputTokens") or 0)))
            elif ch.get("type") == "finish":
                r = ch.get("reason") or {}
                if r.get("kind") == "error" and (r.get("failure") or {}).get("code") == "RATE_LIMIT":
                    limits.append((t, model))

    by_model = defaultdict(list)
    for rec in usage:
        by_model[rec[1]].append(rec)
    for lst in by_model.values():
        lst.sort()

    grouped = defaultdict(list)
    for t, model in limits:
        w = [r for r in by_model[model] if t - WINDOW_MS <= r[0] <= t]
        if w:
            grouped[model].append((sum(r[2] for r in w), sum(r[3] for r in w)))

    print(f"usage {len(usage)} 条 / RATE_LIMIT {len(limits)} 次\n")
    print(f"{'模型（精确归属）':<40}{'429数':>7}{'含缓存中位':>13}{'含缓存p90':>12}{'不含缓存中位':>14}{'贴近度':>9}")
    for m, rows in sorted(grouped.items(), key=lambda kv: -len(kv[1])):
        tot = sorted(r[0] for r in rows)
        non = sorted(r[1] for r in rows)
        med = statistics.median(tot)
        p90 = tot[min(len(tot) - 1, int(len(tot) * 0.9))]
        print(f"{m:<40}{len(rows):>7}{med:>13,.0f}{p90:>12,.0f}"
              f"{statistics.median(non):>14,.0f}{med / LIMIT:>8.0%}")

    print("\n解释：含缓存中位数若贴近 100%，说明该模型的 TPM 上限就是 1,000,000/分钟，")
    print("且缓存命中【计入】该额度；不含缓存一列若远低于上限则不可能是计费口径。")


if __name__ == "__main__":
    main()
