/**
 * lock.js —— 进程内异步互斥锁（全局锁）。
 *
 * 背景：DSH 的插件在每个 profile 内只加载一次、常驻，同一 profile 的多个
 * 会话共享同一个插件实例（同一份模块、同一套模块级全局）。计算机操作（观察 +
 * 点击/输入/滚动…）最终都作用在**同一块真实屏幕**上，并发会让两个会话的虚拟
 * 光标/焦点互相打乱。
 *
 * 因此对所有“触碰屏幕”的工具加一把全局锁：同一时刻只有一个会话能真正动屏幕。
 * 插件是单实例（单 Node 进程）的，进程内 Promise 队列即足够；跨 profile（多进程）
 * 的协调超出本锁范围（见 README “已知局限”）。
 *
 * 用法：
 *   const unlock = await acquire()
 *   try { ... } finally { unlock() }
 * 或语法糖：
 *   await withLock(() => doSomething())
 */

/**
 * @typedef {() => void} Release
 */

/** 持锁者信息（用于诊断/死锁排查）。 */
let _current = null
/** Promise 链尾，每个 acquire 挂到链尾，确保串行。 */
let _chain = Promise.resolve()
/**  awaiting 计数（仅用于测试/可观测性）。 */
let _waiters = 0

/**
 * 获取锁。若已被占用，返回的 Promise 会在前一个释放后才 resolve。
 * @param {string} [owner] 持锁者标识（如 session id），仅用于诊断。
 * @returns {Promise<Release>} resolve 后调用以释放锁。
 */
export function acquire(owner = 'anonymous') {
  _waiters++
  let release
  const next = new Promise((resolve) => { release = resolve })
  const prev = _chain
  _chain = prev.then(() => next)
  return prev.then(() => {
    _waiters--
    _current = owner
    return () => {
      if (_current === owner) _current = null
      release()
    }
  })
}

/**
 * 语法糖：在锁内执行异步函数，无论成败都会释放锁。
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {string} [owner]
 * @returns {Promise<T>}
 */
export async function withLock(fn, owner = 'anonymous') {
  const unlock = await acquire(owner)
  try {
    return await fn()
  } finally {
    unlock()
  }
}

/** 当前是否有会话持锁（诊断用）。 */
export function isLocked() {
  return _current !== null
}

/** 当前等待数（诊断用）。 */
export function waiterCount() {
  return _waiters
}
