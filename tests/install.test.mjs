/**
 * Offline checks for the vendored-ffmpeg installer.
 *
 * The zip reader is hand-written because Node ships no archive support, so it is tested
 * against archives built byte by byte here: stored and deflated entries, entries that
 * must be ignored, and hostile names that must be refused. A wrong central-directory
 * offset would otherwise only surface as a corrupt binary on a fresh machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { InstallError, extractBinaries, sha256Of, vendoredState } from '../src/core/install.mjs'

/**
 * Build a minimal but structurally valid zip archive.
 * @param {{name: string, data: Buffer, method: 0|8}[]} entries - the entries to store.
 * @returns {Buffer} the archive bytes.
 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const stored = entry.method === 8 ? deflateRawSync(entry.data) : entry.data
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBytes, stored)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + stored.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, eocd])
}

/** Standard CRC-32, needed because the reader trusts the field rather than recomputing. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Write an archive to a temp file and return its path. */
function scratchZip(entries) {
  const directory = mkdtempSync(join(tmpdir(), 'vf-zip-'))
  const path = join(directory, 'archive.zip')
  writeFileSync(path, buildZip(entries))
  return { directory, path }
}

test('extractBinaries pulls the wanted executables out of a stored archive', async () => {
  const payload = Buffer.from('MZ fake ffmpeg binary')
  const probePayload = Buffer.from('MZ fake ffprobe binary')
  const { directory, path } = scratchZip([
    { name: 'ffmpeg-n9.0/bin/ffmpeg.exe', data: payload, method: 0 },
    { name: 'ffmpeg-n9.0/bin/ffprobe.exe', data: probePayload, method: 0 },
    { name: 'ffmpeg-n9.0/LICENSE.txt', data: Buffer.from('GPL'), method: 0 },
    { name: 'ffmpeg-n9.0/README.md', data: Buffer.from('readme'), method: 0 },
  ])

  const target = join(directory, 'out')
  const files = await extractBinaries(path, target)
  assert.deepEqual(files.sort(), ['ffmpeg.exe', 'ffprobe.exe'], 'only the wanted binaries are extracted')
  assert.equal(readFileSync(join(target, 'ffmpeg.exe'), 'utf8'), 'MZ fake ffmpeg binary')
  assert.equal(readFileSync(join(target, 'ffprobe.exe'), 'utf8'), 'MZ fake ffprobe binary')
  assert.throws(() => readFileSync(join(target, 'LICENSE.txt')), 'unrelated files must not be written')
})

test('extractBinaries handles deflated entries, which is what release archives use', async () => {
  // Highly compressible payload, so a broken inflate is obvious.
  const payload = Buffer.from('MZ'.repeat(5000))
  const { directory, path } = scratchZip([{ name: 'bin/ffmpeg.exe', data: payload, method: 8 }])
  const target = join(directory, 'out')
  const files = await extractBinaries(path, target)
  assert.deepEqual(files, ['ffmpeg.exe'])
  assert.ok(readFileSync(join(target, 'ffmpeg.exe')).equals(payload), 'deflated content must round-trip')
})

test('extractBinaries refuses an archive with none of the wanted files', async () => {
  const { directory, path } = scratchZip([{ name: 'doc/notes.txt', data: Buffer.from('hi'), method: 0 }])
  await assert.rejects(
    () => extractBinaries(path, join(directory, 'out')),
    /没有 .*ffmpeg\.exe/,
    'a wrong build must be reported, not silently produce an empty bin directory',
  )
})

test('extractBinaries refuses a traversal name instead of normalizing it', async () => {
  const { directory, path } = scratchZip([{ name: '../../evil/ffmpeg.exe', data: Buffer.from('x'), method: 0 }])
  await assert.rejects(() => extractBinaries(path, join(directory, 'out')), InstallError)
})

test('extractBinaries rejects a file that is not a zip', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-notzip-'))
  const path = join(directory, 'archive.zip')
  writeFileSync(path, 'this is definitely not a zip archive')
  await assert.rejects(() => extractBinaries(path, join(directory, 'out')), /不是有效的 zip/)
})

test('sha256Of matches a known digest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-hash-'))
  const path = join(directory, 'payload.bin')
  writeFileSync(path, 'abc')
  // The canonical SHA-256 of "abc".
  assert.equal(await sha256Of(path), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('vendoredState describes the real vendored build without running it', (context) => {
  const state = vendoredState()
  if (!state.present) {
    // This plugin borrows ffmpeg instead of shipping one, so "not vendored here" is the normal
    // state rather than a failure; the borrowing itself is covered by tests/helpers.mjs, which
    // fails loudly if the suite cannot find an ffmpeg anywhere.
    context.skip(`本插件没有自带 ffmpeg（它借用同级 video-factory 的构建）：${state.directory}`)
    return
  }
  assert.ok(state.files.includes('ffmpeg.exe'))
  assert.ok(state.files.includes('ffprobe.exe'))
  assert.ok(state.sizeBytes > 50_000_000, 'the static build is large')
})
