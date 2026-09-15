/**
 * dsh-retry-gate —— 按模型分桶的 TPM/RPM 准入闸门。
 *
 * ## 它解决什么
 *
 * 现有重试执行器（`@deepseek-ai/dsh-llm-retry`）是**每会话独立、事后**的：它不知道
 * 这一分钟全局烧了多少 token，也不知道别的会话正在同一秒里重试。并发会话一多，
 * 每个会话各自退避、各自重发整个 prompt，于是重试本身在制造下一次限流。
 *
 * 本插件在**请求发出之前**做全局准入：进程内唯一的账本，按模型分桶，同时看住
 * TPM 与 RPM 两个门槛，装不下就等，而不是发出去撞 429。
 *
 * ## 两个挂载点，职责严格分开
 *
 * 1. `llm/stream`（`global` + `prepend`）——**唯一睡觉的地方**。
 *    每次 attempt 都穿过它，包括重试的 attempt（这是 harness 自带的语义：
 *    该 waterfall 覆盖 "retry, replay, routing"）。在这里等，等待发生在
 *    attempt **内部**，因此不消耗重试次数。
 *
 * 2. `agent/request-error`（`prepend`）——**只做决定，不睡觉**。
 *    接管 `RATE_LIMIT`：记录全局冷却后立刻返回 `{ kind: 'retry' }`，让 loop 重跑
 *    同一步；真正的等待由第 1 点在下次 attempt 里完成。非限流失败一律 `next()`
 *    交给 `dsh-llm-retry`，两者的退避语义不会打架。
 *
 * ## 实测依据（见 docs/findings.md）
 *
 * - 额度**按模型**独立（打爆 A 模型时 B/C 同时可用），键必须是 model。
 * - 每个模型两个门槛：TPM 1,000,000/min 与 RPM 60/min。
 * - 响应头不暴露剩余额度 → 只能自记账 + 用 429 反馈纠正。
 * - 缓存命中**计入** TPM → 账本记 totalTokens，不做缓存折扣。
 * - 429 带 `Retry-After: 60`，但 `dsh-llm-pi-ai` 不读这个头 → 有则用、无则自行
 *   计算兜底（`fallbackCooldownMs`）。
 */

import { createRegistry } from './ledger.js';
import { estimateReservation } from './estimate.js';

export const name = 'dsh-retry-gate';

const DEFAULTS = {
  defaultTpm: 1_000_000,
  defaultRpm: 60,
  safetyFactor: 0.85,
  windowMs: 60_000,
  fallbackCooldownMs: 60_000,
  // 等待上限只用来兜底：正常情况下窗口一腾出空档就立刻放行。设成 120s 是因为
  // 窗口只有 60s，等得比这更久几乎没有收益，而**每一次等待在 UI 上都是静默的**
  // ——所以不能让它无界（见 README「可见性」）。
  maxWaitMs: 120_000,
  maxRetriesPerStep: 6,
  outputReserveTokens: 8_192,
  jitterMs: 250,
  models: {},
};

function normalizeConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) };
  const numeric = ['defaultTpm', 'defaultRpm', 'windowMs', 'fallbackCooldownMs', 'maxWaitMs', 'maxRetriesPerStep', 'outputReserveTokens', 'jitterMs'];
  for (const key of numeric) {
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`dsh-retry-gate: config.${key} must be a non-negative finite number`);
    }
  }
  if (merged.maxWaitMs < merged.windowMs) {
    throw new Error('dsh-retry-gate: config.maxWaitMs must be at least config.windowMs, otherwise the gate can never outlast a full window');
  }
  return merged;
}

/** 从 agent（或 scoped agent）上取会话 id。 */
function sessionIdOfAgent(agent) {
  return agent?.session?.id ?? agent?.id ?? undefined;
}

/**
 * 会话身份的**兜底**路径。
 *
 * `agent/request-error` 的 payload 里有 `agent`，`llm/stream` 的 options 里有
 * `sessionId`——两处都优先用它们。只有在那些字段缺失时才回到这里，
 * 通过 agents 服务回溯当前发起者。
 */
function sessionIdOf(ctx) {
  try {
    const agents = ctx.get?.('agents');
    return sessionIdOfAgent(agents?.currentInitiator?.());
  } catch {
    return undefined;
  }
}

/** 可取消的等待；任一 signal 中止就立即返回。 */
function sleep(ms, ...signals) {
  const active = signals.filter((signal) => signal !== undefined && signal !== null);
  if (active.some((signal) => signal.aborted)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const signal of active) signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      for (const signal of active) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }
    for (const signal of active) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 冷却时长：提供方给了 Retry-After 就用它，否则自己算兜底值。 */
function cooldownFor(failure, config) {
  const fromProvider = failure?.providerRetryAfterMs;
  if (typeof fromProvider === 'number' && Number.isFinite(fromProvider) && fromProvider > 0) return fromProvider;
  return config.fallbackCooldownMs;
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const registry = createRegistry(cfg);
  const lastModelBySession = new Map();
  const retriesByStep = new Map();
  const lifetime = new AbortController();

  /**
   * 人类可读的桶状态。只取快照里的标量，不持有任何 live 对象。
   *
   * 存在的理由见 README「可见性」：闸门等待期间会话在 UI 上**完全静默**，
   * 没有日志的话和卡死无法区分——这正是它第一次上线时造成误判的地方。
   */
  function describeBucket(bucket, planned) {
    const snap = bucket.snapshot();
    const trip = snap.observedTrip === null ? '未观测' : `最紧触发点 ${snap.observedTrip}`;
    return [
      `model=${snap.key}`,
      `窗口=${snap.tokenUsage}/${snap.tokenBudget} token(+本次预留 ${planned})`,
      `额度估计=${snap.limit}(起点 ${snap.tpm}, ${trip})`,
      `rpm=${snap.requestUsage}/${snap.rpm}`,
      `冷却余=${snap.cooldownRemainingMs}ms`,
    ].join(' ');
  }

  /**
   * 429 的两个观测点（流内 finish、agent/request-error）共用。
   *
   * 只有真的下调了才吭声：同一场重试风暴里的后续 429 不重复下调，也不重复刷日志
   * （有效样本量是「起数」，不是「报错行数」——这条在账本和日志里都要成立）。
   */
  function logQuotaCut(source, observed) {
    if (!observed) return;
    // 触发点低于「曾经成功放行过的窗口读数」= 账本漏记了流量，上界不可信。
    // 只在真正下调的那个窗口里报，避免一场风暴刷一屏。
    if (observed.conflict && observed.cut) {
      ctx.logger?.warn?.(
        'dsh-retry-gate: 触发点 %d 低于已成功放行过的窗口读数 %d——账本很可能漏记了同 key 的其他客户端流量，上界仅供参考 — model=%s',
        Math.round(observed.bucket.observedTrip), Math.round(observed.bucket.observedMax), observed.bucket.key,
      );
    }
    if (!observed.cut) return;
    const trip = observed.bucket.observedTrip;
    ctx.logger?.warn?.(
      'dsh-retry-gate: 429 反馈生效（%s），额度下调 %d → %d（最紧触发点 %s）— model=%s',
      source, Math.round(observed.cut.before), Math.round(observed.cut.after),
      trip === null ? '未观测' : Math.round(trip), observed.bucket.key,
    );
  }

  /** 等待到账本与冷却都放行为止；返回实际等待毫秒数。 */
  async function waitForAdmission(bucket, planned, provider, signal) {
    const deadline = Date.now() + cfg.maxWaitMs;

    /*
     * 预留本身就超过整个预算时，窗口无论空到什么程度都放不下这次调用。
     * 早期的实现在这里会一直等到 maxWaitMs 用尽才 fail-open——每一次调用都
     * 白白烧掉整个等待预算，在 UI 上就是一次没有尽头的静默卡顿。
     * 上下文特别大的会话（估算输入 + outputReserve 超过预算）正好会踩中。
     *
     * 但**冷却仍然要等**：那是提供方下的暂停，不是窗口排空的估算。自学习把额度
     * 压低之后，预算可能落到单次预留以下，若连冷却一起跳掉，重试会立刻撞回去，
     * 退化成重试风暴——这比多等一会儿糟得多。
     */
    const budget = bucket.tokenBudget;
    const tokenHopeless = planned > budget;
    if (tokenHopeless) {
      ctx.logger?.warn?.(
        'dsh-retry-gate: 本次预留 %d token 超过整个预算 %d，不再等窗口（冷却仍要等）— %s',
        planned, budget, describeBucket(bucket, planned),
      );
    }

    let waited = 0;
    let announced = false;
    let tokenBound = false;
    for (;;) {
      const now = Date.now();
      const cooldownMs = Math.max(
        bucket.cooldownRemaining(now),
        registry.providerCooldownRemaining(provider, now),
      );
      /*
       * 分开算，是为了区分「谁卡住了这次调用」：
       * 只有 token 侧真的卡住过，才算「额度被验证过」，才有资格上探。
       * 实测踩到过——一次纯 RPM 的等待（token 窗口只有 780/850000）也触发了
       * 额度上探 1000000 → 1050000，那是拿 RPM 的证据去涨 TPM 额度；长期跑下去
       * 会一路空涨，正是自学习最该避免的「攒雷」。
       */
      const tokenWait = tokenHopeless ? 0 : bucket.tokenWaitMsUntil(now, planned);
      if (tokenWait > 0) tokenBound = true;
      const waitMs = Math.max(cooldownMs, tokenWait, bucket.requestWaitMsUntil(now));
      if (waitMs <= 0) {
        // 只有真等过才记一条，否则正常调用会把日志淹掉。
        if (announced) {
          ctx.logger?.info?.(
            'dsh-retry-gate: 放行（等了 %dms）— %s',
            waited, describeBucket(bucket, planned),
          );
        }
        return { waited, tokenBound };
      }
      if (now + waitMs > deadline) {
        // 超过等待预算就放行：宁可撞一次 429，也不能把会话挂死（fail-open）。
        ctx.logger?.warn?.(
          'dsh-retry-gate: fail-open，不再等下去（还差 %dms，maxWaitMs=%d）— %s',
          waitMs, cfg.maxWaitMs, describeBucket(bucket, planned),
        );
        return { waited, tokenBound };
      }
      if (!announced) {
        announced = true;
        ctx.logger?.info?.(
          'dsh-retry-gate: 拦住本次调用，等 %dms（%s）— %s',
          waitMs, cooldownMs > 0 ? '冷却中' : '窗口将满', describeBucket(bucket, planned),
        );
      }
      const jitter = Math.floor(Math.random() * cfg.jitterMs);
      const ok = await sleep(waitMs + jitter, signal, lifetime.signal);
      if (!ok) {
        ctx.logger?.info?.('dsh-retry-gate: 等待被中止（调用已取消），已等 %dms', waited);
        return { waited, tokenBound };
      }
      waited += waitMs + jitter;
    }
  }

  /**
   * `llm/stream` 闸门：每一次 attempt（含重试）的准入、结算与 429 观测。
   * 必须是 async generator，因为 waterfall 要求返回 AsyncIterable。
   */
  function gate(options, next) {
    return (async function* gated() {
      const provider = options?.provider;
      const model = typeof options?.model === 'string' && options.model.length > 0 ? options.model : undefined;
      // GenerateOptions 自己带 sessionId（含 compaction / session-title 这类旁路调用），
      // 比回溯当前发起者准确；两者都没有时退回 undefined，只是少了会话归因，不影响准入。
      const sessionId = options?.sessionId ?? sessionIdOf(ctx);
      if (sessionId !== undefined && model !== undefined) lastModelBySession.set(sessionId, model);

      const bucket = registry.bucketFor(model, provider);
      const planned = estimateReservation(ctx, options, cfg.outputReserveTokens);
      let reserved = false;
      let settled = false;
      try {
        // 上探放在算等待之前：额度卡住过调用 → 每个窗口涨一点，慢慢摸到真实上限。
        const raised = bucket.maybeRelax(Date.now());
        if (raised !== null) {
          ctx.logger?.info?.(
            'dsh-retry-gate: 额度上探 %d → %d（连续无 429，且预算确实卡住过调用）— %s',
            Math.round(raised.before), Math.round(raised.after), describeBucket(bucket, planned),
          );
        }

        const { waited, tokenBound } = await waitForAdmission(bucket, planned, provider, options?.signal);
        if (waited > 0) {
          bucket.stats.deferred += 1;
          // 只有 token 侧的预算真的卡住过，才算一次「被验证的约束」。
          // 纯 RPM / 纯冷却的等待不算——那不能证明 token 额度还有余量。
          if (tokenBound) bucket.noteDeferred();
        }
        if (options?.signal?.aborted) return;

        // 放行这一刻账本读到多少：真额度一定大于它（下界观测，只升不降）。
        const windowAtAdmission = bucket.tokenUsage(Date.now());

        bucket.reserve(planned);
        reserved = true;

        for await (const chunk of next()) {
          if (chunk?.type === 'usage') {
            bucket.settle(planned, chunk.usage);
            settled = true;
            bucket.noteAdmitted(windowAtAdmission);
          } else if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') {
            const failure = chunk.reason.failure;
            if (failure?.code === 'RATE_LIMIT') {
              logQuotaCut('流内 finish', registry.noteRateLimit({
                model, provider, now: Date.now(), cooldownMs: cooldownFor(failure, cfg),
              }));
            }
          }
          yield chunk;
        }
      } finally {
        if (reserved && !settled) bucket.release(planned);
      }
    })();
  }

  /**
   * `agent/request-error` 闸门：接管限流，把其余失败原样交给 dsh-llm-retry。
   * 这里刻意不等——等待统一由 `llm/stream` 完成，避免"两处睡觉"叠加成双重等待。
   */
  function onRequestError(payload, next) {
    const failure = payload?.failure;
    if (failure?.code !== 'RATE_LIMIT') return next();

    const provider = payload?.provider;
    // payload 里有 agent 但没有 model：会话定位用 payload.agent，模型再按会话回查。
    const sessionId = sessionIdOfAgent(payload?.agent) ?? sessionIdOf(ctx);
    const model = sessionId !== undefined ? lastModelBySession.get(sessionId) : undefined;
    const cooldownMs = cooldownFor(failure, cfg);
    const fromProvider =
      typeof failure?.providerRetryAfterMs === 'number'
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0;
    const observed = registry.noteRateLimit({ model, provider, now: Date.now(), cooldownMs });
    ctx.logger?.warn?.(
      'dsh-retry-gate: 收到 429，冷却 %dms（%s）— model=%s provider=%s turn=%s step=%s',
      cooldownMs,
      fromProvider ? `提供方 Retry-After=${failure.providerRetryAfterMs}ms` : '提供方未给 Retry-After，用兜底值',
      model ?? '(未知，退到 provider 级冷却)', provider, payload?.turn, payload?.step,
    );
    logQuotaCut('agent/request-error', observed);

    // 自己管限流重试预算：llm-retry 的次数上限在本路径上被我们绕开了。
    const stepKey = `${sessionId ?? provider ?? 'unknown'}:${payload?.turn}:${payload?.step}`;
    const used = retriesByStep.get(stepKey) ?? 0;
    if (used >= cfg.maxRetriesPerStep) return next();
    if (retriesByStep.size > 4_096) retriesByStep.clear();
    retriesByStep.set(stepKey, used + 1);
    return Promise.resolve({ kind: 'retry' });
  }

  ctx.on('llm/stream', gate, { global: true, prepend: true });
  ctx.on('agent/request-error', onRequestError, { prepend: true });

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-retry-gate disposed'));
    registry.clear();
    lastModelBySession.clear();
    retriesByStep.clear();
  }, 'dsh-retry-gate: abort pending waits and drop ledgers');

  // 刻意不发布任何 Service：闸门只需要事件与闭包内状态，不发布就不会和预设的
  // isolate realm 规则纠缠（发布 Service 的行走 host 平面或必须带 realm）。
  // 诊断（窗口用量/在途/冷却）留待下一步：注册一个只读工具，或按会话追加非 surface 事件。
  ctx.logger?.info?.(
    'dsh-retry-gate: active (额度自学习=on 起点tpm=%d rpm=%d safety=%s window=%dms maxWait=%dms)',
    cfg.defaultTpm, cfg.defaultRpm, cfg.safetyFactor, cfg.windowMs, cfg.maxWaitMs,
  );
}
