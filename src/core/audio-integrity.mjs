/**
 * `audio-integrity` — NOT IMPLEMENTED. This module's content was destroyed.
 *
 * Read `docs/事故记录.md`. The original implementation was never committed and a PowerShell
 * re-encoding pass mangled it beyond recovery; no clean copy exists on this machine. The mangled
 * text is kept at `tmp/mangled/audio-integrity.mjs`.
 *
 * The behaviour is pinned by `tests/audio-integrity.test.mjs`, which builds the exact damage this
 * module was written for — 144-byte MPEG-2 Layer III frames with a CRLF inserted before every fifth
 * one — and checks the frame walk, the gap histogram, and that a repair gives back the original
 * bytes. Rebuild against those tests. `src/tools/registry.mjs` (`audio_measure.integrity`) has the
 * arguments and return fields, and `video-factory/docs/声音工具.md` explains why the audit reports
 * the bytes found in each gap rather than only its size.
 *
 * @module dsh-video-audio/core/audio-integrity
 */

/** Raised for an integrity request this module cannot carry out. */
export class AudioIntegrityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioIntegrityError'
  }
}

/**
 * Explain the one reason anything in this module fails today.
 * @param {string} what - the function that was called.
 * @returns {AudioIntegrityError} the error to throw.
 */
function destroyed(what) {
  return new AudioIntegrityError(
    `audio-integrity 尚未实现：${what} 的内容在 2026-10-04 的转码事故中被毁，且没有干净副本。` +
      '请按 docs/事故记录.md，以 tests/audio-integrity.test.mjs 为准绳重建这个模块。',
  )
}

/** Largest file the audit will read, in bytes. */
export const MAX_AUDIT_BYTES = 512 * 1024 * 1024

/** Largest leading run of stray bytes the repair will drop before refusing. */
export const MAX_LEADING_BYTES = 64

export function id3TagSize() {
  throw destroyed('id3TagSize')
}

export function findFirstFrame() {
  throw destroyed('findFirstFrame')
}

export function mpegFrameAt() {
  throw destroyed('mpegFrameAt')
}

export function walkMpegFrames() {
  throw destroyed('walkMpegFrames')
}

export function repairMpegFrames() {
  throw destroyed('repairMpegFrames')
}

export async function auditIntegrity() {
  throw destroyed('auditIntegrity')
}
