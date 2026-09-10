/**
 * Shared media contract for the @bhzhangsun/dsh-media plugin.
 *
 * Used on both halves:
 * - the HOST ({@link ../tool.ts}) resolves a model-supplied item to a browser
 *   URL and returns it from the `media_render` tool; and
 * - the CLIENT ({@link ../client/fenceRenderer.ts}) renders the block-level
 *   player for a `dsh-media` fence in the assistant message body.
 */

/** Media categories the plugin can render today. Extend this union to add more. */
export type MediaKind = 'audio' | 'video'

/** A single media item the agent asks to render into the conversation. */
export interface MediaItem {
  /** Kind of player to render. */
  kind: MediaKind
  /** Absolute http(s) media URL (the host rewrites local paths to one). */
  url: string
  /** Optional display title: the audio bar's file name, or the video's hover label. */
  title?: string
  /** Optional poster/frame image URL (video). */
  poster?: string
  /** Optional caption rendered below the player. */
  caption?: string
  /** Optional MIME hint (e.g. `audio/mpeg`). */
  mime?: string
}

/** Tool-call result shape returned by `media_render`. */
export interface MediaRenderResult {
  items: MediaItem[]
  counts: {
    audio: number
    video: number
  }
}
