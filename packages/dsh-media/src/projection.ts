import { mediaItemsParameterSchema, mediaRenderOutputSchema, toMediaItems } from './shared/schema.js'
import type { MediaItem, MediaRenderResult } from './shared/types.js'

/** Build the model-facing result/value returned by `media_render`. */
export function mediaRenderResult(items: MediaItem[]): MediaRenderResult {
  const counts = { audio: 0, video: 0 }
  for (const item of items) counts[item.kind] += 1
  return { items, counts }
}

/** Validate and narrow raw tool parameters into canonical media items. */
export function normalizeMediaItems(raw: unknown): MediaItem[] {
  const input = Array.isArray(raw) ? raw : []
  return toMediaItems(input)
}

export { mediaItemsParameterSchema, mediaRenderOutputSchema }
