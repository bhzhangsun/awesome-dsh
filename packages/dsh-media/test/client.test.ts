// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:43120/"}
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineMedia } from '../src/client/InlineMedia.js'
import { resolveMediaSrc } from '../src/client/mediaUrl.js'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('resolveMediaSrc', () => {
  it('re-homes a loopback /media url onto the origin serving this page', () => {
    // The url was minted by a process listening elsewhere (another port, localhost).
    expect(resolveMediaSrc('http://127.0.0.1:51234/media/abc123')).toBe('http://127.0.0.1:43120/media/abc123')
    expect(resolveMediaSrc('http://localhost:9999/media/abc123')).toBe('http://127.0.0.1:43120/media/abc123')
    expect(resolveMediaSrc('http://0.0.0.0:80/media/abc123')).toBe('http://127.0.0.1:43120/media/abc123')
  })

  it('keeps the query string and leaves a same-origin url untouched', () => {
    expect(resolveMediaSrc('http://127.0.0.1:43120/media/abc?x=1')).toBe('http://127.0.0.1:43120/media/abc?x=1')
  })

  it('leaves everything that is not this server’s /media route alone', () => {
    expect(resolveMediaSrc('https://example.com/media/abc')).toBe('https://example.com/media/abc')
    expect(resolveMediaSrc('https://cdn.example.com/clip.mp3')).toBe('https://cdn.example.com/clip.mp3')
    expect(resolveMediaSrc('http://127.0.0.1:43120/other/abc')).toBe('http://127.0.0.1:43120/other/abc')
    expect(resolveMediaSrc('/media/abc')).toBe('http://127.0.0.1:43120/media/abc')
    expect(resolveMediaSrc('')).toBe('')
  })
})

describe('InlineMedia load failure', () => {
  let container: HTMLDivElement
  let root: Root
  let errors: unknown[][]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
    // jsdom has no media stack: `load()` would only log "not implemented".
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const render = (items: Parameters<typeof InlineMedia>[0]['items']) => {
    act(() => root.render(createElement(InlineMedia, { items })))
  }

  it('shows what went wrong instead of a bar stuck at 0:00', () => {
    render([{ kind: 'audio', url: 'http://127.0.0.1:1/media/gone.mp3', title: 'gone.mp3' }])
    const audio = container.querySelector('audio')
    expect(audio).not.toBeNull()
    expect(audio?.getAttribute('src')).toBe('http://127.0.0.1:43120/media/gone.mp3')

    act(() => { audio?.dispatchEvent(new Event('error')) })

    const notice = container.querySelector('.dsh-media-block__missing')
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toContain('Media unavailable')
    expect(notice?.textContent).toContain('gone.mp3')
    // The dead bar is gone; the caption below it survives.
    expect(container.querySelector('.dsh-media-block__audio-bar')).toBeNull()
  })

  it('retries the same element and restores the bar', () => {
    render([{ kind: 'audio', url: '/media/gone.mp3', title: 'gone.mp3' }])
    const audio = container.querySelector('audio')
    act(() => { audio?.dispatchEvent(new Event('error')) })

    const retry = container.querySelector<HTMLButtonElement>('.dsh-media-block__missing-retry')
    expect(retry).not.toBeNull()
    act(() => retry?.click())

    expect(container.querySelector('.dsh-media-block__missing')).toBeNull()
    expect(container.querySelector('.dsh-media-block__audio-bar')).not.toBeNull()
  })

  it('replaces an unplayable video with the same notice', () => {
    render([{ kind: 'video', url: '/media/gone.mp4', title: 'gone.mp4', caption: 'demo' }])
    const video = container.querySelector('video')
    expect(video).not.toBeNull()

    act(() => { video?.dispatchEvent(new Event('error')) })

    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('.dsh-media-block__missing')?.textContent).toContain('gone.mp4')
    expect(container.querySelector('.dsh-media-block__caption')?.textContent).toBe('demo')
  })

  it('renders the caption and title of a healthy player without a notice', () => {
    render([{ kind: 'video', url: '/media/ok.mp4', title: 'ok.mp4', caption: 'demo' }])
    expect(container.querySelector('.dsh-media-block__missing')).toBeNull()
    expect(container.querySelector('video')?.getAttribute('src')).toBe('http://127.0.0.1:43120/media/ok.mp4')
  })
})
