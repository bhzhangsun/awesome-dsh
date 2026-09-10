import { z } from 'zod'
import type { MediaItem, MediaKind } from './types.js'

/** Valid media kinds, as a runtime list for narrowing in the tool. */
export const MEDIA_KINDS: readonly MediaKind[] = ['audio', 'video']

const MEDIA_ITEM_PROPERTIES = {
  kind: {
    type: 'string',
    required: true,
    enum: [...MEDIA_KINDS],
    description: 'Which player to render: audio or video.',
  },
  url: {
    type: 'string',
    required: true,
    description: 'Absolute http(s) URL, OR a local file path (absolute or workspace-relative) or file:// URL of a media file in the workspace.',
  },
  title: {
    type: 'string',
    description: 'Optional display title.',
  },
  poster: {
    type: 'string',
    description: 'Optional poster/frame image URL (video only).',
  },
  caption: {
    type: 'string',
    description: 'Optional caption below the player.',
  },
  mime: {
    type: 'string',
    description: 'Optional MIME hint, e.g. audio/mpeg or video/mp4.',
  },
  controls: {
    type: 'boolean',
    description: 'Show native controls (default true).',
  },
  autoplay: {
    type: 'boolean',
    description: 'Start playback automatically (default false).',
  },
  loop: {
    type: 'boolean',
    description: 'Loop playback (default false).',
  },
} as const

/** JSON-schema-style tool parameter schema for the `media_render` tool. */
export const mediaItemsParameterSchema = {
  items: {
    type: 'array',
    required: true,
    description: 'Media items to render into the conversation.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: MEDIA_ITEM_PROPERTIES,
    },
  },
} as const

/** JSON-schema-style tool output schema for the `media_render` tool. */
export const mediaRenderOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: MEDIA_ITEM_PROPERTIES,
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        audio: { type: 'integer', required: true },
        video: { type: 'integer', required: true },
      },
    },
  },
} as const

/** zod schema for one media item (used by the session projection read path). */
export const mediaItemSchema = z.object({
  kind: z.enum(MEDIA_KINDS),
  url: z.string(),
  title: z.string().optional(),
  poster: z.string().optional(),
  caption: z.string().optional(),
  mime: z.string().optional(),
  controls: z.boolean().optional(),
  autoplay: z.boolean().optional(),
  loop: z.boolean().optional(),
})

/** zod schema for the whole media list exposed by the `mediaEntries` projection. */
export const mediaEntriesSchema = z.array(mediaItemSchema)

/**
 * Validate and normalize raw model-supplied media items into canonical
 * {@link MediaItem}s. `url` may be an absolute http(s) URL OR a local reference
 * (absolute/workspace-relative path or a `file://` URL) — the host resolves
 * local references to a served http URL at tool-execution time.
 */
export function toMediaItems(raw: readonly unknown[]): MediaItem[] {
  const items: MediaItem[] = []
  for (const entry of raw) {
    const parsed = mediaItemSchema.parse(entry)
    if (parsed.url.length === 0) throw new Error('media url must not be empty')
    items.push(parsed)
  }
  return items
}

/** Whether a media reference is a browser-reachable absolute http(s) URL. */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
