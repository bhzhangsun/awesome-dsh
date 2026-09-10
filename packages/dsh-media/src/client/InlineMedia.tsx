import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MediaItem } from '../shared/types.js'

interface InlineMediaProps {
  items: MediaItem[]
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {muted ? (
        <>
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : (
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      )}
    </svg>
  )
}

const RATES = [1, 1.25, 1.5, 2]

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatRate(rate: number): string {
  const text = rate.toFixed(2).replace(/\.?0+$/, '')
  return `${text}x`
}

// Block-level audio: a custom single-row player bar (always visible).
// Left = play + file name; right = seek bar + time + volume + playback rate.
function InlineAudio({ item }: { item: MediaItem }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)

  const togglePlay = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) void a.play().catch(() => {})
    else a.pause()
  }
  const toggleMute = () => {
    const a = audioRef.current
    if (!a) return
    const next = !a.muted
    a.muted = next
    setMuted(next)
  }
  const cycleRate = () => {
    const a = audioRef.current
    if (!a) return
    const idx = RATES.indexOf(rate)
    const next = RATES[(idx + 1) % RATES.length] ?? 1
    a.playbackRate = next
    setRate(next)
  }
  const seek = (value: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = value
    setCurrent(value)
  }

  return (
    <span className="dsh-media-block__audio">
      <audio
        ref={audioRef}
        src={item.url}
        preload="metadata"
        className="dsh-media-block__audio-src"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          setDuration(typeof d === 'number' && Number.isFinite(d) ? d : 0)
        }}
      />
      <span className="dsh-media-block__audio-bar">
        <span className="dsh-media-block__audio-left">
          <button
            type="button"
            className="dsh-media-block__audio-play"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="dsh-media-block__audio-name" title={item.title}>{item.title || 'audio'}</span>
        </span>
        <span className="dsh-media-block__audio-right">
          <input
            type="range"
            className="dsh-media-block__audio-range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(current, duration || 0)}
            disabled={duration === 0}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
            style={{ '--dsh-progress': `${duration > 0 ? Math.min(100, (Math.min(current, duration) / duration) * 100) : 0}%` } as CSSProperties}
          />
          <span className="dsh-media-block__audio-time">{formatTime(current)} / {formatTime(duration)}</span>
          <button
            type="button"
            className="dsh-media-block__audio-icon"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            <VolumeIcon muted={muted} />
          </button>
          <button
            type="button"
            className="dsh-media-block__audio-icon dsh-media-block__audio-rate"
            onClick={cycleRate}
            aria-label="Playback rate"
          >
            {formatRate(rate)}
          </button>
        </span>
      </span>
      {item.caption ? <span className="dsh-media-block__caption">{item.caption}</span> : null}
    </span>
  )
}

// Block-level video: render the native <video controls> directly, full width —
// no placeholder and no overlay popover.
function InlineVideo({ item }: { item: MediaItem }) {
  return (
    <span className="dsh-media-block__video">
      <video
        src={item.url}
        controls
        preload="metadata"
        poster={item.poster}
        className="dsh-media-block__video-player"
      />
      {item.title ? <span className="dsh-media-block__video-title">{item.title}</span> : null}
      {item.caption ? <span className="dsh-media-block__caption">{item.caption}</span> : null}
    </span>
  )
}

export function InlineMedia({ items }: InlineMediaProps) {
  return (
    <span className="dsh-media-block__group">
      {items.map((item, index) => {
        const key = `${item.kind}-${index}-${item.url}`
        if (item.kind === 'video') {
          return <InlineVideo key={key} item={item} />
        }
        return <InlineAudio key={key} item={item} />
      })}
    </span>
  )
}
