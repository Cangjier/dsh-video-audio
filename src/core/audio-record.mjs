/**
 * `audio-record` — NOT IMPLEMENTED. This module's content was destroyed.
 *
 * Read `docs/事故记录.md`. The original implementation was never committed and a PowerShell
 * re-encoding pass mangled it beyond recovery; no clean copy exists on this machine. The mangled
 * text is kept at `tmp/mangled/audio-record.mjs`.
 *
 * Rebuild against `tests/audio-restore.test.mjs`, which pins `parseDeviceList` and
 * `recordArguments` against real `dshow` enumeration output, and `tests/audio-actions.test.mjs`,
 * which checks that a device name that does not exist fails with an actionable message rather than
 * hanging. `src/tools/registry.mjs` (`audio_build.record`, `audio_measure.devices`) has the
 * arguments, the real-time cost and the deadline behaviour.
 *
 * @module dsh-video-audio/core/audio-record
 */

/** Raised for a capture request this module cannot carry out. */
export class AudioRecordError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioRecordError'
  }
}

/**
 * Explain the one reason anything in this module fails today.
 * @param {string} what - the function that was called.
 * @returns {AudioRecordError} the error to throw.
 */
function destroyed(what) {
  return new AudioRecordError(
    `audio-record 尚未实现：${what} 的内容在 2026-10-04 的转码事故中被毁，且没有干净副本。` +
      '请按 docs/事故记录.md，以 tests/audio-restore.test.mjs 与 tests/audio-actions.test.mjs 为准绳重建这个模块。',
  )
}

/** Seconds added to a recording's requested length before the process is killed. */
export const RECORD_DEADLINE_SLACK_SECONDS = 20

/** Defaults for a capture: 48 kHz, mono, 64 MB DirectShow buffer. */
export const RECORD_DEFAULTS = { sampleRate: 48_000, channels: 1, rtBufferMb: 64 }

export function parseDeviceList() {
  throw destroyed('parseDeviceList')
}

export function recordArguments() {
  throw destroyed('recordArguments')
}

export async function listCaptureDevices() {
  throw destroyed('listCaptureDevices')
}

export async function recordAudio() {
  throw destroyed('recordAudio')
}
