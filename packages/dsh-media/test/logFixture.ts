import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/**
 * Builders for session-log fixtures.
 *
 * A real session log is JSONL appended in zstd frames — one frame per flush, so a
 * long session is thousands of frames in one file. Every argument after the header
 * is written as its own frame: decompressing such a file as a single stream
 * returns only the first frame, which is exactly the trap the reader avoids.
 */
export function writeSessionLog(file: string, cwd: string, ...frames: unknown[][]): string {
  const header = JSON.stringify({ type: 'session', version: 0, id: 'session-x', cwd })
  const chunks = [zstdCompressSync(Buffer.from(`${header}\n`))]
  for (const frame of frames) {
    chunks.push(zstdCompressSync(Buffer.from(`${frame.map((event) => JSON.stringify(event)).join('\n')}\n`)))
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.concat(chunks))
  return file
}

/** `$ROOT/sessions/<workspace>/session-<id>/session.jsonl.zstd`, as DSH lays it out. */
export function sessionLogPath(sessionsRoot: string, workspace: string, sessionId: string): string {
  return join(sessionsRoot, workspace, `session-${sessionId}`, 'session.jsonl.zstd')
}

export function mediaCall(callId: string, items: { kind?: string; url: string }[]): unknown {
  return {
    type: 'tool/call',
    seq: 1,
    data: {
      turn: 1,
      step: 1,
      callId,
      name: 'media_render',
      arguments: JSON.stringify({ items: items.map((item) => ({ kind: item.kind ?? 'audio', ...item })) }),
    },
  }
}

export function mediaResult(callId: string, urls: string[], options: { meta?: boolean } = {}): unknown {
  const message = {
    role: 'user',
    source: { kind: 'tool', callId },
    content: [
      {
        type: 'tool-result',
        toolCallId: callId,
        isError: false,
        content: [{ type: 'text', text: ['Media rendered.', ...urls.map((url, i) => `- audio: ${url} (clip-${i}.mp3)`)].join('\n') }],
      },
    ],
  }
  const data = {
    turn: 1,
    step: 1,
    message,
    ...(options.meta === false ? {} : { meta: { dshMedia: urls.map((url) => ({ kind: 'audio', url })) } }),
  }
  return { type: 'tool/result', seq: 2, data }
}
