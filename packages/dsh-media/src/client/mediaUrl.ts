/**
 * Make a persisted media URL playable from the page that is rendering it.
 *
 * A `dsh-media` fence is stored text, so its URL was frozen when the host minted
 * it — including the origin it happened to be serving on. A later process may
 * listen on another port (or be reached as `localhost`/a LAN address), and then
 * the old absolute URL points at nothing: the player renders and never loads.
 * The `/media/<token>` route is served by the same webserver as this page, so a
 * loopback URL for that route is rewritten onto the current origin. Anything
 * else — a remote http(s) URL, a `blob:`/`data:` URL, a bad URL — is left alone.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

export function resolveMediaSrc(url: string): string {
  if (typeof location === 'undefined' || location.origin === 'null') return url
  let parsed: URL
  try {
    parsed = new URL(url, location.href)
  } catch {
    return url
  }
  if (!parsed.pathname.startsWith('/media/')) return url
  const sameServer = parsed.hostname === location.hostname || LOOPBACK_HOSTS.has(parsed.hostname)
  if (!sameServer) return url
  return `${location.origin}${parsed.pathname}${parsed.search}`
}
