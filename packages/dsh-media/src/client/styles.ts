const STYLE_TAG_ID = '@bhzhangsun/dsh-media/styles.css'

const CSS = `
/* Fence-rendered media blocks (rendered in the assistant message body). */
.dsh-media-block__mount {
  display: block;
}
.dsh-media-block__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-media-block__caption {
  font-size: 12px;
  color: color-mix(in srgb, currentColor 78%, transparent);
}

/* Audio: custom single-row player bar (always visible). */
.dsh-media-block__audio {
  display: block;
}
.dsh-media-block__audio-src {
  display: none;
}
.dsh-media-block__audio-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  color: currentColor;
  color-scheme: dark light;
}
.dsh-media-block__audio-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 0;
}
.dsh-media-block__audio-play,
.dsh-media-block__audio-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: currentColor;
  cursor: pointer;
}
.dsh-media-block__audio-play:hover,
.dsh-media-block__audio-icon:hover {
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-media-block__audio-name {
  /* Fixed-width name column: a long name ellipsizes; a short one keeps the
     column width, so the seek bar always starts at the same place. */
  flex: 0 0 160px;
  width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.dsh-media-block__audio-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  margin-left: auto;
}
.dsh-media-block__audio-range {
  flex: 1;
  min-width: 60px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
}
.dsh-media-block__audio-range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    currentColor 0,
    currentColor var(--dsh-progress, 0%),
    color-mix(in srgb, currentColor 20%, transparent) var(--dsh-progress, 0%),
    color-mix(in srgb, currentColor 20%, transparent) 100%
  );
}
.dsh-media-block__audio-range::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 9px;
  height: 9px;
  margin-top: -3px;
  border: none;
  border-radius: 50%;
  background: currentColor;
}
.dsh-media-block__audio-range::-moz-range-track {
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, currentColor 20%, transparent);
}
.dsh-media-block__audio-range::-moz-range-progress {
  height: 3px;
  border-radius: 2px;
  background: currentColor;
}
.dsh-media-block__audio-range::-moz-range-thumb {
  width: 9px;
  height: 9px;
  border: none;
  border-radius: 50%;
  background: currentColor;
}
.dsh-media-block__audio-time {
  font-size: 11px;
  white-space: nowrap;
  color: color-mix(in srgb, currentColor 72%, transparent);
  font-variant-numeric: tabular-nums;
}
.dsh-media-block__audio-rate {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* Video: native controls, full width, no overlay. The file name is overlaid on
   the top-left corner of the video and revealed on hover only. */
.dsh-media-block__video {
  position: relative;
  display: block;
  width: 100%;
}
.dsh-media-block__video-player {
  display: block;
  width: 100%;
  max-width: 100%;
  border-radius: 6px;
  color-scheme: dark light;
}
.dsh-media-block__video-title {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 16px);
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.dsh-media-block__video:hover .dsh-media-block__video-title {
  opacity: 1;
}
`

export function installMediaStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
  if (existing) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@bhzhangsun/dsh-media'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
