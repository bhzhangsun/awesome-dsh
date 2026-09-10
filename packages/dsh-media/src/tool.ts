import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isHttpUrl, mediaItemsParameterSchema, mediaRenderOutputSchema } from './shared/schema.js'
import type { MediaItem } from './shared/types.js'
import { mediaRenderResult, normalizeMediaItems } from './projection.js'
import { publishMediaUrl, registerMediaRoute, resolveMediaFile } from './mediaServer.js'
import { MEDIA_SKILL_CONTENT, MEDIA_SKILL_DESCRIPTION, MEDIA_SKILL_NAME } from './skillContent.js'

const TOOL_NAME = 'media_render'

const DESCRIPTION = [
  'Render one or more audio/video media items into the current conversation as a playable URL.',
  'Call this after you have produced (or fetched) a media file the user should see or hear.',
  'Each item is either an absolute http(s) URL, or a local media file path (absolute or',
  'workspace-relative, or a file:// URL). Local files are served to the browser over HTTP, and the',
  'result carries the browser-reachable http URL(s).',
  '',
  'After calling this tool, embed the resolved media URL(s) in your final assistant reply using a',
  '`dsh-media` fenced code block so the UI renders an inline player. Example:\n',
  '```dsh-media',
  '{"items":[{"kind":"audio","url":"<resolved_url>","title":"Optional title"}]}',
  '```',
].join(' ')

export function apply(ctx: Context): void {
  ctx.logger.info('[dsh-media] activating media_render tool + /media file route')

  ctx.effect(() => registerMediaRoute(ctx), 'dsh-media: media file route')

  const skills = ctx.get('skills')
  if (skills !== undefined) {
    ctx.effect(
      () => skills.register({
        name: MEDIA_SKILL_NAME,
        description: MEDIA_SKILL_DESCRIPTION,
        content: MEDIA_SKILL_CONTENT,
        source: '@bhzhangsun/dsh-media',
        invocation: { modelInvocable: true, userInvocable: false },
      }),
      'dsh-media: runtime skill',
    )
  }

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: mediaItemsParameterSchema,
    output: {
      schema: mediaRenderOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Media rendered (${value.counts.audio} audio, ${value.counts.video} video).`,
          ...value.items.map((item) => `- ${item.kind}: ${item.url}${item.title ? ` (${item.title})` : ''}`),
        ].join('\n'),
      }],
      // Carries the resolved media items (with browser URLs) onto the result
      // meta (`meta.dshMedia`) for tool-result consumers. The player itself is
      // rendered by the client fence renderer from the assistant's `dsh-media`
      // fence — not from this tool result.
      presentationMeta: (_args, value) => ({ dshMedia: value.items }),
    },
    execute(args, exec) {
      const items = normalizeMediaItems(args.items)
      if (items.length === 0) {
        ctx.logger.warn('[dsh-media] media_render called with no items')
        return Promise.reject(new Error('media_render requires at least one media item'))
      }

      const cwd = (exec.agent?.session.header as { cwd?: string } | undefined)?.cwd
      const resolved: MediaItem[] = []
      for (const item of items) {
        if (isHttpUrl(item.url)) {
          resolved.push({ ...item })
          continue
        }
        const absPath = resolveMediaFile(cwd, item.url)
        if (absPath === null) {
          const message = `media url is neither http(s) nor a resolvable local file: ${JSON.stringify(item.url)}`
          ctx.logger.error(`[dsh-media] ${message}`)
          return Promise.reject(new Error(message))
        }
        const url = publishMediaUrl(ctx, absPath)
        if (url === undefined) {
          const message = 'host webserver is not ready to serve media'
          ctx.logger.error(`[dsh-media] ${message}`)
          return Promise.reject(new Error(message))
        }
        ctx.logger.info(`[dsh-media] resolved ${JSON.stringify(item.url)} -> ${url}`)
        resolved.push({ ...item, url })
      }

      ctx.logger.info(`[dsh-media] published ${resolved.length} media URL(s)`)
      return Promise.resolve(mediaRenderResult(resolved))
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Render media',
      kind: 'other',
      rawInput: args.items,
    }),
  }))

  ctx.logger.info('[dsh-media] activated')
}

export const name = 'media'
export const inject = ['tools', 'webServer']
