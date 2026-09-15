#!/usr/bin/env python3
"""dsh-retry-gate 运行状态汇总。

"让它跑着看"需要一个仪器：日志是逐行的，而这个脚本把闸门的自学习状态、
等待代价、上探/下调次数按模型汇总出来，便于跨天对比。

用法：
    python3 scripts/gate-report.py                 # 最近一次启动以来的全部
    python3 scripts/gate-report.py --since 14:25   # 只看某个时间点之后
    python3 scripts/gate-report.py --date 2026-09-16

只读日志，不接触运行中的进程。
"""

import argparse
import datetime
import os
import re
import sys
from collections import defaultdict

DEFAULT_LOG_DIR = os.path.expanduser("~/Library/Application Support/DSH Desktop Beta/logs")

RE_ACTIVE = re.compile(r"^(\S+ \S+) \[I\] \[dsh-retry-gate\] dsh-retry-gate: active \((.*)\)$")
RE_BOOT = re.compile(r"^--- .* run (\d+) ---$")
RE_WAIT = re.compile(r"^(\S+ \S+) .*拦住本次调用，等 (\d+)ms（([^）]*)）— model=(\S+).*?窗口=(\d+)/(\d+) token")
RE_RELEASE = re.compile(r"^(\S+ \S+) .*放行（等了 (\d+)ms）— model=(\S+)")
RE_RAISE = re.compile(r"^(\S+ \S+) .*额度上探 (\d+) → (\d+)（.*）— model=(\S+)")
RE_CUT = re.compile(r"^(\S+ \S+) .*429 反馈生效（([^）]*)），额度下调 (\d+) → (\d+)（最紧触发点 (\S+)）— model=(\S+)")
RE_COOLDOWN = re.compile(r"^(\S+ \S+) .*收到 429，冷却 (\d+)ms")
RE_CONFLICT = re.compile(r"^(\S+ \S+) .*漏记了同 key.*model=(\S+)")
RE_TOOBIG = re.compile(r"^(\S+ \S+) .*本次预留 (\d+) token 超过整个预算 (\d+).*model=(\S+)")
RE_FAILOPEN = re.compile(r"^(\S+ \S+) .*fail-open.*model=(\S+)")
RE_LIMIT = re.compile(r"额度估计=(\d+)\(起点 (\d+), ([^)]*)\)")


def parse_time(text):
    """'2026-09-15 14:30:46.181' -> datetime，失败则 None。"""
    try:
        return datetime.datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log-dir", default=DEFAULT_LOG_DIR)
    parser.add_argument("--date", default=None, help="默认今天")
    parser.add_argument("--since", default=None, help="HH:MM，只看这个时间之后")
    parser.add_argument("--all-boots", action="store_true", help="不按启动点截断")
    args = parser.parse_args()

    date = args.date or datetime.date.today().isoformat()
    path = os.path.join(args.log_dir, f"dsh-{date}.log")
    if not os.path.exists(path):
        print(f"找不到日志：{path}", file=sys.stderr)
        return 1

    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()

    # 最近一次启动的位置：进程重启会清空账本，跨重启累加会得出错误结论。
    boot_index = 0
    boot_stamp = None
    if not args.all_boots:
        for index, line in enumerate(lines):
            match = RE_BOOT.match(line)
            if match:
                boot_index = index
                boot_stamp = datetime.datetime.fromtimestamp(int(match.group(1)) / 1000)
    scope = lines[boot_index:]
    since = None
    if args.since:
        today = datetime.date.today()
        hour, minute = (int(part) for part in args.since.split(":"))
        since = datetime.datetime.combine(today, datetime.time(hour, minute))

    waits = defaultdict(list)
    raises = defaultdict(list)
    cuts = defaultdict(list)
    cooldowns = defaultdict(list)
    conflicts = defaultdict(list)
    too_big = defaultdict(int)
    fail_opens = defaultdict(int)
    active = None

    for line in scope:
        match = RE_ACTIVE.match(line)
        if match:
            active = (match.group(1), match.group(2))
            continue
        match = RE_WAIT.match(line)
        if match:
            stamp = parse_time(match.group(1))
            if since and stamp and stamp < since:
                continue
            model, wait_ms, reason, budget = match.group(4), int(match.group(2)), match.group(3), int(match.group(6))
            waits[model].append((wait_ms, reason, budget))
            continue
        match = RE_RAISE.match(line)
        if match:
            raises[match.group(4)].append((int(match.group(2)), int(match.group(3))))
            continue
        match = RE_CUT.match(line)
        if match:
            cuts[match.group(6)].append((int(match.group(3)), int(match.group(4)), match.group(5)))
            continue
        match = RE_COOLDOWN.match(line)
        if match:
            cooldowns["(provider 级)"].append(int(match.group(2)))
            continue
        match = RE_CONFLICT.match(line)
        if match:
            conflicts[match.group(2)].append(match.group(1))
            continue
        match = RE_TOOBIG.match(line)
        if match:
            too_big[match.group(4)] += 1
            continue
        match = RE_FAILOPEN.match(line)
        if match:
            fail_opens[match.group(1)] += 1

    print(f"日志      : {path}")
    if boot_stamp and not args.all_boots:
        print(f"统计起点  : {boot_stamp:%Y-%m-%d %H:%M:%S}（最近一次启动，跨重启累加会得出错误结论）")
    if since:
        print(f"又截断到  : {since:%H:%M}")
    if active:
        print(f"激活版本  : {active[1]}")
    print()

    models = sorted(set(waits) | set(raises) | set(cuts) | set(too_big) | set(fail_opens))
    if not models:
        print("这段时间没有任何闸门活动（没有等待、没有额度变化）。")
        return 0

    for model in models:
        rows = waits.get(model, [])
        total_wait = sum(row[0] for row in rows)
        print(f"── {model}")
        print(f"   等待次数      : {len(rows)}   总等待 {total_wait / 1000:.1f}s"
              f"   最长 {max((r[0] for r in rows), default=0) / 1000:.1f}s")
        if rows:
            reasons = defaultdict(int)
            for _, reason, _ in rows:
                reasons[reason] += 1
            print(f"   等待原因      : " + "，".join(f"{k}×{v}" for k, v in sorted(reasons.items())))
            budgets = [row[2] for row in rows]
            print(f"   当时预算区间  : {min(budgets):,} – {max(budgets):,} token")
        for before, after in raises.get(model, []):
            print(f"   额度上探      : {before:,} → {after:,}")
        for before, after, trip in cuts.get(model, []):
            print(f"   额度下调      : {before:,} → {after:,}（最紧触发点 {trip}）")
        if too_big.get(model):
            print(f"   预留超预算    : {too_big[model]} 次（跳过窗口等待，冷却仍生效）")
        if fail_opens.get(model):
            print(f"   fail-open     : {fail_opens[model]} 次")
        if conflicts.get(model):
            print(f"   ⚠ 疑似漏记流量: {len(conflicts[model])} 次")
        print()

    total_cooldown = sum(sum(v) for v in cooldowns.values())
    if total_cooldown:
        print(f"429 冷却总时长: {total_cooldown / 1000:.1f}s")

    all_waits = [row[0] for rows in waits.values() for row in rows]
    if all_waits:
        all_waits.sort()
        middle = all_waits[len(all_waits) // 2]
        print(f"等待中位数    : {middle / 1000:.1f}s   合计 {sum(all_waits) / 1000:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
