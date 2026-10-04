/**
 * Running ffmpeg and ffprobe.
 *
 * Every media operation in the pipeline goes through this module, so argument
 * construction, binary discovery, and error reporting live in exactly one place.
 *
 * Two rules are non-negotiable and are enforced here rather than at each call site:
 *
 * 1. **Arguments are always an array.** Nothing is ever assembled into a shell
 *    string, so a Chinese filename or a space needs no escaping and cannot be
 *    mis-parsed.
 * 2. **`-nostdin` and `-y` are always both present.** With `-nostdin` alone, ffmpeg
 *    cannot answer its own overwrite prompt when the output exists, so it exits 1
 *    with nothing on stderr but an unremarkable `Duration:` line — a rerun failure
 *    that is very hard to read backwards.
 *
 * @module dsh-video-audio/core/ffmpeg
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveBinary } from './env.mjs'

/** Raised when no usable ffmpeg or ffprobe can be located. */
export class FFmpegNotFound extends Error {
  constructor(message) {
    super(message)
    this.name = 'FFmpegNotFound'
  }
}

/** Raised when ffmpeg or ffprobe exits non-zero. */
export class FFmpegError extends Error {
  /**
   * @param {string[]} args - the argument list that failed.
   * @param {number|null} returnCode - the process exit code, null when killed.
   * @param {string} stderr - captured standard error.
   * @param {string} [reason] - extra context, for example a timeout.
   */
  constructor(args, returnCode, stderr, reason) {
    const tail = String(stderr ?? '').trim().split('\n').slice(-25).join('\n')
    const safeArgs = args.map((argument) => (/[^\x20-\x7e]/.test(argument) ? JSON.stringify(argument) : argument))
    super(
      `${reason === undefined ? `ffmpeg exited with ${returnCode}` : reason}\n` +
        `command: ffmpeg ${safeArgs.join(' ')}\n` +
        `stderr (tail):\n${tail}`,
    )
    this.name = 'FFmpegError'
    this.args = [...args]
    this.returnCode = returnCode
    this.stderr = String(stderr ?? '')
  }
}

/** Cache of resolved binaries, so discovery runs once per process. */
const resolved = new Map()

/**
 * Resolve an ffmpeg-family binary, honouring the configured paths.
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {object} [config] - normalized plugin config, supplying explicit paths.
 * @returns {string} the absolute binary path.
 * @throws {FFmpegNotFound} when no candidate exists.
 */
export function resolveTool(stem, config = {}) {
  const configured = stem === 'ffmpeg' ? config.ffmpegPath : config.ffprobePath
  const key = `${stem}:${configured ?? ''}`
  if (resolved.has(key)) return resolved.get(key)

  const found = resolveBinary(stem, configured ?? null)
  if (found === null) {
    throw new FFmpegNotFound(
      `找不到 ${stem}。请设置 ${stem === 'ffmpeg' ? 'VIDEO_FACTORY_FFMPEG' : 'VIDEO_FACTORY_FFPROBE'}，` +
        `或把它放到 vendor/ffmpeg/bin/，或让它出现在 PATH 里。` +
        `（ffmpeg 与 ffprobe 必须成对可用：装配阶段依赖 ffprobe 检查流信息。）`,
    )
  }
  resolved.set(key, found)
  return found
}

/** Forget cached binary paths. Only useful in tests. */
export function resetToolCache() {
  resolved.clear()
}

/**
 * Run one ffmpeg-family process with an argument array.
 *
 * @param {object} options - the invocation.
 * @param {'ffmpeg'|'ffprobe'} options.tool - which binary to run.
 * @param {string[]} options.args - arguments, in order.
 * @param {string} [options.cwd] - working directory; filter graphs may reference
 *   files by relative path, so this matters.
 * @param {number} [options.timeoutMs] - kill after this long. Defaults to 30 minutes.
 * @param {object} [options.config] - normalized plugin config for binary resolution.
 * @param {(chunk: string) => void} [options.onStderr] - progress callback, called per line.
 * @param {'utf8'|'buffer'} [options.stdoutEncoding] - how to collect standard output.
 *   Use `buffer` when the output is raw media bytes, such as the `rawvideo` grayscale
 *   proxy the frame sampler decodes: string concatenation would coerce every byte above
 *   0x7f through a utf8 decode and destroy the data.
 * @param {number} [options.maxStdoutBytes] - stop the process once this much standard
 *   output has been collected. Only meaningful with `stdoutEncoding: 'buffer'`, and the
 *   guard that keeps an unbounded stream from exhausting memory.
 * @returns {Promise<{code: number, stderr: string, stdout: string|Buffer}>} the outcome;
 *   `stdout` is a Buffer exactly when `stdoutEncoding` is `buffer`.
 * @throws {FFmpegNotFound} when the binary is missing.
 * @throws {FFmpegError} when the process fails, is killed, or times out.
 */
export function run(options) {
  const { tool = 'ffmpeg', args, cwd, config = {}, onStderr } = options
  const stdoutEncoding = options.stdoutEncoding ?? 'utf8'
  const wantBuffer = stdoutEncoding === 'buffer'
  const maxStdoutBytes = options.maxStdoutBytes ?? Number.POSITIVE_INFINITY
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  const binary = resolveTool(tool, config)

  // `-nostdin` and `-y` are ffmpeg flags. ffprobe rejects `-y` outright ("Option not
  // found") and does not prompt, so the two tools get different prefixes rather than
  // one shared one.
  const argv =
    tool === 'ffmpeg'
      ? ['-hide_banner', '-nostdin', '-y', ...args]
      : ['-hide_banner', ...args]

  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    /** @type {Buffer[]} */
    const stdoutChunks = []
    let stdoutBytes = 0
    let settled = false
    let timedOut = false
    let overflowed = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
    }

    if (wantBuffer) {
      child.stdout.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stdoutBytes += buffer.length
        if (stdoutBytes > maxStdoutBytes) {
          overflowed = true
          child.kill('SIGKILL')
          return
        }
        stdoutChunks.push(buffer)
      })
    } else {
      child.stdout.setEncoding(stdoutEncoding)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
    }

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (onStderr !== undefined) {
        for (const line of String(chunk).split('\n')) {
          if (line.trim() !== '') onStderr(line)
        }
      }
      // Keep memory bounded on a long render: only the tail is ever reported.
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000)
    })

    child.on('error', (error) => {
      finish(new FFmpegError(args, null, stderr, `无法启动 ${tool}：${error.message}`))
    })

    child.on('close', (code) => {
      if (timedOut) {
        finish(new FFmpegError(args, code, stderr, `${tool} 超过 ${Math.round(timeoutMs / 1000)} 秒被终止`))
        return
      }
      if (overflowed) {
        finish(
          new FFmpegError(
            args,
            code,
            stderr,
            `${tool} 的标准输出超过 ${maxStdoutBytes} 字节上限，已终止（防止无界流耗尽内存）`,
          ),
        )
        return
      }
      if (code !== 0) {
        finish(new FFmpegError(args, code, stderr))
        return
      }
      finish()
      resolve({ code, stderr, stdout: wantBuffer ? Buffer.concat(stdoutChunks, stdoutBytes) : stdout })
    })
  })
}

/**
 * Run ffprobe with a JSON output request and parse the result.
 * @param {string[]} args - ffprobe arguments, before the output flags.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} the parsed JSON document.
 * @throws {FFmpegError} when ffprobe fails or emits unparseable output.
 */
export async function runProbe(args, config = {}) {
  const result = await run({ tool: 'ffprobe', args, config, timeoutMs: 60_000 })
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new FFmpegError(args, 0, result.stderr, `ffprobe 输出不是合法 JSON：${error.message}`)
  }
}

/**
 * Check that both binaries exist and report their versions.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{ffmpeg: string, ffprobe: string, versions: {ffmpeg: string|null, ffprobe: string|null}}>}
 * @throws {FFmpegNotFound} when either binary is missing.
 */
export async function probeBinaries(config = {}) {
  const ffmpeg = resolveTool('ffmpeg', config)
  const ffprobe = resolveTool('ffprobe', config)
  const versions = { ffmpeg: null, ffprobe: null }
  for (const [stem, binary] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
    try {
      const result = await run({ tool: stem, args: ['-version'], config, timeoutMs: 15_000 })
      versions[stem] = result.stdout.split('\n')[0]?.trim() ?? null
    } catch {
      versions[stem] = null
    }
  }
  return { ffmpeg, ffprobe, versions }
}

/** Whether a path looks like a file this pipeline can feed to ffmpeg. */
export function fileExists(path) {
  return existsSync(path)
}
