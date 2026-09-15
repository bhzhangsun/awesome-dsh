/**
 * 按模型分桶的滑动窗口准入账本（TPM + RPM）。
 *
 * 纯数据结构：不碰定时器、不碰 Cordis、不做 I/O，因此可以脱离运行时单测。
 * 等待由调用方（插件）执行，本模块只负责回答"还要等多久"和记账。
 *
 * 设计依据全部来自实测（见 docs/findings.md）：
 *   - 额度按【模型】独立计算，所以桶的键是 model，不是账号也不是 provider。
 *   - 每个模型同时受两个门槛约束：TPM（token/分钟）与 RPM（请求/分钟）。
 *   - 响应头不暴露剩余额度，账本只能自记，再靠 429 反馈纠正。
 *   - 缓存命中【计入】TPM，所以这里记的是 totalTokens，不做缓存折扣。
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_TPM = 1_000_000;
const DEFAULT_RPM = 60;

/** 无 429 期间每个窗口的上探幅度（AIMD 的加性增长）。 */
const RAISE_FACTOR = 1.05;
/** 撞 429 时的乘性下降。 */
const CUT_FACTOR = 0.5;
/** 额度估计的下限 = 起点 / 64，避免连续撞墙后退化到毫无约束。 */
const MIN_LIMIT_DIVISOR = 64;

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.85;
  return Math.min(Math.max(value, 0.05), 1);
}

/** 从一条 `usage` chunk 里取出计入 TPM 的 token 总量。 */
export function billedTokens(usage) {
  if (usage === undefined || usage === null) return 0;
  const total = usage.totalTokens;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return total;
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  let sum = 0;
  for (const part of parts) {
    if (typeof part === 'number' && Number.isFinite(part) && part > 0) sum += part;
  }
  return sum;
}

/** 一个模型一个桶：滑动窗口内的 token 与请求计数，加一份在途预留。 */
export class ModelBucket {
  constructor(options = {}) {
    this.key = options.key ?? 'unknown';
    this.tpm = positive(options.tpm, DEFAULT_TPM);
    this.rpm = positive(options.rpm, DEFAULT_RPM);
    this.safetyFactor = clamp01(options.safetyFactor);
    this.windowMs = positive(options.windowMs, DEFAULT_WINDOW_MS);

    this.tokenEvents = [];
    this.requestEvents = [];
    this.reservedTokens = 0;
    this.reservedRequests = 0;

    this.cooldownUntil = 0;

    /*
     * 自学习额度（不假设 `tpm` 就是真额度）。
     *
     * 报错文案里的 "TPM limit 1000000" 并不可信：实测 `flash` 的触发点贴合 100%，
     * 而 `flash-vision-exp` 的触发点在 1.03M–3.24M 之间散开（3 倍跨度），说明那个
     * 数字与真实口径不是同一个量。所以 `tpm` 只当**起点**，之后由观测驱动：
     *   撞 429  → 触发点是一个上界，据此下调
     *   无 429  → 缓慢上探（但不空转空涨，见 noteDeferred）
     */
    this.limit = this.tpm;
    /** 成功放行过的最大窗口读数（下界：真额度一定大于它）。诊断用。 */
    this.observedMax = 0;
    /** 429 时的最小窗口读数（上界）。null = 尚未观测到。 */
    this.observedTrip = null;
    this.bindingsSinceRaise = 0;
    this.lastRaiseAt = 0;
    this.lastCutAt = 0;

    this.stats = {
      admitted: 0, deferred: 0, settled: 0, released: 0,
      rateLimited: 0, estimateDrift: 0, raised: 0, cut: 0, conflicts: 0,
    };
  }

  /**
   * 当前生效的额度估计：自学习值，但**绝不超过观测到的最紧触发点**。
   * 上界只在「账本没有漏记流量」时成立（漏记会让读数偏小），所以它只用于收紧。
   */
  get effectiveLimit() {
    const capped = this.observedTrip === null ? this.limit : Math.min(this.limit, this.observedTrip);
    return Math.max(0, capped);
  }

  /** 可以安全用掉的 token 上限（乘安全系数，留出估计误差的余量）。 */
  get tokenBudget() {
    return Math.floor(this.effectiveLimit * this.safetyFactor);
  }

  /** 额度估计的下限，防止连续撞墙后退化。 */
  get limitFloor() {
    return this.tpm / MIN_LIMIT_DIVISOR;
  }

  /** 记录一次「额度真的卡住了调用」——上探的前提。 */
  noteDeferred() {
    this.bindingsSinceRaise += 1;
  }

  /** 记录一次成功放行时的窗口读数（下界，只升不降）。 */
  noteAdmitted(windowTokens) {
    if (typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0) {
      this.observedMax = Math.max(this.observedMax, windowTokens);
    }
  }

  /**
   * 无 429 期间的上探（每个窗口最多一次）。
   *
   * **只有预算真的卡住过调用才涨**。否则空载时也会每个窗口涨 5%，一天之后涨到
   * 离谱的值，等负载回来时一口气冲过真实额度——那是 429 风暴，不是自学习。
   *
   * @returns {{before:number, after:number}|null} 发生了上探就返回前后值
   */
  maybeRelax(now) {
    if (this.bindingsSinceRaise === 0) return null;
    if (now - this.lastRaiseAt < this.windowMs) return null;
    this.lastRaiseAt = now;
    this.bindingsSinceRaise = 0;
    const before = this.limit;
    const ceiling = this.observedTrip === null ? Infinity : this.observedTrip;
    const after = Math.max(this.limitFloor, Math.min(before * RAISE_FACTOR, ceiling));
    if (after <= before) return null;
    this.limit = after;
    this.stats.raised += 1;
    return { before, after };
  }

  prune(now) {
    const floor = now - this.windowMs;
    while (this.tokenEvents.length > 0 && this.tokenEvents[0].at <= floor) this.tokenEvents.shift();
    while (this.requestEvents.length > 0 && this.requestEvents[0] <= floor) this.requestEvents.shift();
  }

  tokenUsage(now) {
    this.prune(now);
    let settled = 0;
    for (const event of this.tokenEvents) settled += event.tokens;
    return settled + this.reservedTokens;
  }

  requestUsage(now) {
    this.prune(now);
    return this.requestEvents.length + this.reservedRequests;
  }

  cooldownRemaining(now) {
    return Math.max(0, this.cooldownUntil - now);
  }

  /**
   * 只算 token 侧的等待：预算装不下这次预留时，要等最早的那批事件滑出窗口。
   * @returns {number} 毫秒；0 表示 token 侧没有卡住。
   */
  tokenWaitMsUntil(now, reserveTokens) {
    this.prune(now);
    let tokenWait = 0;
    const tokenNeed = this.tokenUsage(now) + reserveTokens - this.tokenBudget;
    if (tokenNeed > 0) {
      tokenWait = this.windowMs;
      let remaining = tokenNeed;
      const expiries = [];
      for (const event of this.tokenEvents) expiries.push({ at: event.at + this.windowMs, tokens: event.tokens });
      expiries.sort((a, b) => a.at - b.at);
      for (const expiry of expiries) {
        remaining -= expiry.tokens;
        if (remaining <= 0) {
          tokenWait = Math.max(0, expiry.at - now);
          break;
        }
      }
    }
    return tokenWait;
  }

  /**
   * 只算请求数（RPM）侧的等待。
   * @returns {number} 毫秒；0 表示 RPM 侧没有卡住。
   */
  requestWaitMsUntil(now) {
    this.prune(now);
    let requestWait = 0;
    const overflow = this.requestUsage(now) + 1 - this.rpm;
    if (overflow > 0) {
      requestWait = this.windowMs;
      const expiries = this.requestEvents.map((at) => at + this.windowMs).sort((a, b) => a - b);
      const index = Math.min(overflow - 1, expiries.length - 1);
      if (index >= 0) requestWait = Math.max(0, expiries[index] - now);
    }
    return requestWait;
  }

  /**
   * 还需要等多久才装得下这次请求。
   * @returns {number} 毫秒；0 表示可以立刻发出。
   */
  waitMsUntil(now, reserveTokens) {
    return Math.max(this.tokenWaitMsUntil(now, reserveTokens), this.requestWaitMsUntil(now));
  }

  /**
   * 放行这次请求：占用一份在途预留。
   * 预留会被计入 `tokenUsage`，所以"预留 → 结算"之间不会出现重复计数。
   */
  reserve(tokens) {
    this.reservedTokens += tokens;
    this.reservedRequests += 1;
    this.stats.admitted += 1;
  }

  /**
   * 用真实用量替换预留：先退还预留，再记入一条真实事件。
   * @returns {number} 计入 TPM 的真实 token 数。
   */
  settle(plannedTokens, usage, now = Date.now()) {
    const actual = billedTokens(usage);
    this.reservedTokens = Math.max(0, this.reservedTokens - plannedTokens);
    this.reservedRequests = Math.max(0, this.reservedRequests - 1);
    this.tokenEvents.push({ at: now, tokens: actual });
    this.requestEvents.push(now);
    this.stats.settled += 1;
    this.stats.estimateDrift = actual - plannedTokens;
    return actual;
  }

  /** 没有 usage 就全额释放（失败、取消、空响应）。 */
  release(plannedTokens) {
    this.reservedTokens = Math.max(0, this.reservedTokens - plannedTokens);
    this.reservedRequests = Math.max(0, this.reservedRequests - 1);
    this.stats.released += 1;
  }

  /**
   * 429 反馈：记录触发点、下调额度、进入冷却。
   *
   * 每个窗口**最多下调一次**：一场重试风暴会在同一秒里报好几次 429，若每次都砍半，
   * 额度会瞬间崩到没法用——有效样本量是「起数」，不是「报错行数」。
   *
   * @returns {{cut: {before:number, after:number}|null, conflict: boolean}}
   *   conflict = 这次的触发点比「曾经成功放行过的窗口读数」还低。逻辑上不可能
   *   （能成功放行就说明当时没越线），所以出现即意味着账本漏记了流量（同 key 的
   *   其他客户端/机器）或者读数与提供方口径不可比——此时上界只能当参考。
   */
  noteRateLimit(now, cooldownMs, windowTokens) {
    const measured = typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0;
    const conflict = measured && this.observedMax > windowTokens;
    if (measured) {
      this.observedTrip = this.observedTrip === null
        ? windowTokens
        : Math.min(this.observedTrip, windowTokens);
    }
    if (conflict) this.stats.conflicts += 1;
    this.cooldownUntil = Math.max(this.cooldownUntil, now + cooldownMs);
    this.stats.rateLimited += 1;

    if (now - this.lastCutAt < this.windowMs) return { cut: null, conflict };
    this.lastCutAt = now;
    const before = this.limit;
    const after = Math.max(this.limitFloor, before * CUT_FACTOR);
    if (after >= before) return { cut: null, conflict };
    this.limit = after;
    this.stats.cut += 1;
    return { cut: { before, after }, conflict };
  }

  snapshot(now = Date.now()) {
    return {
      key: this.key,
      tpm: this.tpm,
      rpm: this.rpm,
      tokenUsage: this.tokenUsage(now),
      tokenBudget: this.tokenBudget,
      requestUsage: this.requestUsage(now),
      cooldownRemainingMs: this.cooldownRemaining(now),
      // 自学习额度的全部状态：排查「为什么在这儿等」时必须一次看全。
      limit: Math.round(this.effectiveLimit),
      limitNominal: Math.round(this.limit),
      observedMax: Math.round(this.observedMax),
      observedTrip: this.observedTrip === null ? null : Math.round(this.observedTrip),
      stats: { ...this.stats },
    };
  }
}

/**
 * 桶注册表。
 *
 * 限流按模型独立，但 429 只告诉我们 provider，不一定告诉 model（`agent/request-error`
 * 的 payload 里没有 model 字段）。所以在拿不到 model 时，冷却会落到 provider 级，
 * 由该 provider 下所有桶共同遵守——保守，但不会误放行。
 */
export function createRegistry(config = {}) {
  const buckets = new Map();
  const providerCooldowns = new Map();

  function modelConfig(model) {
    const perModel = config.models?.[model];
    return {
      tpm: positive(perModel?.tpm, positive(config.defaultTpm, DEFAULT_TPM)),
      rpm: positive(perModel?.rpm, positive(config.defaultRpm, DEFAULT_RPM)),
      safetyFactor: clamp01(perModel?.safetyFactor ?? config.safetyFactor),
      windowMs: positive(config.windowMs, DEFAULT_WINDOW_MS),
    };
  }

  function bucketFor(model, provider) {
    const key = typeof model === 'string' && model.length > 0 ? model : `provider:${provider ?? 'unknown'}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = new ModelBucket({ key, provider, ...modelConfig(key) });
      buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * 429 反馈。
   *
   * 触发点（429 那一刻账本读到多少）由桶自己取——调用方拿不到这个数，而它正是
   * 自学习需要的那个观测。model 未知时只能退化到 provider 级冷却。
   *
   * @returns {{bucket:ModelBucket, cut:{before:number, after:number}|null, conflict:boolean}|null}
   */
  function noteRateLimit({ model, provider, now, cooldownMs }) {
    if (typeof model === 'string' && model.length > 0) {
      const bucket = bucketFor(model, provider);
      const { cut, conflict } = bucket.noteRateLimit(now, cooldownMs, bucket.tokenUsage(now));
      return { bucket, cut, conflict };
    }
    if (typeof provider === 'string' && provider.length > 0) {
      providerCooldowns.set(provider, Math.max(providerCooldowns.get(provider) ?? 0, now + cooldownMs));
    }
    return null;
  }

  function providerCooldownRemaining(provider, now) {
    if (typeof provider !== 'string') return 0;
    return Math.max(0, (providerCooldowns.get(provider) ?? 0) - now);
  }

  return {
    bucketFor,
    noteRateLimit,
    providerCooldownRemaining,
    list: () => [...buckets.values()],
    clear: () => {
      buckets.clear();
      providerCooldowns.clear();
    },
  };
}
