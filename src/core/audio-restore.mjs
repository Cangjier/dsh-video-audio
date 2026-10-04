/**
 * `audio-restore` — NOT IMPLEMENTED. This module's content was destroyed.
 *
 * Read `docs/事故记录.md`. The original implementation was never committed and a PowerShell
 * re-encoding pass mangled it beyond recovery; no clean copy exists on this machine. The mangled
 * text is kept at `tmp/mangled/audio-restore.mjs`.
 *
 * Rebuild against `tests/audio-restore.test.mjs`, which pins every filter the chain can emit —
 * `afftdn` for denoise, one `bandreject` per dehum harmonic, `agate` with its dBFS-to-linear
 * threshold conversion, `highpass`/`lowpass` — and the conversions that are easy to get backwards.
 * `src/tools/registry.mjs` (`audio_build.restore`) lists the methods and their parameters, and
 * `video-factory/docs/声音工具.md` explains why there is no gain or loudness step here.
 *
 * @module dsh-video-audio/core/audio-restore
 */

/** Raised for a restoration request this module cannot carry out. */
export class AudioRestoreError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioRestoreError'
  }
}

/**
 * Explain the one reason anything in this module fails today.
 * @param {string} what - the function that was called.
 * @returns {AudioRestoreError} the error to throw.
 */
function destroyed(what) {
  return new AudioRestoreError(
    `audio-restore 尚未实现：${what} 的内容在 2026-10-04 的转码事故中被毁，且没有干净副本。` +
      '请按 docs/事故记录.md，以 tests/audio-restore.test.mjs 为准绳重建这个模块。',
  )
}

/** The mains frequencies the dehum step accepts. */
export const MAINS_FREQUENCIES = [50, 60]

/** The output codecs `restore` accepts. */
export const RESTORE_CODECS = ['pcm_s16le', 'pcm_f32le', 'aac']

/** Every restoration step this module can emit. */
export const RESTORE_METHODS = ['denoise', 'dehum', 'notch', 'gate', 'highpass', 'lowpass']

export function restoreStep() {
  throw destroyed('restoreStep')
}

export function restoreChain() {
  throw destroyed('restoreChain')
}

export async function restoreAudio() {
  throw destroyed('restoreAudio')
}
