import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import type { MediaItem } from '../shared/types.js'
import { InlineMedia } from './InlineMedia.js'

const FENCE_LANG = 'dsh-media'
// DSH's CodeBlock (packages/client/ui-primitives/src/markdown/CodeBlock.tsx)
// renders a wrapper with the stable static class `md-code-block`; the fence info
// string sits in an `.infostring` child, and the <code> element carries NO
// `language-*` class and NO `data-lang` attribute. So match the wrapper and test
// the info string / JSON body instead of any language class.
const FENCE_SELECTOR = '.md-code-block'

interface MountedFence {
  fence: Element
  container: HTMLElement
  root: Root
}

const mounted = new WeakMap<Element, MountedFence>()
const mountedByContainer = new Map<HTMLElement, MountedFence>()
let observer: MutationObserver | null = null

function extractFenceCode(fence: Element): string {
  const code = fence.querySelector('code')
  if (code) return code.textContent ?? ''
  return fence.textContent ?? ''
}

function getCodeBlockLang(block: Element): string {
  const info = block.querySelector('[class*="infostring"], [class*="info-string"]')
  if (info) return (info.textContent ?? '').trim()
  const banner = block.querySelector('[class*="banner"]')
  if (banner) return (banner.textContent ?? '').trim()
  return ''
}

function isMediaFence(el: Element): boolean {
  const block = el.matches('.md-code-block') ? el : el.closest('.md-code-block')
  if (block === null) return false
  // Primary: DSH shows the fence info string in the banner.
  if (getCodeBlockLang(block) === FENCE_LANG) return true
  // Fallback: the code body parses as a dsh-media items block.
  return parseMediaFence(block) !== null
}

function parseMediaFence(fence: Element): MediaItem[] | null {
  const raw = extractFenceCode(fence).trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.items)) {
      const items = parsed.items as MediaItem[]
      const valid = items.length > 0 && items.every(
        (item) => item !== null
          && (item.kind === 'audio' || item.kind === 'video')
          && typeof item.url === 'string' && item.url.length > 0,
      )
      if (valid) return items
    }
  } catch (err) {
    console.warn('[dsh-media] failed to parse dsh-media fence:', err)
  }
  return null
}

function renderFence(fence: Element): void {
  if (mounted.has(fence)) return
  const items = parseMediaFence(fence)
  if (!items || items.length === 0) return

  const container = document.createElement('span')
  container.className = 'dsh-media-block__mount'

  const parent = fence.parentElement
  if (!parent) return

  parent.insertBefore(container, fence.nextSibling)
  fence.setAttribute('hidden', '')
  fence.setAttribute('aria-hidden', 'true')

  const root = createRoot(container)
  root.render(createElement(InlineMedia, { items }))

  const entry: MountedFence = { fence, container, root }
  mounted.set(fence, entry)
  mountedByContainer.set(container, entry)
}

function unmountEntry(entry: MountedFence): void {
  entry.root.unmount()
  entry.container.remove()
  entry.fence.removeAttribute('hidden')
  entry.fence.removeAttribute('aria-hidden')
  mounted.delete(entry.fence)
  mountedByContainer.delete(entry.container)
}

function scanAndRender(root: Element = document.body): void {
  const fences = root.querySelectorAll(FENCE_SELECTOR)
  fences.forEach((fence) => {
    if (isMediaFence(fence)) renderFence(fence)
  })

  // Unmount entries whose container is no longer connected.
  ;[...mountedByContainer.values()].forEach((entry) => {
    if (!document.contains(entry.container)) {
      unmountEntry(entry)
    }
  })
}

export function installFenceRenderer(): () => void {
  if (typeof document === 'undefined') return () => {}

  scanAndRender()

  observer = new MutationObserver((mutations) => {
    let shouldScan = false
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          shouldScan = true
          break
        }
      }
      if (!shouldScan) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            shouldScan = true
            break
          }
        }
      }
      if (shouldScan) break
    }
    if (shouldScan) scanAndRender()
  })

  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer?.disconnect()
    observer = null
    mountedByContainer.forEach((entry) => unmountEntry(entry))
  }
}
