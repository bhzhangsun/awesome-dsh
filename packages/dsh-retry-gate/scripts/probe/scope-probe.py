#!/usr/bin/env python3
"""决定性实验：限额按模型独立，还是跨模型共享？

在 deepseek/deepseek-v4-flash 上打爆 RPM(60)，然后立刻探测
deepseek/deepseek-v4-flash-vision-exp 与 kimi-k3。

若 A 限流而 B 正常 → 按模型独立；若 B 也 429 → 共享。
会测量真实请求密度（任意 60s 窗口内的请求数），避免"其实没打爆"的误判。
"""
import json
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

URL = "https://tokenhub.tencentmaas.com/v1/chat/completions"
TARGET = "deepseek/deepseek-v4-flash"
OTHERS = ["deepseek/deepseek-v4-flash-vision-exp", "kimi-k3"]
CRED = Path.home() / ".dsh" / ".credentials.yaml"


def key() -> str:
    return re.search(r"^\s*TOKEN_HUB_API_KEY:\s*(\S+)\s*$", CRED.read_text(), re.M).group(1)


def call(k: str, model: str) -> tuple[float, int, str]:
    t0 = time.time()
    payload = json.dumps({"model": model, "messages": [{"role": "user", "content": "hi"}],
                          "max_tokens": 1})
    p = subprocess.run(
        ["curl", "-sS", "-w", "\n%{http_code}", "-X", "POST", URL,
         "-H", f"Authorization: Bearer {k}", "-H", "Content-Type: application/json",
         "--max-time", "90", "-d", payload], capture_output=True, text=True)
    parts = p.stdout.rsplit("\n", 1)
    code = int(parts[-1]) if parts[-1].strip().isdigit() else 0
    return time.time() - t0, code, (parts[0] if len(parts) > 1 else "")


def brief(raw: str) -> str:
    try:
        d = json.loads(raw)
    except Exception:
        return raw[:80]
    if d.get("error"):
        e = d["error"]
        return f"{e.get('code')} {str(e.get('message_zh') or e.get('message'))[:70]}"
    return f"OK total={d.get('usage', {}).get('total_tokens')}"


def density(times: list[float]) -> int:
    """任意 60 秒窗口内的最大请求数。"""
    ts = sorted(times)
    best = 0
    j = 0
    for i, t in enumerate(ts):
        while ts[i] - ts[j] > 60:
            j += 1
        best = max(best, i - j + 1)
    return best


def main() -> None:
    k = key()
    print("1) 基线")
    _, code, raw = call(k, TARGET)
    print(f"   {TARGET}: {code} {brief(raw)}")

    print(f"\n2) 高并发打爆 {TARGET} 的 RPM(60) —— 180 个请求 / 45 并发")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=45) as ex:
        res = list(ex.map(lambda _: call(k, TARGET), range(180)))
    elapsed = time.time() - t0
    times = [t0 + d for d, _, _ in [r for r in res]]
    codes = {}
    first_429 = None
    for d, c, raw in res:
        codes[c] = codes.get(c, 0) + 1
        if c == 429 and first_429 is None:
            first_429 = brief(raw)
    print(f"   耗时 {elapsed:.1f}s，状态码分布 {codes}")
    print(f"   峰值密度 ≈ {density(times)} 请求/60s")
    if first_429:
        print(f"   首个 429: {first_429}")

    print("\n3) 立刻探测【其他模型】")
    verdict = {}
    for m in OTHERS:
        _, c, raw = call(k, m)
        verdict[m] = c
        print(f"   {m:<42} {c} {brief(raw)}")

    print(f"\n4) 回头确认 {TARGET}")
    _, c2, raw2 = call(k, TARGET)
    print(f"   {TARGET}: {c2} {brief(raw2)}")

    print("\n=== 判定 ===")
    if c2 == 429 and all(v == 200 for v in verdict.values()):
        print("A 仍限流、B/C 全通 → 限流【按模型独立】计算")
    elif c2 == 429 and not all(v == 200 for v in verdict.values()):
        print("A 与 B/C 同时限流 → 限流【跨模型共享】（账号或 Key 级）")
    elif c2 != 429:
        print(f"A 未被限流（密度 {density(times)} 未达 60）→ 本次未打爆，结论无效")


if __name__ == "__main__":
    main()
