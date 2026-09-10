import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { installFenceRenderer } from './fenceRenderer.js'
import { installMediaStyles } from './styles.js'

/**
 * Client half of @bhzhangsun/dsh-media.
 *
 * Media is rendered in the **final assistant message body**, not as a folded
 * `tool/result` node: the fence renderer scans assistant replies for
 * ` ```dsh-media ` code fences and replaces each one with a block-level player.
 * Because the player lives in the message body, it stays visible even when the
 * turn-process disclosure is folded.
 */
export function apply(ctx: ClientContext): void {
  console.info('[dsh-media] client apply: fence renderer + styles')
  ctx.effect(() => installMediaStyles(), 'dsh-media: styles')
  ctx.effect(() => installFenceRenderer(), 'dsh-media: fence renderer')
}
