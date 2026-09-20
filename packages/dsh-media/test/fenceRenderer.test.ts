// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFenceRenderer } from '../src/client/fenceRenderer.js'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUDIO_ITEMS = JSON.stringify({
  items: [{ kind: 'audio', url: 'http://127.0.0.1:1/media/a.mp3', title: 'clip.mp3' }],
})

interface FenceSpec {
  lang: string
  body: string
  /** Bump to make React mount a brand-new `.md-code-block` element (page churn). */
  revision?: number
}

/** The DOM shape DSH's CodeBlock actually renders (see the module header). */
function CodeBlock({ lang, body }: { lang: string; body: string }) {
  return createElement(
    'div',
    { className: 'md-code-block' },
    createElement('div', { className: 'banner' }, createElement('div', { className: 'infostring' }, lang)),
    createElement('pre', null, createElement('code', null, body)),
  )
}

function Message({ fences, revision = 0 }: { fences: FenceSpec[]; revision?: number }) {
  return createElement(
    'div',
    { className: 'markdown' },
    fences.map((fence, index) => createElement(CodeBlock, {
      key: `${index}:${revision}:${fence.revision ?? 0}`,
      lang: fence.lang,
      body: fence.body,
    })),
  )
}

const MEDIA_FENCE: FenceSpec = { lang: 'dsh-media', body: AUDIO_ITEMS }

let host: HTMLElement
let root: Root
let dispose: (() => void) | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // The renderer mounts players from a mutation-observer microtask, outside any
  // act() scope; that is exactly the production path, so drop React's advisory.
  const original = console.error
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return
    original(...args)
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  dispose?.()
  dispose = undefined
  host.remove()
  vi.restoreAllMocks()
})

/** Render into the host and return once React, the observer, and the flush settle. */
async function render(element: Parameters<Root['render']>[0]): Promise<void> {
  await act(async () => {
    root.render(element)
  })
  await settle()
}

/** Flush the mutation observer, its queued microtask flush, and React's work. */
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Install the renderer the way the client half does, then let it settle. */
async function install(): Promise<void> {
  await act(async () => {
    dispose = installFenceRenderer()
  })
  await settle()
}

async function mutate(action: () => void): Promise<void> {
  await act(async () => {
    action()
  })
  await settle()
}

function audioElement(index = 0): HTMLAudioElement {
  const found = document.querySelectorAll('audio')[index]
  if (found === undefined) throw new Error(`no <audio> at index ${index}`)
  return found
}

function mounts(): NodeListOf<Element> {
  return document.querySelectorAll('.dsh-media-block__mount')
}

describe('installFenceRenderer', () => {
  it('replaces a media fence with one player and hides the fence', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()

    expect(mounts()).toHaveLength(1)
    expect(document.querySelectorAll('audio')).toHaveLength(1)
    expect(document.querySelector('.md-code-block')?.hasAttribute('hidden')).toBe(true)
    expect(host.textContent).toContain('clip.mp3')
  })

  it('ignores fences that are not media blocks', async () => {
    await render(createElement(Message, {
      fences: [
        { lang: 'json', body: '{ "not": "media" }' },
        { lang: 'dsh-media', body: '{ "items": [] }' },
        { lang: 'dsh-media', body: '{ "items": [{"kind":"audio"}] }' },
      ],
    }))
    await install()

    expect(mounts()).toHaveLength(0)
    expect(document.querySelector('.md-code-block')?.hasAttribute('hidden')).toBe(false)
  })

  it('keeps the same player when React replaces the fence element', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()
    const audio = audioElement()

    // A new key makes React unmount the fence and mount a fresh element — the
    // churn every streaming render produces.
    await render(createElement(Message, { fences: [{ ...MEDIA_FENCE, revision: 1 }] }))

    expect(audioElement()).toBe(audio)
    expect(mounts()).toHaveLength(1)
    expect(document.querySelectorAll('audio')).toHaveLength(1)
  })

  it('keeps the same player when the whole message subtree is rebuilt', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE], revision: 0 }))
    await install()
    const audio = audioElement()

    await render(createElement(Message, { fences: [MEDIA_FENCE], revision: 1 }))

    expect(audioElement()).toBe(audio)
    expect(document.querySelectorAll('audio')).toHaveLength(1)
  })

  it('keeps player state (mute) across a rebuild', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()
    const audio = audioElement()

    const mute = document.querySelector<HTMLButtonElement>('[aria-label="Mute"]')
    expect(mute).not.toBeNull()
    await mutate(() => mute?.click())
    expect(audio.muted).toBe(true)

    await render(createElement(Message, { fences: [{ ...MEDIA_FENCE, revision: 7 }] }))

    expect(audioElement()).toBe(audio)
    expect(audioElement().muted).toBe(true)
  })

  it('keeps several players distinct and reuses each of them', async () => {
    const second: FenceSpec = {
      lang: 'dsh-media',
      body: JSON.stringify({ items: [{ kind: 'video', url: 'http://127.0.0.1:1/media/b.mp4' }] }),
    }
    await render(createElement(Message, { fences: [MEDIA_FENCE, second] }))
    await install()
    const [audio, video] = [audioElement(), document.querySelectorAll('video')[0]]

    await render(createElement(Message, { fences: [{ ...MEDIA_FENCE, revision: 2 }, { ...second, revision: 2 }] }))

    expect(mounts()).toHaveLength(2)
    expect(audioElement()).toBe(audio)
    expect(document.querySelectorAll('video')[0]).toBe(video)
  })

  it('updates a fence in place when its items change', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()
    const audio = audioElement()

    const renamed = JSON.stringify({
      items: [{ kind: 'audio', url: 'http://127.0.0.1:1/media/a.mp3', title: 'renamed.mp3' }],
    })
    await render(createElement(Message, { fences: [{ lang: 'dsh-media', body: renamed }] }))

    expect(document.querySelector('.dsh-media-block__audio-name')?.textContent).toBe('renamed.mp3')
    // Same url, same key: React keeps the very same <audio> element (no reload).
    expect(audioElement()).toBe(audio)
    expect(mounts()).toHaveLength(1)
  })

  it('does no full-page scan and no re-parse for unrelated page updates', async () => {
    await render(createElement(Message, {
      fences: [MEDIA_FENCE, { lang: 'js', body: 'const answer = 42' }],
    }))
    await install()
    const audio = audioElement()

    const parse = vi.spyOn(JSON, 'parse')
    const query = vi.spyOn(Element.prototype, 'querySelectorAll')
    const bodyScans = (): number => query.mock.instances.filter((instance) => instance === document.body).length

    await mutate(() => {
      document.body.appendChild(document.createElement('div'))
      const code = document.querySelectorAll('code')[1]
      if (code !== null) code.textContent = 'const answer = 43'
    })
    await mutate(() => {
      document.querySelector('code[dsh-probe]')?.remove()
    })

    expect(bodyScans()).toBe(0)
    expect(parse).not.toHaveBeenCalled()
    expect(audioElement()).toBe(audio)
  })

  it('parks the player — no stray block — while its fence is replaced', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()
    const audio = audioElement()

    // A new key unmounts the media block and mounts an unrelated one: the player
    // is taken out of the page, but its <audio> element is kept for the grace
    // period, so the fence coming back does not restart playback.
    await render(createElement(Message, {
      fences: [{ lang: 'js', body: 'const answer = 42', revision: 9 }],
    }))
    expect(mounts()).toHaveLength(0)

    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    expect(mounts()).toHaveLength(1)
    expect(audioElement()).toBe(audio)
  })

  it('renders a fresh player for a fence that returns after the grace period', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()
    const audio = audioElement()

    await render(createElement(Message, {
      fences: [{ lang: 'js', body: 'const answer = 42', revision: 9 }],
    }))
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))

    expect(mounts()).toHaveLength(1)
    expect(document.querySelectorAll('audio')).toHaveLength(1)
    expect(audioElement()).not.toBe(audio)
  })

  it('hands a repurposed block back instead of hiding it', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    await install()

    // Same DOM node, same position, different language: React reused the block.
    await render(createElement(Message, { fences: [{ lang: 'js', body: AUDIO_ITEMS }] }))

    expect(mounts()).toHaveLength(0)
    expect(document.querySelector('.md-code-block')?.hasAttribute('hidden')).toBe(false)
  })

  it('restores the fences when the renderer is disposed', async () => {
    await render(createElement(Message, { fences: [MEDIA_FENCE] }))
    const uninstall = installFenceRenderer()
    await settle()
    expect(mounts()).toHaveLength(1)

    await mutate(() => uninstall())

    expect(mounts()).toHaveLength(0)
    expect(document.querySelector('.md-code-block')?.hasAttribute('hidden')).toBe(false)
  })
})
