import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelBucket, createRegistry, billedTokens } from '../src/ledger.js';

const T0 = 1_800_000_000_000;

function bucket(overrides = {}) {
  return new ModelBucket({ key: 'm', tpm: 1_000_000, rpm: 60, safetyFactor: 1, windowMs: 60_000, ...overrides });
}

test('billedTokens 用 totalTokens，缺字段时才回退求和', () => {
  assert.equal(billedTokens({ totalTokens: 100, inputTokens: 1, outputTokens: 2 }), 100);
  assert.equal(billedTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 85 }), 100);
  assert.equal(billedTokens(undefined), 0);
});

test('额度充足时无需等待', () => {
  const b = bucket();
  assert.equal(b.waitMsUntil(T0, 10_000), 0);
});

test('TPM 压线时，按最早过期的窗口事件计算等待时间', () => {
  const b = bucket();
  b.settle(0, { totalTokens: 950_000 }, T0);
  // 预算 1,000,000，已用 950,000，再要 100,000 → 需要 50,000 排空
  const wait = b.waitMsUntil(T0 + 10_000, 100_000);
  assert.equal(wait, 50_000, '应等到 T0+60s 这条事件滑出窗口，即再等 50s');
});

test('储备本身计入用量：在途预留不会被重复放行', () => {
  const b = bucket();
  b.reserve(900_000);
  assert.equal(b.tokenUsage(T0), 900_000);
  assert.ok(b.waitMsUntil(T0, 200_000) > 0, '预留占用的额度必须挡住后来的请求');
});

test('结算用真实值替换预留，差额退还', () => {
  const b = bucket();
  b.reserve(500_000);
  const actual = b.settle(500_000, { totalTokens: 120_000 }, T0);
  assert.equal(actual, 120_000);
  assert.equal(b.tokenUsage(T0), 120_000, '预留应被完全替换，而不是叠加');
  assert.equal(b.reservedTokens, 0);
});

test('没有 usage 时全额释放预留', () => {
  const b = bucket();
  b.reserve(500_000);
  b.release(500_000);
  assert.equal(b.tokenUsage(T0), 0);
  assert.equal(b.reservedRequests, 0);
});

test('RPM 独立生效：即使 token 远未压线，超过 60 请求/分钟也要等', () => {
  const b = bucket();
  for (let i = 0; i < 60; i += 1) b.settle(0, { totalTokens: 1 }, T0 + i);
  assert.ok(b.waitMsUntil(T0 + 100, 1) > 0, '第 61 个请求必须等待最早那条滑出窗口');
  assert.equal(b.waitMsUntil(T0 + 60_100, 1), 0, '窗口滑过后重新可放行');
});

test('429 反馈形成全局冷却，冷却期间一律不放行', () => {
  const b = bucket();
  b.noteRateLimit(T0, 60_000);
  assert.equal(b.cooldownRemaining(T0 + 30_000), 30_000);
  assert.equal(b.cooldownRemaining(T0 + 60_001), 0);
});

test('冷却取最长：后到的短冷却不会缩短已有的长冷却', () => {
  const b = bucket();
  b.noteRateLimit(T0, 60_000);
  b.noteRateLimit(T0 + 1_000, 5_000);
  assert.equal(b.cooldownRemaining(T0 + 1_000), 59_000);
});

test('只给 provider 时，冷却落到 provider 级，所有模型共同遵守', () => {
  const r = createRegistry({ defaultTpm: 1_000_000, defaultRpm: 60 });
  r.noteRateLimit({ model: undefined, provider: 'token-hub', now: T0, cooldownMs: 60_000 });
  assert.equal(r.providerCooldownRemaining('token-hub', T0 + 10_000), 50_000);
  assert.equal(r.providerCooldownRemaining('other', T0 + 10_000), 0);
});

test('分桶按模型独立：一个模型被限流不影响另一个', () => {
  const r = createRegistry({ defaultTpm: 1_000_000, defaultRpm: 60 });
  const a = r.bucketFor('model-a', 'token-hub');
  const b = r.bucketFor('model-b', 'token-hub');
  a.noteRateLimit(T0, 60_000);
  assert.equal(a.cooldownRemaining(T0), 60_000);
  assert.equal(b.cooldownRemaining(T0), 0);
  assert.equal(b.waitMsUntil(T0, 1_000), 0);
});

test('按模型覆盖配置生效', () => {
  const r = createRegistry({
    defaultTpm: 1_000_000,
    defaultRpm: 60,
    models: { small: { tpm: 10_000, rpm: 5 } },
  });
  assert.equal(r.bucketFor('small').tpm, 10_000);
  assert.equal(r.bucketFor('small').rpm, 5);
  assert.equal(r.bucketFor('other').tpm, 1_000_000);
});

// ── 额度自学习（不假设 tpm 就是真额度）────────────────────────────────────────

test('起点只是起点：初始生效额度等于配置值，预算仍是它乘安全系数', () => {
  const b = new ModelBucket({ key: 'm', tpm: 1_000_000, rpm: 60, safetyFactor: 0.85, windowMs: 60_000 });
  assert.equal(b.effectiveLimit, 1_000_000);
  assert.equal(b.tokenBudget, 850_000);
  assert.equal(b.observedTrip, null, '还没撞过，上界未知');
});

test('撞 429：记录触发点作为上界，并把额度砍半', () => {
  const b = bucket();
  const { cut } = b.noteRateLimit(T0, 60_000, 2_222_888);
  assert.deepEqual(cut, { before: 1_000_000, after: 500_000 });
  assert.equal(b.observedTrip, 2_222_888);
  assert.equal(b.effectiveLimit, 500_000);
  assert.equal(b.tokenBudget, 500_000, 'safetyFactor=1 时预算就是额度');
});

test('上界只降不升：后到的更高触发点不会放宽额度', () => {
  const b = bucket();
  b.noteRateLimit(T0, 60_000, 1_030_000);
  b.noteRateLimit(T0 + 120_000, 60_000, 3_240_000);
  assert.equal(b.observedTrip, 1_030_000, '取最紧的那次，而不是第一次也不是中位');
});

test('一场重试风暴里每个窗口最多砍一次：6 次 429 不等于 6 次砍半', () => {
  const b = bucket();
  const cuts = [];
  for (let i = 0; i < 6; i += 1) cuts.push(b.noteRateLimit(T0 + i * 200, 60_000, 2_200_000).cut);
  assert.equal(cuts.filter(Boolean).length, 1, '同一秒的 6 次 429 只能算 1 起');
  assert.equal(b.limit, 500_000, '额度只砍了一次，没有崩到没法用');
  assert.equal(b.stats.rateLimited, 6, '但 6 次都要如实计数');
});

test('下一个窗口可以再砍：不是永久锁死', () => {
  const b = bucket();
  b.noteRateLimit(T0, 60_000, 2_200_000);
  const again = b.noteRateLimit(T0 + 60_001, 60_000, 1_100_000);
  assert.deepEqual(again.cut, { before: 500_000, after: 250_000 });
});

test('无 429 且预算真的卡住过调用时才上探，每个窗口最多一次', () => {
  const b = bucket();
  assert.equal(b.maybeRelax(T0), null, '没被卡住过就不涨');

  b.noteDeferred();
  const first = b.maybeRelax(T0);
  assert.ok(first.after > first.before);
  assert.equal(first.after, 1_050_000, '涨 5%');

  b.noteDeferred();
  assert.equal(b.maybeRelax(T0 + 1_000), null, '同一窗口内不重复涨');
  const second = b.maybeRelax(T0 + 60_001);
  assert.equal(second.after, 1_102_500, '过了一个窗口再涨 5%');
});

test('空载不会一路空涨：没有被卡住就永远不抬额度', () => {
  const b = bucket();
  for (let i = 0; i < 100; i += 1) assert.equal(b.maybeRelax(T0 + i * 60_000), null);
  assert.equal(b.effectiveLimit, 1_000_000, '否则空载一天后负载回来会一口气冲过真实额度');
});

test('上探不会越过已观测的上界', () => {
  const b = bucket();
  b.noteRateLimit(T0, 60_000, 1_200_000);      // 上界 1.2M，额度砍到 500k
  b.noteDeferred();
  b.maybeRelax(T0 + 60_001);
  assert.equal(b.limit, 525_000);
  // 反复上探，最多贴到上界为止
  for (let i = 2; i <= 40; i += 1) { b.noteDeferred(); b.maybeRelax(T0 + i * 60_001); }
  assert.equal(b.effectiveLimit, 1_200_000, '生效额度被上界卡住，不会重新冲过触发点');
});

test('成功放行的窗口读数记作下界，只升不降', () => {
  const b = bucket();
  b.noteAdmitted(900_000);
  b.noteAdmitted(400_000);
  assert.equal(b.observedMax, 900_000);
  b.noteAdmitted(Number.NaN);
  assert.equal(b.observedMax, 900_000, '非法值不该污染下界');
});

test('额度不会退化到零：连续撞墙有下限', () => {
  const b = bucket();
  for (let i = 0; i < 20; i += 1) b.noteRateLimit(T0 + i * 60_001, 60_000, 2_000_000);
  assert.equal(b.limit, 1_000_000 / 64, '下限 = 起点/64，避免塌成没法用');
});

test('snapshot 一次看全自学习状态（排查「为什么在这儿等」）', () => {
  const b = bucket();
  b.noteRateLimit(T0, 60_000, 2_222_888);
  b.noteAdmitted(850_000);
  b.noteDeferred();
  b.maybeRelax(T0 + 60_001);
  const snap = b.snapshot(T0 + 70_000);
  assert.equal(snap.observedTrip, 2_222_888);
  assert.equal(snap.observedMax, 850_000);
  assert.equal(snap.limit, 525_000);
  assert.equal(snap.tpm, 1_000_000, '起点仍然如实保留，便于对照');
  assert.equal(snap.stats.cut, 1);
  assert.equal(snap.stats.raised, 1);
});

test('触发点低于「已成功放行过的窗口」= 账本漏记流量的信号', () => {
  const b = bucket();
  b.noteAdmitted(900_000); // 曾在账本读到 900k 时成功放行（下界）
  assert.equal(b.noteRateLimit(T0, 60_000, 2_200_000).conflict, false, '触发点更高，正常');
  assert.equal(b.noteRateLimit(T0 + 60_001, 60_000, 500_000).conflict, true, '500k 触发却曾在 900k 成功 → 逻辑不可能');
  assert.equal(b.stats.conflicts, 1);
});

test('估算：content 是纯字符串时必须照样估，不能静默按 0 算', async () => {
  const { localEstimateMessage } = await import('../src/estimate.js');
  // 4000 字符：4000/4 + 4(块开销) + 4(角色框架) = 1008；旧实现只返回 4。
  assert.equal(localEstimateMessage({ role: 'user', content: 'x'.repeat(4_000) }), 1_008);
  // block 形态：400/4 + 4(块) + 4(框架) = 108。两种写法量级一致，不会差几十倍。
  assert.equal(localEstimateMessage({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }), 108);
});

test('token 侧与 RPM 侧的等待可以分开算（上探只能看 token 侧）', () => {
  const b = bucket(); // tpm 1,000,000 / rpm 60 / safetyFactor 1
  for (let i = 0; i < 60; i += 1) b.settle(0, { totalTokens: 1 }, T0);
  assert.equal(b.tokenWaitMsUntil(T0, 10), 0, 'token 只用了 60，远没压线');
  assert.ok(b.requestWaitMsUntil(T0) > 0, 'RPM 已满 60');
  assert.equal(b.waitMsUntil(T0, 10), b.requestWaitMsUntil(T0), '合并结果等于卡住的那一侧');
});
