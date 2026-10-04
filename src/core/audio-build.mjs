/**
 * `audio-build` — NOT IMPLEMENTED. This module's content was destroyed.
 *
 * Read `docs/事故记录.md` before touching this file. The original implementation was written but
 * never committed, and a PowerShell re-encoding pass mangled it beyond recovery. No clean copy
 * exists: not in either repository's git history, which never contained it, and not elsewhere on
 * this machine. The mangled text is kept at `tmp/mangled/audio-build.mjs` as the closest thing to
 * the original that survives.
 *
 * Nothing here is a partial implementation and nothing guesses. Every function throws, so a caller
 * that reaches one gets a sentence naming the cause instead of a silent wrong number.
 *
 * What survives is enough to rebuild it, and should be used in this order:
 *
 * 1. `tests/audio-build.test.mjs` — the arithmetic and the exact ffmpeg strings, written against
 *    the real implementation: `toneArguments` producing `aevalsrc=…`, `planPlacements` landing a
 *    clip at sample 240000 for five seconds, `assembleGraph` building the sample-exact chain, and
 *    `layoutOf` refusing a channel count it cannot lay out.
 * 2. `src/tools/registry.mjs`, entries `audio_build.tone` and `audio_build.assemble` — arguments,
 *    return fields, costs and pitfalls.
 * 3. `video-factory/docs/声音工具.md` — the design intent, the `adelay` mistake it avoids, and the
 *    measured behaviour of this ffmpeg build.
 *
 * @module dsh-video-audio/core/audio-build
 */

/** Raised for a build request this module cannot carry out. */
export class AudioBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioBuildError'
  }
}

/**
 * Explain the one reason anything in this module fails today.
 * @param {string} what - the function that was called.
 * @returns {AudioBuildError} the error to throw.
 */
function destroyed(what) {
  return new AudioBuildError(
    `audio-build 尚未实现：${what} 的内容在 2026-10-04 的转码事故中被毁，且没有干净副本。` +
      '请按 docs/事故记录.md，以 tests/audio-build.test.mjs 为准绳重建这个模块。',
  )
}

/** The signal kinds `tone` can generate. */
export const TONE_KINDS = ['sine', 'sweep', 'silence', 'white', 'pink', 'brown']

/** The overlap policies `assemble` accepts. */
export const OVERLAP_POLICIES = ['reject', 'sum']

/** The assembly methods `assemble` accepts. */
export const ASSEMBLE_METHODS = ['concat', 'mix']

/** Samples of slack allowed when verifying an assembled timeline. */
export const ASSEMBLE_SAMPLE_TOLERANCE = 0

/** The nominal level a generated tone uses when none is given, in dBFS. */
export const DEFAULT_TONE_LEVEL_DBFS = -3

/** The seed a generated noise signal uses when none is given. */
export const DEFAULT_NOISE_SEED = 1

export function amplitudeOfLevel() {
  throw destroyed('amplitudeOfLevel')
}

export function levelOfAmplitude() {
  throw destroyed('levelOfAmplitude')
}

export function toneArguments() {
  throw destroyed('toneArguments')
}

export function layoutOf() {
  throw destroyed('layoutOf')
}

export function planPlacements() {
  throw destroyed('planPlacements')
}

export function assembleGraph() {
  throw destroyed('assembleGraph')
}

export async function buildTone() {
  throw destroyed('buildTone')
}

export async function measureClips() {
  throw destroyed('measureClips')
}

export async function assembleAudio() {
  throw destroyed('assembleAudio')
}
