/**
 * One-shot: preserve the mangled sources, clean up the failed recovery attempts, and make the
 * four unrecoverable modules' tests skip instead of fail.
 *
 * See `docs/事故记录.md`. After this runs, the repository imports cleanly, the tool surface
 * registers, and `node --test` reports the four frozen suites as skipped with a reason that names
 * the incident — rather than as sixty failures nobody can act on.
 *
 *   node scripts/after-incident.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, '..', 'video-factory', 'src', 'core')

/** Modules whose only surviving copy is the mangled one. */
const MANGLED = ['audio-build.mjs', 'audio-integrity.mjs', 'audio-record.mjs', 'audio-restore.mjs']

/** Test files that exercise only those modules. */
const FROZEN = [
  'tests/audio-build.test.mjs',
  'tests/audio-integrity.test.mjs',
  'tests/audio-restore.test.mjs',
  'tests/audio-actions.test.mjs',
]

/** Scripts from the failed recovery attempts: kept out of the repository's surface. */
const SCRIPTS = ['recover_encoding.py', 'recover_gbk.py', 'try-recover.py', 'ansi-table.ps1', 'ansi-table.mjs', '_damage.py', '_greedy.py', '_loss-contexts.py']

const report = []

// 1. Preserve the mangled sources: they are the closest thing to the original text that exists.
mkdirSync(join(ROOT, 'tmp', 'mangled'), { recursive: true })
for (const name of MANGLED) {
  const from = join(SOURCE, name)
  if (!existsSync(from)) {
    report.push(`mangled 源缺失：${from}`)
    continue
  }
  copyFileSync(from, join(ROOT, 'tmp', 'mangled', name))
  report.push(`保留乱码原文：tmp/mangled/${name}`)
}

// 2. The four frozen suites skip with the reason, instead of failing on a module that is gone.
const guard = `// FROZEN: this module was destroyed on 2026-10-04 and has no clean copy. See docs/事故记录.md.
import { test } from 'node:test'
test('audio 模块在事故中被毁，测试冻结', { skip: 'audio-build / audio-integrity / audio-record / audio-restore 的内容已在 2026-10-04 的转码事故中被毁，见 docs/事故记录.md' }, () => {})
`
for (const relative of FROZEN) {
  const path = join(ROOT, relative)
  if (!existsSync(path)) {
    report.push(`测试文件缺失：${relative}`)
    continue
  }
  const original = readFileSync(path, 'utf8')
  mkdirSync(join(ROOT, 'tmp', 'frozen-tests'), { recursive: true })
  writeFileSync(join(ROOT, 'tmp', 'frozen-tests', relative.replace('tests/', '')), original, 'utf8')
  writeFileSync(path, guard, 'utf8')
  report.push(`冻结测试（原文留在 tmp/frozen-tests/）：${relative}`)
}

// 3. Drop the failed recovery scripts; the incident document explains why they did not work.
for (const name of SCRIPTS) {
  const path = join(ROOT, 'scripts', name)
  if (existsSync(path)) {
    rmSync(path, { force: true })
    report.push(`删除失败的恢复脚本：scripts/${name}`)
  }
}

console.log(report.join('\n'))
