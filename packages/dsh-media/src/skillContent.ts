export const MEDIA_SKILL_NAME = 'dsh-media'

export const MEDIA_SKILL_DESCRIPTION =
  'Render audio/video players in the assistant reply by emitting a dsh-media fenced code block.'

export const MEDIA_SKILL_CONTENT = `
When you call the \`media_render\` tool and want the user to see or hear the result, put a \`dsh-media\` fenced code block in your final assistant reply. The UI replaces that fence with a block-level player in the message body.

Fence syntax:

\`\`\`dsh-media
{"items":[{"kind":"audio","url":"<resolved_url>","title":"Optional title"}]}
\`\`\`

- \`kind\`: \`"audio"\` or \`"video"\`
- \`url\`: the browser URL returned by \`media_render\`
- \`title\`: the audio bar's file name, or the video's hover label
- \`caption\`: optional note rendered below the player
- \`poster\`: optional video cover image URL

Behavior:
- \`audio\` renders as a block-level player bar: play/pause + file name on the left, seek bar + time + mute + playback rate on the right.
- \`video\` renders as a block-level native player at full width; the file name overlays its top-left corner on hover.

Example after \`media_render\` returns an audio URL:

\`\`\`dsh-media
{"items":[{"kind":"audio","url":"http://127.0.0.1:43120/media/abc123","title":"greeting.mp3"}]}
\`\`\`

Do not explain the JSON; just emit the fence.
`.trim()
