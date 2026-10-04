/**
 * The migration that produced this repository, kept as a script so it can be audited.
 *
 * Every module here either IS a file from `video-factory` or is a small, named edit of one.
 * Rather than retype them (and quietly drift), this script copies the originals and applies a
 * list of exact string replacements. A replacement whose pattern is missing **throws**: an
 * upstream file that changed shape must be looked at, not silently half-translated.
 *
 * Run from a checkout that sits next to `video-factory`:
 *
 *   node scripts/migrate-from-video-factory.mjs
 *
 * It writes into this repository and prints a report naming, per file, what was copied and what
 * was rewritten. It never writes to the source repository.
 *
 * This is a one-shot tool kept for provenance, not part of the build or the test suite.
 *
 * @module dsh-video-audio/scripts/migrate
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET_ROOT = resolve(HERE, '..')
const SOURCE_ROOT = resolve(TARGET_ROOT, '..', 'video-factory')

if (!existsSync(join(SOURCE_ROOT, 'src', 'core', 'audio-build.mjs'))) {
  throw new Error(`找不到源仓库：${SOURCE_ROOT}`)
}

/**
 * Copy one file, optionally applying exact string replacements.
 *
 * @param {object} spec - the migration step.
 * @param {string} spec.from - path relative to the source repository.
 * @param {string} spec.to - path relative to this repository; defaults to `from`.
 * @param {Array<[string, string]>} [spec.replace] - exact [search, replacement] pairs.
 * @param {boolean} [spec.transform] - set when the whole file body is supplied instead.
 * @returns {{to: string, kind: 'copied'|'edited'|'written', changes: string[]}} the report row.
 */
function migrate(spec) {
  const target = resolve(TARGET_ROOT, spec.to ?? spec.from)
  const changes = []
  let body

  if (typeof spec.body === 'string') {
    body = spec.body
    if (!body.endsWith('\n')) body += '\n'
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
    return { to: relative(TARGET_ROOT, target), kind: 'written', changes: ['整份重写'] }
  }

  const source = resolve(SOURCE_ROOT, spec.from)
  if (!existsSync(source)) throw new Error(`源文件不存在：${source}`)
  body = readFileSync(source, 'utf8')

  for (const [search, replacement] of spec.replace ?? []) {
    const hits = body.split(search).length - 1
    if (hits === 0) throw new Error(`${spec.from}：找不到要替换的片段：${JSON.stringify(search.slice(0, 80))}`)
    body = body.split(search).join(replacement)
    changes.push(`${hits}× ${JSON.stringify(search.slice(0, 60))}`)
  }

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body, 'utf8')
  return { to: relative(TARGET_ROOT, target), kind: changes.length === 0 ? 'copied' : 'edited', changes }
}

/** Files carried over unchanged: pure computation, or parsing, with nothing plugin-specific. */
const VERBATIM = [
  'src/core/probe.mjs',
  'src/core/install.mjs',
  'src/core/proxy.mjs',
  'src/core/audio-signal.mjs',
  'src/core/audio-build.mjs',
  'src/core/audio-record.mjs',
  'src/core/audio-restore.mjs',
  'src/core/audio-integrity.mjs',
  'tests/audio-signal.test.mjs',
  'tests/audio-build.test.mjs',
  'tests/audio-restore.test.mjs',
  'tests/audio-integrity.test.mjs',
  'tests/audio-actions.test.mjs',
  'tests/audio.test.mjs',
  'tests/install.test.mjs',
]

const report = []

for (const from of VERBATIM) {
  report.push(migrate({ from }))
}

// ---------------------------------------------------------------------------------------------
// The audio modules that must learn this plugin's own identity.
// ---------------------------------------------------------------------------------------------

// `video_setup {action:"install_audio"}` became `audio_setup {action:"install"}`; `video_analyze`
// became `audio_measure`. The ffmpeg discovery note names this plugin's own environment variable.
report.push(
  migrate({
    from: 'src/core/audio-events.mjs',
    replace: [
      [' * @module video-factory/core/audio-events', ' * @module dsh-video-audio/core/audio-events'],
      ['video_setup {action:"install_audio"}', 'audio_setup {action:"install"}'],
    ],
  }),
)

report.push(
  migrate({
    from: 'src/core/audio-install.mjs',
    replace: [
      [' * @module video-factory/core/audio-install', ' * @module dsh-video-audio/core/audio-install'],
    ],
  }),
)

report.push(
  migrate({
    from: 'src/core/audio-measure.mjs',
    replace: [
      [' * @module video-factory/core/audio-measure', ' * @module dsh-video-audio/core/audio-measure'],
      ["import { parseSilences } from './transcribe.mjs'", "import { parseSilences } from './audio-silence.mjs'"],
    ],
  }),
)

// `ffmpeg.mjs` is the same runner under a different environment-variable contract.
report.push(
  migrate({
    from: 'src/core/ffmpeg.mjs',
    replace: [
      [' * @module video-factory/core/ffmpeg', ' * @module dsh-video-audio/core/ffmpeg'],
      [
        '`找不到 ${stem}。请设置 ${stem === \'ffmpeg\' ? \'VIDEO_FACTORY_FFMPEG\' : \'VIDEO_FACTORY_FFPROBE\'}，`',
        '`找不到 ${stem}。请设置 ${stem === \'ffmpeg\' ? FFMPEG_ENV : FFPROBE_ENV}，`',
      ],
      ["import { resolveBinary } from './env.mjs'", "import { FFMPEG_ENV, FFPROBE_ENV, resolveBinary } from './env.mjs'"],
    ],
  }),
)

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const lines = ['# 迁移报告（migrate-from-video-factory.mjs 的输出）', '']
lines.push(`源：\`${SOURCE_ROOT}\``, '')
lines.push('| 目标文件 | 方式 | 改动 |', '| --- | --- | --- |')
for (const row of report) {
  lines.push(`| \`${row.to.replace(/\\/g, '/')}\` | ${row.kind} | ${row.changes.join('；') || '—'} |`)
}
lines.push('')
writeFileSync(join(TARGET_ROOT, 'docs', '迁移报告.md'), `${lines.join('\n')}\n`, 'utf8')
console.log(lines.join('\n'))
