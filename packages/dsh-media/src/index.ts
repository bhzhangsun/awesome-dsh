/**
 * @bhzhangsun/dsh-media
 *
 * Multimedia output support for DSH.
 *
 * Host half: registers the model-facing `media_render` tool, which serves a
 * local/remote media reference over HTTP and returns the browser-reachable URL.
 * The client half (see `./client/index.ts`) provides the `audio`/`video` chat
 * node renderers.
 */

export { apply, inject, name } from './tool.js'
export { mediaRenderResult, normalizeMediaItems } from './projection.js'
export { mediaItemsParameterSchema, mediaRenderOutputSchema } from './shared/schema.js'
export type * from './shared/types.js'
