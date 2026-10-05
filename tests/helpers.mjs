/**
 * Test-harness setup: point the plugin at an ffmpeg that exists.
 *
 * The plugin borrows ffmpeg rather than vendoring its own copy — that is the whole point of the
 * discovery order — so a checkout that has never installed one still works, provided **the shared
 * plugin home** (`~/.dsh-plugins/ffmpeg/bin`), this plugin's own `vendor/ffmpeg/bin`, or a sibling
 * `video-factory` checkout beside it has a build. The resolver already reaches all three, but only
 * when the environment does not point somewhere wrong: a machine with an unrelated `ffmpeg.exe`
 * on PATH would otherwise resolve *that* one, and the numbers this suite asserts were measured
 * with the shared build.
 *
 * So this module finds the intended binary once, at import time, and pins it through the two
 * environment variables the plugin documents. It is imported for that side effect.
 *
 * Real ffmpeg is optional for most of the suite: the arithmetic tests never spawn it, and the
 * end-to-end ones skip with a reason instead of failing when nothing is found.
 *
 * @module dsh-video-audio/tests/helpers
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLUGIN_ROOT, FFMPEG_ENV, FFPROBE_ENV, findBinary, resetToolCache } from '../src/core/index.mjs'
import { SHARED_FFMPEG_BIN } from '../src/core/home.mjs'

const BINARY = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const PROBE = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

/** Every binary directory the plugin itself would search, nearest first. */
function binDirectories() {
  const roots = [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]
  return [
    SHARED_FFMPEG_BIN,
    join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin'),
    ...roots.map((root) => join(root, 'video-factory', 'vendor', 'ffmpeg', 'bin')),
  ]
}

/**
 * Find ffmpeg for the suite: the shared home, then this checkout's vendor, then a sibling's.
 *
 * @returns {{ffmpeg: string, ffprobe: string, from: string}|null} the pair, or null when neither
 *   binary can be found anywhere.
 */
function locate() {
  for (const directory of binDirectories()) {
    const ffmpeg = join(directory, BINARY)
    const ffprobe = join(directory, PROBE)
    if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe, from: directory }
  }
  return null
}

const found = locate()

/** Where the suite's ffmpeg came from, or null. Tests use it to explain a skip. */
export const FFMPEG_FROM = found?.from ?? null

/** The reason an ffmpeg-backed test is skipping, or null when it can run. */
export const FFMPEG_SKIP = found === null ? 'ffmpeg 未找到：共享目录 ~/.dsh-plugins/ffmpeg/bin、本机 vendor/ffmpeg 与同级 video-factory/vendor/ffmpeg 都没有。' : null

if (found !== null) {
  // Pinned through the documented environment variables rather than left to PATH, because the
  // assertions in this suite were measured against this build.
  process.env[FFMPEG_ENV] = found.ffmpeg
  process.env[FFPROBE_ENV] = found.ffprobe
  // Anything resolved before this ran would be cached and would win over the pin.
  resetToolCache()
  if (findBinary('ffmpeg', null)?.path !== found.ffmpeg) {
    throw new Error(`测试环境没能固定 ffmpeg：期望 ${found.ffmpeg}`)
  }
}

/**
 * Render a WAV with ffmpeg, or skip the caller when there is no ffmpeg.
 *
 * @param {object} context - the node:test context.
 * @returns {boolean} true when an ffmpeg-backed test may proceed.
 */
export function requireFfmpeg(context) {
  if (FFMPEG_SKIP === null) return true
  context.skip(FFMPEG_SKIP)
  return false
}
