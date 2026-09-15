import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';

/** 最小的假 Cordis 上下文：只记录注册，不启动任何真实运行时。 */
function fakeCtx() {
  const listeners = [];
  const effects = [];
  return {
    listeners,
    effects,
    get: () => undefined,
    on(event, handler, options) {
      listeners.push({ event, handler, options });
      return () => {};
    },
    effect(factory) {
      effects.push(factory);
      return () => {};
    },
    logger: { info() {}, warn() {} },
    find(event) {
      return listeners.find((entry) => entry.event === event);
    },
  };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/**
 * 真实 logger 支持 printf 风格（`%d`/`%s`）——应用日志里
 * `dsh-retry-gate: active (tpm=1000000 rpm=60 ...)` 就是被替换过的。
 * 假 logger 必须照做，否则断言的是格式串、不是真实输出。
 */
function formatLog(args) {
  let index = 1;
  return String(args[0]).replace(/%[sd]/g, () => String(args[index++]));
}

test('两个挂载点按契约注册', () => {
  const ctx = fakeCtx();
  apply(ctx, {});

  const stream = ctx.find('llm/stream');
  assert.ok(stream, 'llm/stream 必须被监听');
  assert.equal(stream.options?.global, true, '额度和会话无关，必须 global');
  assert.equal(stream.options?.prepend, true, '必须是最外层，才能包住每一次 attempt');

  const error = ctx.find('agent/request-error');
  assert.ok(error, 'agent/request-error 必须被监听');
  assert.equal(error.options?.prepend, true, '必须抢在 llm-retry 之前接管限流');

  assert.equal(ctx.listeners.length, 2);
  assert.equal(ctx.effects.length, 1, '必须注册一个用于停止时清理的 effect');
});

test('配置校验：maxWaitMs 小于窗口时拒绝启动', () => {
  const ctx = fakeCtx();
  assert.throws(
    () => apply(ctx, { windowMs: 60_000, maxWaitMs: 30_000 }),
    /maxWaitMs must be at least config.windowMs/,
  );
  assert.equal(ctx.listeners.length, 0, '校验失败时不应注册任何监听器');
});

test('配置校验：非有限数值被拒绝', () => {
  assert.throws(() => apply(fakeCtx(), { defaultTpm: 'lots' }), /must be a non-negative finite number/);
  assert.throws(() => apply(fakeCtx(), { maxRetriesPerStep: -1 }), /must be a non-negative finite number/);
});

test('闸门透传 chunk，并在 usage 时结算', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const gate = ctx.find('llm/stream').handler;

  const chunks = [
    { type: 'text', text: 'hi' },
    { type: 'usage', usage: { totalTokens: 1_234, inputTokens: 1_000, outputTokens: 234 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const downstream = async function* () {
    for (const chunk of chunks) yield chunk;
  };

  const seen = await collect(gate({ provider: 'token-hub', model: 'm', messages: [] }, () => downstream()));
  assert.deepEqual(seen, chunks, 'chunk 必须原样透传');
});

test('下游抛错时预留被释放（不留泄漏）', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const gate = ctx.find('llm/stream').handler;

  const downstream = async function* () {
    yield { type: 'text', text: 'partial' };
    throw new Error('boom');
  };

  await assert.rejects(
    () => collect(gate({ provider: 'p', model: 'm', messages: [] }, () => downstream())),
    /boom/,
  );
});

test('RATE_LIMIT 被接管：立即返回 retry，不等（等待由 llm/stream 完成）', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const handler = ctx.find('agent/request-error').handler;

  let delegated = false;
  const action = await handler(
    { provider: 'token-hub', turn: 1, step: 2, failure: { code: 'RATE_LIMIT', message: '429', providerRetryAfterMs: 60_000 } },
    () => { delegated = true; return Promise.resolve(undefined); },
  );
  assert.deepEqual(action, { kind: 'retry' });
  assert.equal(delegated, false, '接管时不应把决定权交给下游');
});

test('非限流失败原样交给 llm-retry', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const handler = ctx.find('agent/request-error').handler;

  let delegated = false;
  await handler(
    { provider: 'token-hub', turn: 1, step: 1, failure: { code: 'SERVER', message: '500' } },
    () => { delegated = true; return Promise.resolve({ kind: 'retry' }); },
  );
  assert.equal(delegated, true, 'SERVER 必须走 llm-retry 的既有路径');
});

test('限流重试预算是自己的：超过上限后放手，避免无限重试', async () => {
  const ctx = fakeCtx();
  apply(ctx, { maxRetriesPerStep: 2 });
  const handler = ctx.find('agent/request-error').handler;

  const payload = { provider: 'token-hub', turn: 1, step: 1, failure: { code: 'RATE_LIMIT', message: '429' } };
  assert.deepEqual(await handler(payload, () => Promise.resolve(undefined)), { kind: 'retry' });
  assert.deepEqual(await handler(payload, () => Promise.resolve(undefined)), { kind: 'retry' });

  let delegated = false;
  const third = await handler(payload, () => { delegated = true; return Promise.resolve(undefined); });
  assert.equal(delegated, true, '第 3 次必须放手');
  assert.equal(third, undefined);
});

test('停止时 abort 等待并清空账本', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const dispose = ctx.effects[0]();
  await dispose();
});

test('会话归因优先用 payload.agent：不同会话的重试预算互不干扰', async () => {
  const ctx = fakeCtx();
  apply(ctx, { maxRetriesPerStep: 2 });
  const handler = ctx.find('agent/request-error').handler;
  const payloadFor = (sessionId) => ({
    agent: { session: { id: sessionId } },
    provider: 'token-hub',
    turn: 1,
    step: 1,
    failure: { code: 'RATE_LIMIT', message: '429' },
  });

  assert.deepEqual(await handler(payloadFor('sA'), () => Promise.resolve(undefined)), { kind: 'retry' });
  assert.deepEqual(await handler(payloadFor('sA'), () => Promise.resolve(undefined)), { kind: 'retry' });

  let delegated = false;
  await handler(payloadFor('sA'), () => { delegated = true; return Promise.resolve(undefined); });
  assert.equal(delegated, true, '会话 A 已用满 2 次预算');

  assert.deepEqual(
    await handler(payloadFor('sB'), () => Promise.resolve(undefined)),
    { kind: 'retry' },
    '会话 B 拥有独立预算，不应被 A 消耗',
  );
});

test('闸门接受 options.sessionId（含 compaction / session-title 这类旁路调用）', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const gate = ctx.find('llm/stream').handler;

  const chunks = [
    { type: 'text-delta', index: 0, text: 'x' },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
  ];
  const downstream = async function* () {
    for (const chunk of chunks) yield chunk;
  };

  const seen = await collect(
    gate(
      { provider: 'token-hub', model: 'm', sessionId: 's-1', purpose: 'compaction', messages: [] },
      () => downstream(),
    ),
  );
  assert.deepEqual(seen, chunks, '旁路调用同样穿闸门并原样透传');
});

/**
 * 可见性回归测试。
 *
 * 闸门等待期间会话在 UI 上完全静默——第一次上线时正因如此被误判成
 * 「会话静默中断」。等待本身是对的（它把 429 挡在门外），但必须留下日志。
 */
test('可见性：被拦住的等待必须留下「拦住」与「放行」两条日志', async () => {
  const logs = [];
  const ctx = fakeCtx();
  ctx.logger = {
    info: (...args) => logs.push(formatLog(args)),
    warn: (...args) => logs.push(`WARN ${formatLog(args)}`),
  };
  apply(ctx, {
    defaultTpm: 1_000,
    windowMs: 20,
    maxWaitMs: 500,
    jitterMs: 0,
    fallbackCooldownMs: 0,
    // 预留必须放得进预算，否则命中的是「等多久都放不下」那条路径（另有用例覆盖）。
    outputReserveTokens: 0,
  });

  const gate = ctx.find('llm/stream').handler;
  const errorHandler = ctx.find('agent/request-error').handler;

  // 先让闸门认识这个会话的模型：429 的 payload 里没有 model，要靠这步回查。
  await collect(
    gate(
      { provider: 'p', model: 'm', sessionId: 's', messages: [] },
      () => (async function* () { yield { type: 'usage', usage: { totalTokens: 1 } }; })(),
    ),
  );
  logs.length = 0;

  // 制造一次带 Retry-After 的 429 → 该桶进入冷却。
  await errorHandler(
    {
      agent: { session: { id: 's' } },
      provider: 'p',
      turn: 1,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: '429', providerRetryAfterMs: 40 },
    },
    () => Promise.resolve(undefined),
  );

  const chunks = [{ type: 'text-delta', index: 0, text: 'ok' }];
  const seen = await collect(
    gate(
      { provider: 'p', model: 'm', sessionId: 's', messages: [] },
      () => (async function* () { for (const c of chunks) yield c; })(),
    ),
  );

  assert.deepEqual(seen, chunks, '等完之后照常放行，chunk 不丢');
  const joined = logs.join('\n');
  assert.match(joined, /拦住本次调用/, '必须记录「被拦住」以及要等多久');
  assert.match(joined, /冷却中/, '必须说明等待原因（冷却中 / 窗口将满）');
  assert.match(joined, /放行（等了 \d+ms）/, '必须记录实际等了多久才放行');
  assert.match(joined, /model=m/, '日志要带模型，否则无法定位是哪个桶');
});

test('可见性：等不下去而放行（fail-open）必须留下警告，且不睡满等待预算', async () => {
  const logs = [];
  const ctx = fakeCtx();
  ctx.logger = {
    info: (...args) => logs.push(formatLog(args)),
    warn: (...args) => logs.push(`WARN ${formatLog(args)}`),
  };
  apply(ctx, {
    defaultTpm: 1_000,
    windowMs: 20,
    maxWaitMs: 30,
    jitterMs: 0,
    fallbackCooldownMs: 0,
    outputReserveTokens: 0,
  });

  const gate = ctx.find('llm/stream').handler;
  const errorHandler = ctx.find('agent/request-error').handler;

  await collect(
    gate(
      { provider: 'p', model: 'm', sessionId: 's', messages: [] },
      () => (async function* () { yield { type: 'usage', usage: { totalTokens: 1 } }; })(),
    ),
  );

  // 冷却 5s，远超 maxWaitMs=30ms → 只剩 fail-open 一条路。
  await errorHandler(
    {
      agent: { session: { id: 's' } },
      provider: 'p',
      turn: 1,
      step: 1,
      failure: { code: 'RATE_LIMIT', message: '429', providerRetryAfterMs: 5_000 },
    },
    () => Promise.resolve(undefined),
  );
  logs.length = 0;

  const started = Date.now();
  const seen = await collect(
    gate(
      { provider: 'p', model: 'm', sessionId: 's', messages: [] },
      () => (async function* () { yield { type: 'text-delta', index: 0, text: 'ok' }; })(),
    ),
  );
  const elapsed = Date.now() - started;

  assert.equal(seen.length, 1, 'fail-open 必须照常发出调用，不能把会话挂死');
  assert.ok(elapsed < 1_000, `fail-open 不应真的等 5s（实际 ${elapsed}ms）`);
  assert.match(logs.join('\n'), /fail-open/, '放弃等待必须留下警告');
});

test('预留超过整个预算时立即放行，不烧满 maxWaitMs（大上下文会话的静默卡顿）', async () => {
  const logs = [];
  const ctx = fakeCtx();
  ctx.logger = {
    info: (...args) => logs.push(formatLog(args)),
    warn: (...args) => logs.push(`WARN ${formatLog(args)}`),
  };
  // 预算 = 100 × 0.85 = 85，而一次预留 5000 —— 窗口再空也放不下。
  apply(ctx, {
    defaultTpm: 100,
    windowMs: 20,
    maxWaitMs: 60_000,
    jitterMs: 0,
    outputReserveTokens: 5_000,
    fallbackCooldownMs: 0,
  });

  const gate = ctx.find('llm/stream').handler;
  const started = Date.now();
  const seen = await collect(
    gate(
      { provider: 'p', model: 'm', messages: [] },
      () => (async function* () { yield { type: 'text-delta', index: 0, text: 'ok' }; })(),
    ),
  );
  const elapsed = Date.now() - started;

  assert.equal(seen.length, 1, '必须照常发出调用');
  assert.ok(elapsed < 500, `不能把 maxWaitMs=60s 烧满（实际 ${elapsed}ms）`);
  assert.match(logs.join('\n'), /超过整个预算/, '必须留下「等多久都放不下」的说明');
});

// ── 自学习接线：账本单测过 ≠ 真的接上了 ──────────────────────────────────────

/** 收集日志行（真实 logger 支持 printf，用 formatLog 还原）。 */
function loggingCtx() {
  const ctx = fakeCtx();
  const lines = [];
  ctx.logger = {
    info: (...args) => lines.push(formatLog(args)),
    warn: (...args) => lines.push(`WARN ${formatLog(args)}`),
  };
  return { ctx, lines };
}

/** 跑一次 attempt：next 按给定 chunk 产出。 */
async function attempt(ctx, options, chunks) {
  const gate = ctx.find('llm/stream').handler;
  return collect(gate(options, async function* () { for (const c of chunks) yield c; }));
}

const RATE_LIMITED = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'TPM limit exceeded' } },
};
/** 400 字符的文本块 → 估算 400/4 + 4(块) + 4(框架) = 108 token 预留。 */
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }];

test('接线：流内 429 把触发点写进账本并下调额度，且一场风暴只下调一次', async () => {
  const { ctx, lines } = loggingCtx();
  apply(ctx, { defaultTpm: 1_000_000, safetyFactor: 1, outputReserveTokens: 0, fallbackCooldownMs: 0 });

  // 没有 usage：这条 attempt 的全部用量就是它自己的预留 108
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [RATE_LIMITED]);

  const cuts = lines.filter((l) => l.includes('额度下调'));
  assert.equal(cuts.length, 1, `应恰好下调一次，实际日志：${JSON.stringify(lines)}`);
  assert.match(cuts[0], /流内 finish/, '要标出观测来源（另一个来源是 agent/request-error）');
  assert.match(cuts[0], /额度下调 1000000 → 500000/);
  assert.match(cuts[0], /最紧触发点 108/, '触发点取 429 那一刻账本的读数');

  // 同一窗口内的第二次 429：只计数，不再砍（风暴是 1 起事件，不是 N 起）
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [RATE_LIMITED]);
  assert.equal(lines.filter((l) => l.includes('额度下调')).length, 1);
});

test('接线：被预算卡住过之后，下一次准入必须上探并留下日志', async () => {
  const { ctx, lines } = loggingCtx();
  apply(ctx, {
    defaultTpm: 1_000, safetyFactor: 1, windowMs: 1_000, maxWaitMs: 3_000,
    outputReserveTokens: 0, jitterMs: 0,
  });

  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 950 } }]);
  assert.equal(lines.filter((l) => l.includes('额度上探')).length, 0, '还没被卡住过，没理由抬额度');

  // 窗口里有 950，再要 108 必然等这条事件滑出 1s 窗口
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 100 } }]);
  assert.ok(lines.some((l) => l.includes('拦住本次调用')), `必须留下拦住日志：${JSON.stringify(lines)}`);

  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 100 } }]);
  const raises = lines.filter((l) => l.includes('额度上探'));
  assert.equal(raises.length, 1, `被卡住过之后应当上探一次：${JSON.stringify(lines)}`);
  assert.match(raises[0], /额度上探 1000 → 1050/);
});

test('接线：触发点低于已成功放行过的窗口时，必须警告账本可能漏记了流量', async () => {
  const { ctx, lines } = loggingCtx();
  apply(ctx, {
    defaultTpm: 1_000_000, safetyFactor: 1, windowMs: 300, maxWaitMs: 3_000,
    outputReserveTokens: 0, fallbackCooldownMs: 0,
  });

  // 在账本读到 800k 的窗口上成功放行一次（下界观测）
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 800_000 } }]);
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 1 } }]);
  assert.doesNotMatch(lines.join('\n'), /漏记了同 key/, '此刻还没撞过，不该有矛盾信号');

  // 等窗口排空，再撞一次 429：账本只读到 108，却曾在 800k 上成功过 → 逻辑矛盾
  await new Promise((resolve) => setTimeout(resolve, 350));
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [RATE_LIMITED]);

  const joined = lines.join('\n');
  assert.match(joined, /漏记了同 key 的其他客户端流量/, '必须报出来：上界已不可信');
  assert.match(joined, /额度下调 1000000 → 500000/, '下调本身照常发生');
});

/** 400 字符 → 预留 108；4000 字符 → 预留 1008。 */
const BIG_MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4_000) }] }];

/** 制造「预算已被自学习压到放不下本次预留」的状态：触发点只有 208。 */
async function degradeBudget(ctx) {
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [
    { type: 'usage', usage: { totalTokens: 100 } }, RATE_LIMITED,
  ]);
  // 此时：触发点 208（100 已结算 + 108 在途），额度 1M → 500k，生效额度 = 208
}

test('接线：预算被压低到放不下本次预留时，可以不烧窗口等待，并如实说明', async () => {
  const { ctx, lines } = loggingCtx();
  apply(ctx, {
    defaultTpm: 1_000_000, safetyFactor: 1, windowMs: 3_000, maxWaitMs: 3_000,
    outputReserveTokens: 0, fallbackCooldownMs: 0,
  });
  await degradeBudget(ctx);

  lines.length = 0;
  const startedAt = Date.now();
  await attempt(ctx, { provider: 'p', model: 'm', messages: BIG_MESSAGES }, [{ type: 'usage', usage: { totalTokens: 1 } }]);
  const elapsed = Date.now() - startedAt;

  assert.match(lines.join('\n'), /超过整个预算/, '要如实说明为什么不等窗口');
  assert.match(lines.join('\n'), /冷却仍要等/, '文案必须点明冷却没有被跳过');
  assert.ok(elapsed < 1_000, `窗口等待应被跳过，实际等了 ${elapsed}ms`);
});

test('接线：冷却不因「预算放不下」而被跳过（否则重试立刻撞回去）', async () => {
  const { ctx, lines } = loggingCtx();
  apply(ctx, {
    defaultTpm: 1_000_000, safetyFactor: 1, windowMs: 3_000, maxWaitMs: 3_000,
    outputReserveTokens: 0, fallbackCooldownMs: 0,
  });
  await degradeBudget(ctx);

  // 该桶进入 1.5s 冷却（走 agent/request-error 路径）
  const errorHandler = ctx.find('agent/request-error').handler;
  await errorHandler(
    {
      agent: { session: { id: 's' } }, provider: 'p', turn: 1, step: 1,
      failure: { code: 'RATE_LIMIT', message: '429', providerRetryAfterMs: 1_500 },
    },
    () => Promise.resolve(undefined),
  );

  lines.length = 0;
  const startedAt = Date.now();
  await attempt(ctx, { provider: 'p', model: 'm', messages: BIG_MESSAGES }, [{ type: 'usage', usage: { totalTokens: 1 } }]);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 1_400, `必须真的等完冷却，实际只等了 ${elapsed}ms`);
  assert.match(lines.join('\n'), /冷却中/, '日志要说明等待原因');
});

test('接线：纯 RPM 的等待不得触发票据上探（拿 RPM 证据涨 TPM 额度是攒雷）', async () => {
  const { ctx, lines } = loggingCtx();
  apply(ctx, {
    defaultTpm: 1_000_000, defaultRpm: 3, windowMs: 1_000, maxWaitMs: 3_000,
    outputReserveTokens: 0, jitterMs: 0, fallbackCooldownMs: 0,
  });

  // 三次小调用占满 RPM（token 侧只用了 3×108，离 850000 差得远）
  for (let i = 0; i < 3; i += 1) {
    await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 108 } }]);
  }
  lines.length = 0;

  // 第四次必然等 RPM，但 token 侧没有卡住
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 108 } }]);
  assert.match(lines.join('\n'), /拦住本次调用/, 'RPM 满员时必须等');
  assert.doesNotMatch(lines.join('\n'), /额度上探/, '纯 RPM 等待不得抬高 token 额度');

  // 再等一个窗口后仍不应上探（因为 token 侧始终没被卡住）
  await attempt(ctx, { provider: 'p', model: 'm', messages: MESSAGES }, [{ type: 'usage', usage: { totalTokens: 108 } }]);
  assert.doesNotMatch(lines.join('\n'), /额度上探/, '窗口过去了也不能拿 RPM 的证据涨额度');
});
