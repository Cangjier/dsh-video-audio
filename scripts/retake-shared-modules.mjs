/**
 * Re-take the modules this repository shares with `video-factory`, with the module-header rename.
 *
 * These files were damaged by the same PowerShell re-encoding pass as the audio modules, but unlike
 * those, clean originals still exist in the sibling checkout — so they are copied rather than
 * frozen. The rename is applied here in Node, never through `Set-Content`.
 *
 *   node scripts/retake-shared-modules.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, '..', 'video-factory')

/** Shared modules whose clean original is still in the sibling checkout. */
const SHARED = [
  'src/core/probe.mjs',
  'src/core/install.mjs',
  'src/core/proxy.mjs',
  'src/core/audio-signal.mjs',
  'src/core/audio-measure.mjs',
  'src/core/ffmpeg.mjs',
]

for (const relative of SHARED) {
  const body = readFileSync(resolve(SOURCE, relative), 'utf8').replace(/^\uFEFF/, '')
  const renamed = body.replaceAll('@module video-factory/', '@module dsh-video-audio/')
  writeFileSync(resolve(ROOT, relative), renamed, 'utf8')
  console.log(`重新抄写：${relative}（${body.length} 字节，${body === renamed ? '无模块头改动' : '已改模块头'}）`)
}
