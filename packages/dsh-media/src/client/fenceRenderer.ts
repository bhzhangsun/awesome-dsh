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
const MOUNT_CLASS = 'dsh-media-block__mount'
const MOUNT_SELECTOR = `.${MOUNT_CLASS}`

// A code block is NOT a stable DOM node: the conversation re-renders
// continuously (streaming markdown, fold/unfold, repaging, snapshot refetch) and
// React replaces a fence element — or an entire message subtree — with fresh
// nodes. Rebuilding the player on every such replacement drops the
// <audio>/<video> element, which restarts playback and refetches metadata once
// per player on the page. So a mount outlives its fence for a grace period and
// is re-homed onto the equivalent fence (identical items) or re-attached to the
// same fence, instead of being unmounted and recreated. Only a fence that stays
// gone for the whole grace period tears its player down.
//
// Everything here is on demand. A mutation batch is only examined when it adds,
// removes, or edits a fence (or pulls one of our containers out of the tree);
// fences are parsed once per body revision and re-rendered only when their items
// actually change; churn inside a player (its seek bar, its timer) never
// schedules work at all.
const PARK_GRACE_MS = 1_000
// Hard cap on parked mounts, so a page that drops many messages cannot retain
// detached players forever.
const MAX_PARKED = 32

interface ParsedFence {
  items: MediaItem[]
  /** Content identity of the items: the unit of mount reuse (and of updates). */
  key: string
}

interface MountedFence {
  /** The fence this mount is currently anchored to (re-homed on replacement). */
  fence: Element
  container: HTMLElement
  root: Root
  /** Content identity of what the root currently renders. */
  itemsKey: string
  /** Set while the fence is out of the document; null while anchored. */
  parkedAt: number | null
  /** Set when the container must be (re)inserted next to its fence. */
  needsPlacement: boolean
}

const byFence = new WeakMap<Element, MountedFence>()
const byContainer = new WeakMap<Element, MountedFence>()
const entries = new Set<MountedFence>()
/** Parked mounts, most recently parked last, indexed by content identity. */
const parkedByKey = new Map<string, MountedFence[]>()
const parked = new Set<MountedFence>()
/**
 * Parse memo per fence element. While a reply streams, the same fence body is
 * re-read on every mutation; the body only changes when its text — or the info
 * string above it — changes.
 */
const parseMemo = new WeakMap<Element, { raw: string; lang: string; parsed: ParsedFence | null }>()

/** Fences whose content may need mounting, adopting, or updating. */
const candidates = new Set<Element>()

let observer: MutationObserver | null = null
let cleanupTimer: ReturnType<typeof setTimeout> | null = null
let flushQueued = false

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

function itemsKey(items: MediaItem[]): string {
  return items
    .map((item) => [
      item.kind,
      item.url,
      item.title ?? '',
      item.poster ?? '',
      item.caption ?? '',
      item.mime ?? '',
    ].join('\u0000'))
    .join('\u0001')
}

function parseMediaFence(raw: string, lang: string): ParsedFence | null {
  if (raw.length === 0) return null
  // Gate before JSON.parse: a dsh-media body is a JSON object (the fence info
  // string normally shows in the banner, but the body is the reliable signal).
  const declared = lang === FENCE_LANG
  if (!raw.startsWith('{') && !declared) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const body = parsed as { items?: unknown }
      if (Array.isArray(body.items)) {
        const items = body.items as MediaItem[]
        const valid = items.length > 0 && items.every(
          (item) => item !== null
            && typeof item === 'object'
            && (item.kind === 'audio' || item.kind === 'video')
            && typeof item.url === 'string' && item.url.length > 0,
        )
        if (valid) return { items, key: itemsKey(items) }
      }
    }
  } catch {
    // A streaming body is incomplete by design; only a closed one is a problem.
  }
  // A complete body that still is not a media fence is worth reporting — a
  // half-written one (the normal streaming case) is not.
  if (declared && raw.endsWith('}')) {
    console.warn('[dsh-media] ignoring malformed dsh-media fence')
  }
  return null
}

/** Parse one fence, memoized on its raw body and info string. */
function readFence(fence: Element): ParsedFence | null {
  const raw = extractFenceCode(fence).trim()
  const lang = getCodeBlockLang(fence)
  const memo = parseMemo.get(fence)
  if (memo !== undefined && memo.raw === raw && memo.lang === lang) return memo.parsed
  const parsed = parseMediaFence(raw, lang)
  parseMemo.set(fence, { raw, lang, parsed })
  return parsed
}

function isMediaFence(fence: Element): boolean {
  return readFence(fence) !== null
}

function hideFence(fence: Element): void {
  if (fence.hasAttribute('hidden')) return
  fence.setAttribute('hidden', '')
  fence.setAttribute('aria-hidden', 'true')
}

function revealFence(fence: Element): void {
  fence.removeAttribute('hidden')
  fence.removeAttribute('aria-hidden')
}

/** Keep a mount, but take it out of the document until an equivalent fence appears. */
function park(entry: MountedFence): void {
  if (entry.parkedAt !== null) return
  entry.parkedAt = Date.now()
  parked.add(entry)
  const list = parkedByKey.get(entry.itemsKey)
  if (list === undefined) parkedByKey.set(entry.itemsKey, [entry])
  else list.push(entry)
  entry.container.remove()
  if (parked.size > MAX_PARKED) {
    let oldest: MountedFence | undefined
    for (const other of parked) {
      if (other === entry) continue
      if (oldest === undefined || (other.parkedAt ?? 0) < (oldest.parkedAt ?? 0)) oldest = other
    }
    if (oldest !== undefined) destroy(oldest)
  }
  scheduleCleanup()
}

function unpark(entry: MountedFence): void {
  entry.parkedAt = null
  parked.delete(entry)
  const list = parkedByKey.get(entry.itemsKey)
  if (list !== undefined) {
    const index = list.indexOf(entry)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) parkedByKey.delete(entry.itemsKey)
  }
  entry.needsPlacement = true
}

/** Take the most recently parked mount rendering exactly these items, if any. */
function takeParked(key: string): MountedFence | undefined {
  const list = parkedByKey.get(key)
  const entry = list?.[list.length - 1]
  if (entry === undefined) return undefined
  unpark(entry)
  return entry
}

function destroy(entry: MountedFence): void {
  unpark(entry)
  entry.root.unmount()
  entry.container.remove()
  if (entry.fence.isConnected) revealFence(entry.fence)
  if (byFence.get(entry.fence) === entry) byFence.delete(entry.fence)
  if (byContainer.get(entry.container) === entry) byContainer.delete(entry.container)
  entries.delete(entry)
}

/** Arm the next teardown at the earliest parked deadline; later parks reschedule. */
function scheduleCleanup(): void {
  if (cleanupTimer !== null) return
  let deadline = Number.POSITIVE_INFINITY
  for (const entry of parked) {
    if (entry.parkedAt !== null) deadline = Math.min(deadline, entry.parkedAt + PARK_GRACE_MS)
  }
  if (!Number.isFinite(deadline)) return
  cleanupTimer = setTimeout(purgeParked, Math.max(0, deadline - Date.now()))
}

function purgeParked(): void {
  cleanupTimer = null
  const now = Date.now()
  for (const entry of [...parked]) {
    if (entry.parkedAt !== null && now - entry.parkedAt < PARK_GRACE_MS) continue
    destroy(entry)
  }
  if (parked.size > 0) scheduleCleanup()
}

/** True while the container sits in the fence's own parent, after the fence. */
function isPlaced(entry: MountedFence): boolean {
  const parent = entry.fence.parentElement
  if (parent === null) return true
  return entry.container.parentNode === parent
    && (entry.fence.compareDocumentPosition(entry.container) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/**
 * Put a mount back where its fence is, without ever re-rendering it: moving the
 * container keeps the React root — and therefore the <audio>/<video> element and
 * its playback state — alive.
 */
function place(entry: MountedFence): void {
  const fence = entry.fence
  const parent = fence.parentElement
  if (parent === null || !fence.isConnected) return
  if (!isPlaced(entry)) parent.insertBefore(entry.container, fence.nextSibling)
  hideFence(fence)
  entry.needsPlacement = false
}

function createMount(fence: Element, parsed: ParsedFence): void {
  const parent = fence.parentElement
  if (parent === null) return
  const container = document.createElement('span')
  container.className = MOUNT_CLASS
  parent.insertBefore(container, fence.nextSibling)
  hideFence(fence)
  const root = createRoot(container)
  const entry: MountedFence = {
    fence,
    container,
    root,
    itemsKey: parsed.key,
    parkedAt: null,
    needsPlacement: false,
  }
  byFence.set(fence, entry)
  byContainer.set(container, entry)
  entries.add(entry)
  root.render(createElement(InlineMedia, { items: parsed.items }))
}

/** Reconcile one fence that actually changed: mount, adopt, re-home, or update. */
function applyFence(fence: Element): void {
  if (!fence.isConnected) {
    const detached = byFence.get(fence)
    if (detached !== undefined) park(detached)
    return
  }

  const existing = byFence.get(fence)
  if (existing !== undefined) {
    // An edited block keeps its DOM node but can change language: hand the node
    // back instead of leaving a player over a hidden, unrelated block.
    const lang = getCodeBlockLang(fence)
    if (lang !== '' && lang !== FENCE_LANG) {
      destroy(existing)
      return
    }
    const parsed = readFence(fence)
    if (parsed === null) return
    // Re-render only when the items really changed; React then reuses the
    // player for an unchanged url (a new title moves no DOM node).
    if (parsed.key !== existing.itemsKey) {
      existing.itemsKey = parsed.key
      existing.root.render(createElement(InlineMedia, { items: parsed.items }))
    }
    if (existing.parkedAt !== null) unpark(existing)
    place(existing)
    return
  }

  const parsed = readFence(fence)
  if (parsed === null) return

  // The fence is a fresh element, but an identical one was just replaced:
  // re-home the live player onto it instead of rebuilding it.
  const adopted = takeParked(parsed.key)
  if (adopted !== undefined) {
    adopted.fence = fence
    byFence.set(fence, adopted)
    place(adopted)
    return
  }

  createMount(fence, parsed)
}

function flush(): void {
  flushQueued = false

  // 1. Keep every mount anchored to the document: park the ones whose fence is
  //    gone, revive the ones whose fence came back, and queue re-placement for
  //    containers that lost their slot.
  for (const entry of entries) {
    if (!entry.fence.isConnected) {
      park(entry)
      continue
    }
    if (entry.parkedAt !== null) unpark(entry)
    else if (!isPlaced(entry)) entry.needsPlacement = true
  }

  // 2. Mount, adopt, or update only the fences that changed.
  if (candidates.size > 0) {
    for (const fence of candidates) applyFence(fence)
    candidates.clear()
  }

  // 3. Re-insert the containers that lost their slot.
  for (const entry of entries) {
    if (entry.needsPlacement) place(entry)
  }
}

function queueFlush(): void {
  if (flushQueued) return
  flushQueued = true
  queueMicrotask(flush)
}

/** The nearest fence for a mutated node, ignoring churn inside our own players. */
function closestFence(node: Node): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  if (el === null || el.closest(MOUNT_SELECTOR) !== null) return null
  return el.closest(FENCE_SELECTOR)
}

function markSubtreeFences(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as Element
  // Our own container is inserted right next to a fence: never a candidate.
  if (el.classList.contains(MOUNT_CLASS)) return false
  if (el.matches(FENCE_SELECTOR)) {
    candidates.add(el)
    return true
  }
  if (el.firstElementChild === null) return false
  const found = el.querySelectorAll(FENCE_SELECTOR)
  if (found.length === 0) return false
  found.forEach((fence) => candidates.add(fence))
  return true
}

/** True when removing `node` may have detached a fence or one of our mounts. */
function holdsFence(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as Element
  if (byContainer.has(el)) return true
  if (el.matches(FENCE_SELECTOR)) return true
  return el.firstElementChild !== null && el.querySelector(FENCE_SELECTOR) !== null
}

function onMutations(records: MutationRecord[]): void {
  let touched = false
  for (const record of records) {
    const target = record.target
    // A player updates its own bar (seek/time/mute); that is not page churn.
    if (target.nodeType === Node.ELEMENT_NODE && (target as Element).closest(MOUNT_SELECTOR) !== null) continue

    for (const node of record.addedNodes) {
      if (markSubtreeFences(node)) touched = true
    }
    for (const node of record.removedNodes) {
      if (holdsFence(node)) touched = true
    }
    // Text inside a mounted fence changed (an updated reply body).
    const fence = closestFence(target)
    if (fence !== null) {
      candidates.add(fence)
      touched = true
    }
  }
  if (touched) queueFlush()
}

export function installFenceRenderer(): () => void {
  if (typeof document === 'undefined') return () => {}

  // One full scan at install time; every later pass is driven by the mutations
  // that actually touch a fence.
  document.body.querySelectorAll(FENCE_SELECTOR).forEach((fence) => {
    if (isMediaFence(fence)) candidates.add(fence)
  })
  flush()

  observer = new MutationObserver(onMutations)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    observer?.disconnect()
    observer = null
    candidates.clear()
    if (cleanupTimer !== null) {
      clearTimeout(cleanupTimer)
      cleanupTimer = null
    }
    for (const entry of [...entries]) destroy(entry)
  }
}
