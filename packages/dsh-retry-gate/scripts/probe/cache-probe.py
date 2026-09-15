#!/usr/bin/env python3
"""探测 token-hub 的上下文缓存口径：重复前缀是否命中 cached_tokens。

成本约 3 次 × 4k tokens，可忽略。只读 usage，不打印密钥。
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

CRED = Path.home() / ".dsh" / ".credentials.yaml"
URL = "https://tokenhub.tencentmaas.com/v1/chat/completions"
MODEL = "deepseek/deepseek-v4-flash"


def api_key() -> str:
    m = re.search(r"^\s*TOKEN_HUB_API_KEY:\s*(\S+)\s*$", CRED.read_text(), re.M)
    if not m:
        sys.exit("no TOKEN_HUB_API_KEY in credentials")
    return m.group(1)


def call(key: str, prompt: str, tag: str) -> dict:
    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 8,
        "temperature": 0,
    })
    out = subprocess.run(
        ["curl", "-sS", "-X", "POST", URL,
         "-H", f"Authorization: Bearer {key}",
         "-H", "Content-Type: application/json",
         "--max-time", "120", "-d", payload],
        capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    if "error" in data:
        print(f"[{tag}] ERROR {data['error'].get('code')} {data['error'].get('message_zh', '')[:80]}")
        return {}
    u = data.get("usage", {})
    print(f"[{tag}] prompt={u.get('prompt_tokens')} completion={u.get('completion_tokens')} "
          f"total={u.get('total_tokens')} details={u.get('prompt_tokens_details')}")
    return u


def main() -> None:
    key = api_key()
    # 构造一个 ~4k token 的稳定前缀（约 16k 字符，按 chars/4 估）
    prefix = "\n".join(
        f"line {i:04d}: the quick brown fox jumps over the lazy dog number {i * 7 % 9973}"
        for i in range(200)
    )
    print(f"prefix chars={len(prefix)} (~{len(prefix) // 4} tokens)")

    print("\n-- 第 1 次：写入缓存 --")
    u1 = call(key, prefix + "\n\nReply with exactly one word: alpha", "cold")
    time.sleep(4)  # 给缓存落盘留时间

    print("\n-- 第 2 次：同前缀，换后缀 --")
    u2 = call(key, prefix + "\n\nReply with exactly one word: beta", "warm")
    time.sleep(1)

    print("\n-- 第 3 次：再次确认稳定性 --")
    u3 = call(key, prefix + "\n\nReply with exactly one word: gamma", "warm2")

    c2 = (u2.get("prompt_tokens_details") or {}).get("cached_tokens")
    c3 = (u3.get("prompt_tokens_details") or {}).get("cached_tokens")
    print("\n=== 结论 ===")
    if c2 or c3:
        print(f"命中缓存：cached_tokens = {c2} / {c3} -> 该路由支持前缀缓存，"
              f"预热后约 {(c2 or 0) / max(u2.get('prompt_tokens', 1), 1):.0%} 输入可缓存")
    else:
        print("cached_tokens 始终为 0 -> 该路由（当前套餐/模型）不提供前缀缓存收益")


if __name__ == "__main__":
    main()
