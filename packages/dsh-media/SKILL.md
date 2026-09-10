# dsh-media

When you call `media_render` and want the user to actually see or hear the result, put a `dsh-media` fenced code block in your final assistant reply. The UI replaces that fence with a block-level player in the message body.

## Syntax

```dsh-media
{"items":[{"kind":"audio","url":"<resolved_url>","title":"Optional title"}]}
```

- `kind`: `"audio"` or `"video"`
- `url`: the browser-reachable URL returned by `media_render` (already http(s) or `/media/<token>`)
- `title`: the audio bar's file name, or the video's hover label
- `caption`: optional short note rendered below the player
- `poster`: optional video cover image URL

## Behavior

- `audio` renders as a block-level player bar: play/pause + file name on the left; seek bar + time + mute + playback rate on the right.
- `video` renders as a block-level native player at full width; the file name overlays its top-left corner on hover.

## Example

User: "播放一下刚才生成的音频"

You (after `media_render` returns `{items:[{kind:"audio",url:"http://127.0.0.1:43120/media/abc123",title:"greeting.mp3"}]}`):

```dsh-media
{"items":[{"kind":"audio","url":"http://127.0.0.1:43120/media/abc123","title":"greeting.mp3"}]}
```

That's it. Do not explain the JSON; just emit the fence.
