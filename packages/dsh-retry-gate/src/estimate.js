/**
 * 请求发出前的 token 预估。
 *
 * 优先用运行时的 `tokenMeter` 服务（与 harness 自己的上下文计量同一套启发式），
 * 服务不可用时退回同一套算法的本地副本，保证两种路径口径一致。
 *
 * 注意：预估只用于"预留"，真实值在流末尾的 `usage` chunk 里，由账本结算纠正。
 */

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;

function roughTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

/** 与 dsh-token-meter 的 estimateMessage 同构的本地兜底。 */
export function localEstimateMessage(message) {
  if (message === undefined || message === null) return 0;
  // content 允许是纯字符串（简单调用方就是这么传的）。早期实现只认 block 数组，
  // 字符串会被静默估成 0，整条消息只剩 4 token 的角色开销——预留严重偏小，
  // 闸门反而会放行本该校准的调用。宁可粗估，也不能静默低估。
  if (typeof message.content === 'string') return 4 + roughTokens(message.content);
  const content = Array.isArray(message.content) ? message.content : [];
  let tokens = 4; // 角色框架开销
  for (const block of content) {
    if (block === undefined || block === null) continue;
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += roughTokens(block.text);
        break;
      case 'tool-call':
        tokens += roughTokens(block.name) + roughTokens(block.arguments);
        break;
      case 'tool-result':
        tokens += localEstimateContent(block.content);
        break;
      default:
        tokens += roughTokens(safeJson(block));
        break;
    }
  }
  return tokens;
}

function localEstimateContent(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let tokens = 0;
  for (const block of blocks) {
    if (block?.type === 'text' || block?.type === 'reasoning') tokens += roughTokens(block.text);
    else tokens += roughTokens(safeJson(block));
  }
  return tokens;
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * 估算一次请求将要消耗的输入 token。
 * @param {object} ctx Cordis 上下文，用于取可选的 `tokenMeter`。
 * @param {object} options llm/stream 的 GenerateOptions。
 * @returns {number} 输入 token 估计值。
 */
export function estimateInputTokens(ctx, options) {
  const meter = ctx?.get?.('tokenMeter');
  const estimateMessage = typeof meter?.estimateMessage === 'function'
    ? (message) => meter.estimateMessage(message)
    : localEstimateMessage;

  let tokens = 0;
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  for (const message of messages) tokens += estimateMessage(message);

  // system 提示与工具 schema 也是输入的一部分，且往往很大。
  tokens += roughTokens(options?.system);
  if (Array.isArray(options?.tools) && options.tools.length > 0) tokens += roughTokens(safeJson(options.tools));
  return tokens;
}

/**
 * 总预留 = 输入估计 + 输出预留。
 *
 * TPM 是按 token 总量卡的，输出也算额度，所以必须预留；不预留就会在
 * "输入刚好压线"的请求上被 429 打回来。
 */
export function estimateReservation(ctx, options, reserveOutputTokens) {
  const output = typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? Math.min(options.maxTokens, reserveOutputTokens)
    : reserveOutputTokens;
  return estimateInputTokens(ctx, options) + output;
}
