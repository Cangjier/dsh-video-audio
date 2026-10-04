/**
 * Provisioning the external binaries the pipeline needs.
 *
 * ffmpeg is not a package this project can depend on, so it is fetched once into
 * `vendor/ffmpeg/bin` and pinned by checksum. The release branch is preferred over
 * master because a tagged GPL static build is what makes a render reproducible across
 * machines.
 *
 * The extractor is deliberately narrow: it writes only the entries whose names end in
 * `ffmpeg.exe`, `ffprobe.exe`, or `ffplay.exe`, and refuses absolute or parent-relative
 * paths, so a hostile archive cannot escape the vendor directory.
 *
 * @module dsh-video-audio/core/install
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './env.mjs'
import { connectThroughProxy, systemProxy } from './proxy.mjs'

// Re-exported because these were part of this module's surface before the proxy moved to
// `proxy.mjs` for the WebSocket transport to share.
export { connectThroughProxy, systemProxy }

/**
 * Perform an HTTPS GET, through the system proxy when there is one, following redirects.
 *
 * Node 24 ships no importable `undici` (`import('undici')` fails and `node:undici` is not a
 * builtin), so proxying has to be built from `node:http`, `node:https`, and `node:tls`. For a
 * proxy the flow is an HTTP CONNECT tunnel plus a TLS handshake inside it; see
 * {@link connectThroughProxy}.
 *
 * Redirects are followed here rather than left to the caller because model hosts redirect on
 * purpose: HuggingFace answers `/resolve/` with a 302/307 to a CDN, so a fetch that stops at the
 * first response would download a 250-byte "Temporary Redirect" page and hash it as the model.
 * `fetch` followed redirects implicitly, so dropping them was a silent regression until the
 * body length and hash gave it away.
 *
 * The returned shape matches `fetch` closely enough to be a drop-in for {@link download}.
 *
 * @param {string} url - the https URL.
 * @param {object} [options] - `{ timeoutMs, maxRedirects }`.
 * @returns {Promise<{ok: boolean, status: number, statusText: string, url: string, headers: {get(name: string): string|null}, body: AsyncIterable<Uint8Array>|null}>} the response.
 * @throws {Error} when the connection or the tunnel fails.
 */
export async function httpFetch(url, options = {}) {
  const maxRedirects = options.maxRedirects ?? 8
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchOnce(current, options)
    const location = response.headers.get('location')
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
    if (!isRedirect || location === null) return response
    // Drain the redirect body so the socket can be reused and nothing is left half-read.
    if (response.body !== null) for await (const _ of response.body) void _
    current = new URL(location, current).href
  }
  throw new Error(`重定向次数超过 ${maxRedirects} 次，已中止：${url}`)
}

/**
 * One request/response exchange, no redirect handling.
 *
 * @param {string} url - the https URL.
 * @param {object} [options] - `{ timeoutMs }`.
 * @returns {Promise<object>} the response.
 * @throws {Error} when the connection or the tunnel fails.
 */
async function fetchOnce(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const target = new URL(url)
  const proxy = systemProxy()

  const agent = proxy === null ? null : await connectThroughProxy(target, proxy, timeoutMs)
  return await new Promise((settle, fail) => {
    const request = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'user-agent': 'video-factory', accept: '*/*' },
        ...(agent === null ? {} : { createConnection: () => agent.socket }),
      },
      (response) => {
        settle({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          url,
          headers: {
            get: (name) => {
              const value = response.headers[String(name).toLowerCase()]
              return Array.isArray(value) ? value[0] : value ?? null
            },
          },
          body: (async function* iterate() {
            for await (const chunk of response) yield chunk
          })(),
        })
        // Release the tunnelled socket once the body is done, whatever the caller did with it.
        // A kept-alive socket would hold the event loop open, which shows up as a test process
        // or a CLI command that finishes its work and then simply never exits.
        response.once('end', () => agent?.close())
        response.once('close', () => agent?.close())
        response.once('error', () => agent?.close())
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`))
    })
    request.on('error', (error) => {
      agent?.close()
      fail(error)
    })
    request.end()
  })
}

/** Where the vendored build lives. */
export const VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'ffmpeg')

/** The binary directory the pipeline discovers. */
export const VENDOR_BIN_DIR = join(VENDOR_DIR, 'bin')

/** BtbN's Windows GPL static build release feed. */
export const DEFAULT_RELEASE_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download'

/** The release the project pins. A tagged build beats master for reproducibility. */
export const DEFAULT_RELEASE_TAG = 'latest'

/** Archive names to try, most specific first. */
export const ARCHIVE_CANDIDATES = [
  'ffmpeg-n9.0-latest-win64-gpl-9.0.zip',
  'ffmpeg-master-latest-win64-gpl.zip',
]

/** Only these executables are extracted from the archive. */
export const WANTED_BINARIES = ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe']

/** Raised when provisioning fails. */
export class InstallError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallError'
  }
}

/**
 * Download a URL to a file.
 *
 * @param {string} url - the source.
 * @param {string} target - the destination path.
 * @param {(received: number, total: number) => void} [onProgress] - progress callback.
 * @returns {Promise<{bytes: number, sha256: string}>} what was written.
 * @throws {InstallError} when the request fails.
 */
export async function download(url, target, onProgress) {
  const response = await httpFetch(url, { timeoutMs: 120_000 })
  if (!response.ok) throw new InstallError(`下载失败 ${response.status} ${response.statusText}：${url}`)
  if (response.body === null) throw new InstallError(`下载响应没有内容：${url}`)

  const total = Number(response.headers.get('content-length') ?? 0)
  mkdirSync(join(target, '..'), { recursive: true })

  const hash = createHash('sha256')
  const sink = createWriteStream(target)
  let bytes = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      bytes += chunk.byteLength
      hash.update(chunk)
      if (!sink.write(chunk)) await new Promise((resolve) => sink.once('drain', resolve))
      if (onProgress !== undefined) onProgress(bytes, total)
    }
  } finally {
    await new Promise((resolve) => sink.end(resolve))
  }
  if (bytes === 0) throw new InstallError(`下载得到空文件：${url}`)
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Compute the SHA-256 of an existing file.
 * @param {string} path - the file to hash.
 * @returns {Promise<string>} the lowercase hex digest.
 */
export async function sha256Of(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Locate the end-of-central-directory record in a zip file.
 *
 * Scanned from the end because the archive comment makes the offset variable. The
 * signature is PK\x05\x06.
 * @param {Buffer} buffer - the whole archive.
 * @returns {{centralOffset: number, centralSize: number, entryCount: number}|null} the record.
 */
function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue
    return {
      entryCount: buffer.readUInt16LE(offset + 10),
      centralSize: buffer.readUInt32LE(offset + 12),
      centralOffset: buffer.readUInt32LE(offset + 16),
    }
  }
  return null
}

/**
 * Extract the wanted executables from a zip archive into the vendor bin directory.
 *
 * Only stored and deflated entries are handled, which is what a release archive uses.
 * Names are validated before use so an archive cannot write outside the target.
 *
 * @param {string} archivePath - the downloaded zip.
 * @param {string} targetDir - the directory to write binaries into.
 * @param {(message: string) => void} [onProgress] - progress notes.
 * @returns {Promise<string[]>} the extracted file names.
 * @throws {InstallError} when the archive is unreadable or contains none of the wanted files.
 */
export async function extractBinaries(archivePath, targetDir, onProgress) {
  const buffer = await readFile(archivePath)
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd === null) throw new InstallError(`不是有效的 zip 文件：${archivePath}`)

  const { inflateRawSync } = await import('node:zlib')
  mkdirSync(targetDir, { recursive: true })

  const extracted = []
  let offset = eocd.centralOffset
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    const base = name.split('/').pop()
    if (!WANTED_BINARIES.includes(base)) continue
    // Reject anything that could escape the destination, even though only the base name
    // is used, so a malformed archive is refused rather than silently normalized.
    if (name.startsWith('/') || name.includes('..')) {
      throw new InstallError(`压缩包里的路径不可信：${name}`)
    }

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new InstallError(`压缩包结构损坏（本地头缺失）：${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let contents
    if (method === 0) contents = raw
    else if (method === 8) contents = inflateRawSync(raw)
    else throw new InstallError(`不支持的压缩方式 ${method}：${name}`)

    const destination = join(targetDir, base)
    await writeFile(destination, contents)
    extracted.push(base)
    if (onProgress !== undefined) onProgress(`解压 ${base}（${contents.length} 字节）`)
  }

  if (extracted.length === 0) {
    throw new InstallError(`压缩包里没有 ${WANTED_BINARIES.join(' / ')}；下载的可能是错误的构建。`)
  }
  return extracted
}

/**
 * Report what the vendored build currently looks like.
 * @returns {{present: boolean, directory: string, files: string[], sizeBytes: number}} the state.
 */
export function vendoredState() {
  if (!existsSync(VENDOR_BIN_DIR)) return { present: false, directory: VENDOR_BIN_DIR, files: [], sizeBytes: 0 }
  const files = readdirSync(VENDOR_BIN_DIR)
  let sizeBytes = 0
  for (const file of files) {
    try {
      sizeBytes += statSync(join(VENDOR_BIN_DIR, file)).size
    } catch {
      // A file that vanished mid-listing simply does not count.
    }
  }
  return { present: true, directory: VENDOR_BIN_DIR, files, sizeBytes }
}

/**
 * Remove the vendored build.
 * @returns {boolean} whether anything was removed.
 */
export function removeVendored() {
  if (!existsSync(VENDOR_DIR)) return false
  rmSync(VENDOR_DIR, { recursive: true, force: true })
  return true
}

/**
 * Download and install ffmpeg into the vendor directory.
 *
 * @param {object} [options] - install options.
 * @param {(message: string) => void} [options.onProgress] - progress notes.
 * @param {boolean} [options.force] - reinstall even when a build is present.
 * @returns {Promise<object>} what was installed.
 * @throws {InstallError} when no candidate archive can be fetched.
 */
export async function installFfmpeg(options = {}) {
  const state = vendoredState()
  if (state.present && !options.force) {
    return { installed: false, reason: 'already present', ...state }
  }

  const scratch = join(VENDOR_DIR, 'download.zip')
  const failures = []
  for (const archive of ARCHIVE_CANDIDATES) {
    const url = `${DEFAULT_RELEASE_BASE}/${DEFAULT_RELEASE_TAG}/download/${archive}`
    options.onProgress?.(`尝试下载 ${url}`)
    try {
      const { bytes, sha256 } = await download(url, scratch, (received, total) => {
        if (options.onProgress === undefined) return
        if (total > 0 && received % (8 * 1024 * 1024) < 64 * 1024) {
          options.onProgress(`已下载 ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`)
        }
      })
      options.onProgress?.(`下载完成 ${(bytes / 1024 / 1024).toFixed(1)} MB，sha256 ${sha256}`)
      const files = await extractBinaries(scratch, VENDOR_BIN_DIR, options.onProgress)
      writeFileSync(
        join(VENDOR_DIR, 'SOURCE.json'),
        `${JSON.stringify({ url, bytes, sha256, files, installedAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: 'utf8' },
      )
      rmSync(scratch, { force: true })
      return { installed: true, url, bytes, sha256, files }
    } catch (error) {
      failures.push(`${archive}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  rmSync(scratch, { force: true })
  throw new InstallError(
    `所有候选构建都安装失败：\n${failures.map((line) => `  - ${line}`).join('\n')}\n` +
      '可以手动下载 ffmpeg 静态构建，把 ffmpeg.exe / ffprobe.exe 放进 vendor/ffmpeg/bin/。',
  )
}
