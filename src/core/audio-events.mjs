/**
 * Audio event detection: what a video *sounds* like, not what it says.
 *
 * Transcription answers "which words were spoken". It cannot tell background music from a
 * dog bark from silence, which is exactly what decides whether a cut lands on the beat. This
 * module classifies the soundtrack into AudioSet's 521 acoustic classes using YAMNet.
 *
 * **Why WASM and not the native binding.** `onnxruntime-node` unpacks to 245.7 MB because it
 * carries binaries for three platforms and two architectures; the WASM build needs 13.1 MB
 * and no platform-specific file at all. Measured on this machine the two agree to six decimal
 * places on the same window (0.977061 vs 0.977062), so the cheaper one wins.
 *
 * **Why the runtime is vendored rather than a package dependency.** This plugin is a plain
 * ESM module with no dependency edge, which is what lets a profile install it with no build
 * step. The runtime is fetched once into `vendor/audio/runtime/` by `install_audio`, pinned
 * by SHA-256, exactly like ffmpeg and the OCR engine.
 *
 * @module dsh-video-audio/core/audio-events
 */
import { existsSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_ROOT, resolveAudioDir } from './env.mjs'
import { resolveTool } from './ffmpeg.mjs'

/** Error type for an audio-analysis request this plugin refuses or cannot carry out. */
export class AudioEventError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioEventError'
  }
}

/**
 * Where the shared runtime and model live when nothing has been resolved yet.
 *
 * This is the install target — `audio_setup {action:"install"}` always writes here — and the
 * last resort for reading. Use {@link audioPaths} for anything that reads.
 */
export const AUDIO_VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'audio')

/** The manifest recording provenance and hashes. */
export const AUDIO_MANIFEST = join(AUDIO_VENDOR_DIR, 'SOURCE.json')

/** The ONNX model. */
export const YAMNET_MODEL = join(AUDIO_VENDOR_DIR, 'yamnet', 'yamnet.onnx')

/** The 521-class AudioSet label table. */
export const YAMNET_CLASS_MAP = join(AUDIO_VENDOR_DIR, 'yamnet', 'yamnet_class_map.csv')

/** Scratch directory for decoded WAV. */
export const AUDIO_TMP_DIR = join(PLUGIN_ROOT, 'tmp', 'audio')

/** The WASM entry point inside the vendored runtime. */
export const ORT_WASM_ENTRY = join(
  AUDIO_VENDOR_DIR,
  'runtime',
  'node_modules',
  'onnxruntime-web',
  'dist',
  'ort.wasm.mjs',
)

/** The WASM binary the entry point loads. */
export const ORT_WASM_BINARY = join(
  AUDIO_VENDOR_DIR,
  'runtime',
  'node_modules',
  'onnxruntime-web',
  'dist',
  'ort-wasm-simd-threaded.wasm',
)

/**
 * Resolve the four files detection needs, wherever they actually are.
 *
 * The search prefers this plugin's own `vendor/audio` and then a sibling `video-factory`
 * checkout, because the muxing plugin held this runtime before it moved here and a machine that
 * installed it then must not be asked to download 28 MB again. Nothing is written to a sibling.
 *
 * @returns {{dir: string, source: string, manifest: string, model: string, classMap: string, ortEntry: string, ortBinary: string}} the resolved paths.
 */
export function audioPaths() {
  const { dir, source } = resolveAudioDir()
  return {
    dir,
    source,
    manifest: join(dir, 'SOURCE.json'),
    model: join(dir, 'yamnet', 'yamnet.onnx'),
    classMap: join(dir, 'yamnet', 'yamnet_class_map.csv'),
    ortEntry: join(dir, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.mjs'),
    ortBinary: join(dir, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'),
  }
}

/**
 * YAMNet's fixed geometry, from the model card.
 *
 * The window is 0.96 s and the hop is half of it, so consecutive segments overlap. Feeding
 * the graph more than one window at once also works — it returns one score row per window —
 * but one window per call keeps memory flat and the timing per segment attributable.
 */
export const YAMNET_SAMPLE_RATE = 16_000
export const YAMNET_WINDOW = 15_360
export const YAMNET_HOP = 7_680

/** Segments quieter than this RMS are not classified: silence should not win a label. */
export const DEFAULT_SILENCE_RMS = 0.002

/** Scores below this never become an event. */
export const DEFAULT_MIN_SCORE = 0.1

/** How many labels to keep per segment. */
export const DEFAULT_TOP_K = 3

/** Hard ceiling on decoded audio, in seconds, so a bad request cannot exhaust memory. */
export const MAX_AUDIO_SECONDS = 7_200

/** Cached inference session: loading the runtime costs ~300 ms and is worth doing once. */
let sessionPromise = null
let classMapCache = null

/**
 * Read the vendored model's provenance manifest.
 * @returns {object|null} the manifest, or null when the model is not installed.
 */
export function readAudioManifest() {
  const resolved = audioPaths()
  // A sibling's manifest is read too: it is provenance for the very files being used, and
  // silently reporting "no manifest" while loading a sibling's model would be a lie of omission.
  for (const path of [resolved.manifest, AUDIO_MANIFEST]) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      /* a truncated manifest is not worth failing a measurement over */
    }
  }
  return null
}

/**
 * Report whether audio event detection can run, without running it.
 *
 * Deliberately reads the disk rather than the manifest: a manifest claims what was installed,
 * the files prove what is there.
 *
 * @returns {{available: boolean, kind: string|null, missing: string[], model: object|null, runtime: object|null, classes: number|null, vendorDir: string, reason: string|null}} the state.
 */
export function audioEventState() {
  const resolved = audioPaths()
  const required = {
    model: resolved.model,
    classMap: resolved.classMap,
    runtimeEntry: resolved.ortEntry,
    runtimeBinary: resolved.ortBinary,
  }
  const missing = Object.entries(required)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name)

  const manifest = readAudioManifest()
  let classes = null
  if (missing.length === 0) {
    try {
      classes = readClassMap(resolved.classMap).length
    } catch {
      classes = null
    }
  }

  return {
    available: missing.length === 0 && classes === 521,
    kind: missing.length === 0 ? 'yamnet' : null,
    missing,
    classes,
    model: manifest?.model ?? null,
    runtime: manifest?.runtime ?? null,
    vendorDir: resolved.dir,
    vendorSource: resolved.source,
    reason:
      missing.length === 0
        ? null
        : `音频事件检测尚未安装（缺少 ${missing.join(', ')}）。运行 audio_setup {action:"install"} 安装。`,
  }
}

/**
 * Parse the AudioSet class table.
 *
 * The CSV's first line is a header, so **class N is data row N, which is `lines[N + 1]`**.
 * Getting this wrong shifts every label by one and still looks plausible.
 *
 * @param {string} path - the CSV.
 * @returns {string[]} 521 display names, indexed by class id.
 * @throws {AudioEventError} when the table is missing or the wrong size.
 */
export function readClassMap(path) {
  if (!existsSync(path)) throw new AudioEventError(`缺少类别表：${path}`)
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
  const header = lines[0]?.toLowerCase() ?? ''
  if (!header.startsWith('index,')) {
    throw new AudioEventError(`类别表格式不符合预期（首行应为 index,mid,display_name）：${path}`)
  }
  const names = lines.slice(1).map((line) => {
    const cells = line.split(',')
    const display = cells.slice(2).join(',')
    return display.replace(/^"|"$/g, '').trim()
  })
  if (names.length !== 521) {
    throw new AudioEventError(`类别表应有 521 类，实得 ${names.length}：${path}`)
  }
  return names
}

/**
 * Extract a mono 16 kHz 16-bit PCM WAV for analysis.
 *
 * The whole file is decoded rather than streamed because YAMNet windows overlap and the
 * per-window scores are grouped per timestamp afterwards; a streaming decoder would make the
 * overlap bookkeeping harder to audit for no measurable gain at these durations.
 *
 * @param {string} source - the video or audio file.
 * @param {object} options - `{ config, start, duration, outPath, timeoutMs }`.
 * @returns {Promise<string>} the WAV path.
 * @throws {AudioEventError} when the file has no audio track or ffmpeg fails.
 */
export async function extractAudio(source, options = {}) {
  mkdirSync(AUDIO_TMP_DIR, { recursive: true })
  const outPath = options.outPath ?? join(AUDIO_TMP_DIR, `audio-${Date.now()}.wav`)
  const binary = resolveTool('ffmpeg', options.config ?? {})

  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error']
  if (Number.isFinite(options.start) && options.start > 0) args.push('-ss', String(options.start))
  args.push('-i', resolve(source))
  if (Number.isFinite(options.duration) && options.duration > 0) args.push('-t', String(options.duration))
  args.push('-vn', '-map', 'a:0?', '-ac', '1', '-ar', String(YAMNET_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', outPath)

  const outcome = await new Promise((settle) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => settle({ code: null, stderr: error.message }))
    child.on('close', (code) => settle({ code, stderr }))
  })

  if (outcome.code !== 0) {
    // "no audio track" and "ffmpeg broke" are different problems and need different fixes, so
    // they are separated here rather than collapsed into one message. A source with no audio
    // stream makes ffmpeg fail with "Output file does not contain any stream" and leave either
    // no file or a bare 44-byte header behind.
    const empty = !existsSync(outPath) || statSync(outPath).size <= 44
    if (empty) {
      throw new AudioEventError(
        `提取不到音频：这条素材可能没有音轨（${source}）。\n` +
          '视频没有声音时无法做音频事件检测——转录同样不可用。',
      )
    }
    throw new AudioEventError(
      `提取音轨失败（${source}）：ffmpeg 退出 ${outcome.code}\n${String(outcome.stderr).trim().split('\n').slice(-10).join('\n')}`,
    )
  }
  if (!existsSync(outPath) || statSync(outPath).size <= 44) {
    throw new AudioEventError(`提取不到音频样本，这条素材可能没有音轨：${source}`)
  }
  return outPath
}

/**
 * Parse a 16-bit mono PCM WAV into normalised samples.
 *
 * Only the subset ffmpeg is asked to produce is accepted; anything else is refused rather
 * than coerced, because a silent mis-parse would surface as confident nonsense labels.
 *
 * @param {string|Buffer} input - the file path or the bytes.
 * @returns {{samples: Float32Array, sampleRate: number, durationSec: number}} the samples.
 * @throws {AudioEventError} when the data is not 16-bit mono PCM.
 */
export function decodeWav(input) {
  const buffer = Buffer.isBuffer(input) ? input : readFileSync(input)
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioEventError('不是合法的 RIFF/WAVE 数据')
  }

  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length))
    }
    offset = body + size + (size % 2)
  }

  if (format === null || data === null) throw new AudioEventError('WAV 缺少 fmt 或 data 块')
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16 || format.channels !== 1) {
    throw new AudioEventError(
      `只接受 16 位单声道 PCM，实得 ${JSON.stringify(format)}；请让 ffmpeg 输出 -ac 1 -c:a pcm_s16le`,
    )
  }

  const samples = new Float32Array(Math.floor(data.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32_768
  return { samples, sampleRate: format.sampleRate, durationSec: samples.length / format.sampleRate }
}

/**
 * Root-mean-square level of a slice, used to tell silence from content.
 * @param {Float32Array} samples - the signal.
 * @param {number} [start] - first index.
 * @param {number} [length] - how many samples.
 * @returns {number} the RMS, 0 for an empty slice.
 */
export function rms(samples, start = 0, length = samples.length - start) {
  if (length <= 0) return 0
  let total = 0
  for (let i = start; i < start + length; i += 1) total += samples[i] * samples[i]
  return Math.sqrt(total / length)
}

/**
 * Cut a signal into YAMNet's overlapping windows.
 * @param {Float32Array} samples - the signal.
 * @param {number} sampleRate - its rate; must be 16 kHz.
 * @param {{window?: number, hop?: number, maxWindows?: number}} [options] - geometry overrides.
 * @returns {Array<{at: number, samples: Float32Array, rms: number}>} the windows.
 * @throws {AudioEventError} when the rate is wrong.
 */
export function windowsOf(samples, sampleRate, options = {}) {
  if (sampleRate !== YAMNET_SAMPLE_RATE) {
    throw new AudioEventError(`YAMNet 需要 ${YAMNET_SAMPLE_RATE} Hz，实得 ${sampleRate} Hz`)
  }
  const window = options.window ?? YAMNET_WINDOW
  const hop = options.hop ?? YAMNET_HOP
  const maxWindows = options.maxWindows ?? Number.POSITIVE_INFINITY
  const windows = []
  for (let start = 0; start + window <= samples.length; start += hop) {
    if (windows.length >= maxWindows) break
    windows.push({
      at: Number((start / sampleRate).toFixed(3)),
      samples: samples.subarray(start, start + window),
      rms: rms(samples, start, window),
    })
  }
  return windows
}

/**
 * Reduce a score matrix to the labels worth reporting for one segment.
 *
 * The graph returns one row per window; rows are averaged, which is what the model's own
 * documentation does and what makes a multi-window feed behave like a single verdict.
 *
 * @param {Float32Array|number[]} data - the flattened score matrix.
 * @param {number[]} dims - its shape, `[rows, classes]`.
 * @param {string[]} classNames - the label table.
 * @param {object} [options] - `{ topK, minScore }`.
 * @returns {{labels: Array<{label: string, score: number, index: number}>, peak: {label: string, score: number}|null}} the verdict.
 */
export function topLabels(data, dims, classNames, options = {}) {
  const topK = options.topK ?? DEFAULT_TOP_K
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  const width = dims[dims.length - 1]
  const rows = Math.max(1, Math.floor(data.length / width))

  const averaged = new Float64Array(width)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < width; column += 1) averaged[column] += data[row * width + column]
  }
  for (let column = 0; column < width; column += 1) averaged[column] /= rows

  const ranked = Array.from(averaged)
    .map((score, index) => ({ label: classNames[index] ?? `#${index}`, score, index }))
    .sort((a, b) => b.score - a.score)

  const peak = ranked[0] === undefined ? null : { label: ranked[0].label, score: ranked[0].score }
  return {
    labels: ranked.slice(0, topK).filter((entry) => entry.score >= minScore),
    peak,
  }
}

/**
 * Load (once) the vendored WASM inference session.
 * @returns {Promise<{session: object, ort: object}>} the session and its runtime.
 * @throws {AudioEventError} when the runtime or model is not installed.
 */
export async function loadSession() {
  if (sessionPromise !== null) return sessionPromise

  sessionPromise = (async () => {
    const state = audioEventState()
    if (!state.available) throw new AudioEventError(state.reason ?? '音频事件检测不可用')

    const resolved = audioPaths()
    const ort = await import(pathToFileURL(resolved.ortEntry).href)
    // One thread and no proxy: the plugin runs inside the host process, and a worker pool
    // would spawn threads the host never asked for. Measured cost is 68-81 ms per window,
    // comfortably inside the 480 ms hop budget at this geometry.
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    ort.env.wasm.wasmPaths = { wasm: pathToFileURL(resolved.ortBinary).href }

    const session = await ort.InferenceSession.create(readFileSync(resolved.model), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    return { session, ort }
  })()

  try {
    return await sessionPromise
  } catch (error) {
    // A failed load must not be cached, or enabling the model later would need a restart.
    sessionPromise = null
    throw error
  }
}

/** Release the cached session. Only useful in tests and on plugin unload. */
export function disposeAudioSession() {
  sessionPromise = null
  classMapCache = null
}

/**
 * Classify a decoded signal into timestamped audio events.
 *
 * @param {Float32Array} samples - mono 16 kHz samples.
 * @param {number} sampleRate - their rate.
 * @param {object} [options] - `{ topK, minScore, silenceRms, maxWindows, onProgress }`.
 * @returns {Promise<object>} `{ segments, events, soundtrack, notes }`.
 * @throws {AudioEventError} when the model is unavailable or inference fails.
 */
export async function classifySamples(samples, sampleRate, options = {}) {
  const { session, ort } = await loadSession()
  if (classMapCache === null) classMapCache = readClassMap(audioPaths().classMap)
  const classNames = classMapCache

  const silenceRms = options.silenceRms ?? DEFAULT_SILENCE_RMS
  const windows = windowsOf(samples, sampleRate, { maxWindows: options.maxWindows })
  if (windows.length === 0) {
    return {
      segments: [],
      events: {},
      soundtrack: { windows: 0, classified: 0, silent: 0, durationSec: Number((samples.length / sampleRate).toFixed(3)) },
      notes: ['音频短于一个 0.96 秒分析窗，没有任何片段可分类。'],
    }
  }

  const segments = []
  let classified = 0
  let silent = 0

  for (const [position, window] of windows.entries()) {
    if (window.rms < silenceRms) {
      silent += 1
      segments.push({
        at: window.at,
        endAt: Number((window.at + YAMNET_WINDOW / sampleRate).toFixed(3)),
        rms: Number(window.rms.toFixed(5)),
        silent: true,
        labels: [],
      })
      continue
    }

    const length = window.samples.length
    const tensor = new ort.Tensor('float32', Float32Array.from(window.samples), [length])
    const output = await session.run({ waveform: tensor })
    // output_0 is the class score matrix; output_1 (embeddings) and output_2 (spectrogram)
    // are not used. Naming it through the session avoids relying on key insertion order.
    const scores = output[session.outputNames[0]]
    const verdict = topLabels(scores.data, scores.dims, classNames, {
      topK: options.topK,
      minScore: options.minScore,
    })
    classified += 1
    segments.push({
      at: window.at,
      endAt: Number((window.at + YAMNET_WINDOW / sampleRate).toFixed(3)),
      rms: Number(window.rms.toFixed(5)),
      silent: false,
      labels: verdict.labels.map((entry) => ({
        label: entry.label,
        score: Number(entry.score.toFixed(4)),
      })),
    })
    if (typeof options.onProgress === 'function') {
      options.onProgress({ done: position + 1, total: windows.length })
    }
  }

  return {
    segments,
    events: groupEvents(segments),
    soundtrack: {
      windows: windows.length,
      classified,
      silent,
      durationSec: Number((samples.length / sampleRate).toFixed(3)),
    },
    notes: [
      '标签来自 AudioSet 521 类本体，与 PANNs 同源；模型只给声学类别，不给"好不好听"的判断。',
      `RMS 低于 ${silenceRms} 的窗不参与分类，避免静音段被强行贴标签。`,
    ],
  }
}

/**
 * Group segment labels into `{ label: [timestamp, ...] }`, the shape the reference
 * implementation reports and the easiest one to scan for "when did the music start".
 *
 * @param {Array<{at: number, labels: Array<{label: string, score: number}>}>} segments - per-segment verdicts.
 * @returns {Record<string, number[]>} timestamps by label, in encounter order.
 */
export function groupEvents(segments) {
  const events = {}
  for (const segment of segments) {
    for (const { label } of segment.labels) {
      if (events[label] === undefined) events[label] = []
      events[label].push(segment.at)
    }
  }
  return events
}

/**
 * Detect audio events in a media file: extract, decode, classify.
 *
 * @param {string} path - the video or audio file.
 * @param {object} [options] - `{ config, start, duration, topK, minScore, silenceRms, onProgress }`.
 * @returns {Promise<object>} the analysis, including the extracted WAV path and its removal.
 * @throws {AudioEventError} when the file cannot be read or the model is unavailable.
 */
export async function detectAudioEvents(path, options = {}) {
  const state = audioEventState()
  if (!state.available) throw new AudioEventError(state.reason ?? '音频事件检测不可用')

  mkdirSync(AUDIO_TMP_DIR, { recursive: true })
  const wavPath = join(AUDIO_TMP_DIR, `probe-${process.pid}-${Date.now()}.wav`)
  let keep = false
  try {
    await extractAudio(path, { ...options, outPath: wavPath })
    const { samples, sampleRate, durationSec } = decodeWav(wavPath)
    if (durationSec > MAX_AUDIO_SECONDS) {
      throw new AudioEventError(
        `音频时长 ${durationSec.toFixed(1)} 秒超过上限 ${MAX_AUDIO_SECONDS} 秒；请用 start/duration 分段分析。`,
      )
    }
    const analysis = await classifySamples(samples, sampleRate, options)
    return { path: resolve(path), wav: keep ? wavPath : null, durationSec, ...analysis }
  } finally {
    if (!keep) rmSync(wavPath, { force: true })
  }
}
