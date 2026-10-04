/**
 * What ffmpeg is asked to measure, and how its prose is turned back into numbers.
 *
 * The parsers are separated from the runs on purpose: `parseAstats` and `parseEbur128` are
 * pure functions of ffmpeg's standard error, so the exact text a given ffmpeg build
 * produces can be pinned in a test instead of being re-discovered by running a filter.
 *
 * Two rules hold for everything in this module:
 *
 * 1. **A measurement never changes the file.** Loudness, levels, silence, noise: all read
 *    the source and write nothing. Even the analysis decode goes to `-f null -` or a pipe.
 * 2. **ffmpeg's own numbers win where ffmpeg has them.** Integrated loudness (EBU R128),
 *    true peak, and the sample-exact decoded sample count are computed by ffmpeg's filters,
 *    not re-derived here: the point of picking this instrument is that its verdict is
 *    standard, and a second implementation would only be a second opinion.
 *
 * @module dsh-video-audio/core/audio-measure
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { run } from './ffmpeg.mjs'
import { probe } from './probe.mjs'
import { parseSilences } from './audio-silence.mjs'
import {
  amplitudeFromDb,
  bandwidthOf,
  clipRuns,
  dbFromAmplitude,
  envelopeDb,
  float32FromBuffer,
  goertzelDb,
  rmsOf,
  spectrumOf,
  tiltOf,
  tonalPeaks,
} from './audio-signal.mjs'

/** Raised when a measurement cannot be taken. */
export class AudioMeasureError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioMeasureError'
  }
}

/** Sample rate used for envelope and correlation work. Speech-band questions do not need more. */
export const ANALYSIS_SAMPLE_RATE = 8000

/**
 * Sample rate used for anything spectral.
 *
 * It has to be at least twice the highest frequency the answer is about, and the answers here
 * are about codecs: "where does this file stop carrying signal" is a question about 4, 11 or
 * 20 kHz, none of which exist in an 8 kHz stream. Measuring a bandwidth on the envelope rate
 * would report every file as 4 kHz wide.
 */
export const SPECTRUM_SAMPLE_RATE = 48_000

/** Default window for a PCM scan, in seconds. Bounds memory and the cost of one pass. */
export const DEFAULT_WINDOW_SECONDS = 60

/** Ceiling on one decoded PCM buffer, so a long file cannot exhaust memory. */
export const MAX_PCM_BYTES = 48 * 1024 * 1024

/** Analysis defaults that callers may override but that must have one documented value. */
export const MEASURE_DEFAULTS = {
  silenceNoiseDb: -40,
  silenceMinSeconds: 0.25,
  fftSize: 8192,
  bandwidthDropDb: 20,
  humProminenceDb: 6,
  mainsHz: 50,
  windowSeconds: DEFAULT_WINDOW_SECONDS,
}

/** Tilt bands reported by {@link measureNoise}; fixed so two files are comparable. */
export const TILT_BANDS = [
  { name: 'rumble_20_120', fromHz: 20, toHz: 120 },
  { name: 'low_120_500', fromHz: 120, toHz: 500 },
  { name: 'speech_500_4k', fromHz: 500, toHz: 4000 },
  { name: 'high_4k_12k', fromHz: 4000, toHz: 12_000 },
]

/**
 * Parse the number ffmpeg prints for a statistic, keeping `-inf` and `inf` meaningful.
 * @param {string} text - the raw field value.
 * @returns {number} the value, or NaN when it is not a number.
 */
function numberOrInfinity(text) {
  const value = String(text).trim()
  if (/^-?inf$/i.test(value)) return value.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

/**
 * Parse an `astats` run.
 *
 * The filter prints one block per channel and then an `Overall` block; the Overall block is
 * the only one that carries `Number of samples`, which is how the decoded length is known
 * exactly rather than inferred from timestamps. A stream whose frames were dropped (a
 * corrupt MP3, say) reports a sample count lower than its stated duration, and that
 * difference is the whole point of asking.
 *
 * @param {string} stderr - ffmpeg's standard error for an `astats` run.
 * @returns {{channels: object[], overall: object|null, decodedSamples: number|null}}
 */
export function parseAstats(stderr) {
  const channels = []
  let overall = null
  let current = null
  let target = null

  for (const rawLine of String(stderr).split('\n')) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, '').trim()
    if (line === '') continue
    if (line === 'Overall') {
      overall = { channel: 'overall' }
      target = overall
      continue
    }
    const channelMatch = /^Channel:\s*(\d+)/.exec(line)
    if (channelMatch !== null) {
      current = { channel: Number(channelMatch[1]) }
      channels.push(current)
      target = current
      continue
    }
    if (target === null) continue
    const field = /^([A-Za-z][A-Za-z0-9 _]*?):\s*(-?inf|-?[\d.]+)\s*$/.exec(line)
    if (field === null) continue
    target[field[1].trim()] = numberOrInfinity(field[2])
  }

  const decodedSamples = overall?.['Number of samples'] ?? null
  return { channels, overall, decodedSamples: Number.isFinite(decodedSamples) ? decodedSamples : null }
}

/**
 * Parse an `ebur128` run: the summary block plus the per-100 ms short-term timeline.
 *
 * The timeline is split on `t:` rather than on newlines because ffmpeg writes those records
 * with a carriage return and the captured text can break them anywhere; splitting on the
 * field that starts each record is immune to where the line happened to wrap.
 *
 * @param {string} stderr - ffmpeg's standard error for an `ebur128` run.
 * @returns {{integratedLufs: number|null, loudnessRangeLu: number|null, truePeakDbfs: number|null,
 *   thresholdLufs: number|null, lraLowLufs: number|null, lraHighLufs: number|null,
 *   shortTerm: {at: number, momentaryLufs: number|null, shortTermLufs: number|null}[]}}
 */
export function parseEbur128(stderr) {
  const text = String(stderr)
  const read = (pattern) => {
    const match = pattern.exec(text)
    return match === null ? null : numberOrInfinity(match[1])
  }

  const summary = {
    integratedLufs: read(/Integrated loudness:\s*\n\s*I:\s*(-?inf|-?[\d.]+)\s*LUFS/),
    thresholdLufs: read(/Integrated loudness:\s*\n\s*I:[^\n]*\n\s*Threshold:\s*(-?inf|-?[\d.]+)\s*LUFS/),
    loudnessRangeLu: read(/Loudness range:\s*\n\s*LRA:\s*(-?inf|-?[\d.]+)\s*LU/),
    lraLowLufs: read(/LRA low:\s*(-?inf|-?[\d.]+)\s*LUFS/),
    lraHighLufs: read(/LRA high:\s*(-?inf|-?[\d.]+)\s*LUFS/),
    truePeakDbfs: read(/True peak:\s*\n\s*Peak:\s*(-?inf|-?[\d.]+)\s*dBFS/),
  }

  const shortTerm = []
  for (const chunk of text.split(/t:\s*/).slice(1)) {
    const at = /^([\d.]+)/.exec(chunk)
    if (at === null) continue
    const momentary = /M:\s*(-?inf|-?[\d.]+)/.exec(chunk)
    const short = /S:\s*(-?inf|-?[\d.]+)/.exec(chunk)
    shortTerm.push({
      at: Number(at[1]),
      momentaryLufs: momentary === null ? null : numberOrInfinity(momentary[1]),
      shortTermLufs: short === null ? null : numberOrInfinity(short[1]),
    })
  }

  return { ...summary, shortTerm }
}

/**
 * Run `astats` over a file and report both the parsed statistics and the decode errors.
 *
 * @param {object} options - the measurement.
 * @param {string} options.source - file to measure.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.timeoutMs] - how long to allow.
 * @returns {Promise<object>} parsed statistics plus `decodeErrors` and `errorSamples`.
 */
export async function runAstats(options) {
  const result = await runAudio({
    source: options.source,
    config: options.config,
    timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
    // `-v info` and not `-v error`: astats prints its statistics through the logger, so at
    // error level the numbers this function exists to read are never emitted at all.
    argsFor: (inputFormat) => [
      '-v', 'info', '-nostats',
      ...(inputFormat === null ? [] : ['-f', inputFormat]),
      '-i', options.source, '-vn', '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-',
    ],
  })
  const parsed = parseAstats(result.stderr)
  const errorLines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /Header missing|Invalid data found|Failed to read frame|Error submitting packet|corrupt/i.test(line))
  return {
    ...parsed,
    forcedFormat: result.forcedFormat ?? null,
    decodeErrors: errorLines.length,
    errorSamples: [...new Set(errorLines)].slice(0, 6),
  }
}

/**
 * Measure a file's loudness the way broadcasters do.
 *
 * @param {object} options - the measurement.
 * @param {string} options.source - file to measure.
 * @param {object} [options.config] - normalized plugin config.
 * @param {boolean} [options.timeline] - also fold the short-term timeline into one entry per second.
 * @returns {Promise<object>} the loudness summary, the astats block, and optionally the timeline.
 */
export async function measureLoudness(options) {
  const [ebur, stats] = await Promise.all([
    runAudio({
      source: options.source,
      config: options.config,
      timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
      argsFor: (inputFormat) => [
        '-v', 'info', '-nostats',
        ...(inputFormat === null ? [] : ['-f', inputFormat]),
        '-i', options.source, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-',
      ],
    }),
    runAstats({ source: options.source, config: options.config, timeoutMs: options.timeoutMs }),
  ])

  const parsed = parseEbur128(ebur.stderr)
  const { shortTerm, ...summary } = parsed
  const report = {
    loudness: summary,
    stats: {
      overall: stats.overall,
      channels: stats.channels,
      decodedSamples: stats.decodedSamples,
      decodeErrors: stats.decodeErrors,
      errorSamples: stats.errorSamples,
    },
  }

  if (options.timeline === true && shortTerm.length > 0) {
    const bySecond = new Map()
    for (const entry of shortTerm) {
      const second = Math.floor(entry.at)
      const bucket = bySecond.get(second) ?? { at: second, loudestShortTermLufs: null, quietestShortTermLufs: null, samples: 0 }
      const value = entry.shortTermLufs
      if (value !== null && Number.isFinite(value)) {
        bucket.loudestShortTermLufs = bucket.loudestShortTermLufs === null ? value : Math.max(bucket.loudestShortTermLufs, value)
        bucket.quietestShortTermLufs = bucket.quietestShortTermLufs === null ? value : Math.min(bucket.quietestShortTermLufs, value)
      }
      bucket.samples += 1
      bySecond.set(second, bucket)
    }
    report.timeline = [...bySecond.values()].map((bucket) => ({
      at: bucket.at,
      loudestShortTermLufs: bucket.loudestShortTermLufs === null ? null : Number(bucket.loudestShortTermLufs.toFixed(1)),
      quietestShortTermLufs: bucket.quietestShortTermLufs === null ? null : Number(bucket.quietestShortTermLufs.toFixed(1)),
    }))
    const measured = report.timeline.filter((entry) => entry.loudestShortTermLufs !== null)
    report.loudestSecond = measured.reduce((best, entry) => (best === null || entry.loudestShortTermLufs > best.loudestShortTermLufs ? entry : best), null)
    report.quietestSecond = measured.reduce(
      (best, entry) => (best === null || entry.quietestShortTermLufs < best.quietestShortTermLufs ? entry : best),
      null,
    )
  }

  return report
}

/**
 * Name the container from its first bytes.
 *
 * Needed because automatic detection is not always right. On this machine's ffmpeg build
 * (n9.0.2, 2026-10-01) a plain 48 kHz mono WAV whose samples happen to look like MPEG-TS
 * sync bytes is probed as MPEG-TS, and then fails with "End of file" — ffprobe and ffmpeg
 * both, while the file is entirely valid. Naming the demuxer explicitly is the difference
 * between measuring the file and reporting that it cannot be read.
 *
 * @param {Buffer} head - the first bytes of a file, at least 12 of them.
 * @returns {string|null} an ffmpeg demuxer name, or null when the bytes are not recognised.
 */
export function sniffContainerBytes(head) {
  if (head.length < 12) return null
  const ascii = (from, to) => head.subarray(from, to).toString('latin1')
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav'
  if (ascii(0, 4) === 'RF64' && ascii(8, 12) === 'WAVE') return 'wav'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(4, 8) === 'ftyp') return 'mov'
  if (ascii(0, 3) === 'ID3') return 'mp3'
  // A bare MPEG audio frame header: eleven set bits, then a valid version and layer.
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ((head[1] >> 3) & 3) !== 1 && ((head[1] >> 1) & 3) !== 0) return 'mp3'
  if (ascii(0, 4) === 'FORM' && (ascii(8, 12) === 'AIFF' || ascii(8, 12) === 'AIFC')) return 'aiff'
  return null
}

/**
 * Read the first bytes of a file and name its container.
 * @param {string} path - the file.
 * @returns {string|null} an ffmpeg demuxer name, or null.
 */
export function sniffContainer(path) {
  let handle = null
  try {
    handle = openSync(path, 'r')
    const head = Buffer.alloc(16)
    const read = readSync(handle, head, 0, head.length, 0)
    return sniffContainerBytes(head.subarray(0, read))
  } catch {
    return null
  } finally {
    if (handle !== null) closeSync(handle)
  }
}

/**
 * Parse the input report ffmpeg prints for a file it can open.
 *
 * This is the fallback path for {@link describeAudio}, and it exists because ffprobe's
 * container *probing* is not always successful on files ffmpeg reads perfectly well: this
 * machine's build refuses some plain 48 kHz mono WAVs with "End of file" unless the demuxer is
 * named explicitly. Reading ffmpeg's own input line is enough for everything the audio family
 * needs — duration, codec, sample rate, channels, bit rate.
 *
 * @param {string} stderr - ffmpeg's standard error for an `-i <file> -f null -` run.
 * @returns {{durationSeconds: number|null, codec: string|null, sampleRate: number|null,
 *   channels: number|null, declaredBitRate: number|null, container: string|null}|null}
 */
export function parseFfmpegInput(stderr) {
  const text = String(stderr)
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text)
  const stream = /Stream #\d+:\d+(?:\([^)]*\))?:\s*Audio:\s*([A-Za-z0-9_]+)[^\n]*?,(\s*([\d]+)\s*Hz)?[^\n]*?,(\s*(mono|stereo|[\d.]+(?:\([^)]*\))?))?([^\n]*)/.exec(text)
  const container = /^Input #\d+,\s*([^,]+),/m.exec(text)
  if (duration === null && stream === null) return null

  const rate = stream?.[3] === undefined ? null : Number(stream[3])
  const channelText = stream?.[5] ?? null
  const channels =
    channelText === 'mono' ? 1 : channelText === 'stereo' ? 2 : channelText === null ? null : Number.parseInt(channelText, 10) || null
  const bitRate = /(\d+)\s*kb\/s/.exec(stream?.[6] ?? '')

  return {
    durationSeconds:
      duration === null ? null : Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    codec: stream?.[1] ?? null,
    sampleRate: Number.isFinite(rate) ? rate : null,
    channels,
    declaredBitRate: bitRate === null ? null : Number(bitRate[1]) * 1000,
    container: container === null ? null : container[1].trim(),
  }
}

/**
 * Describe an audio file for measurement, tolerating a container probe that fails.
 *
 * `probe()` is preferred: it is one ffprobe call and it reports the container's own view of
 * itself. When probing fails, ffmpeg's input report is used instead of failing the action —
 * a measurement tool that cannot measure a file ffmpeg can decode is a tool with no answer.
 *
 * @param {string} source - the file.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} duration, codec, sampleRate, channels, bitRate, and which tool answered.
 * @throws {AudioMeasureError} when neither tool can read the file.
 */
export async function describeAudio(source, config = {}) {
  try {
    const info = await probe(source, config)
    return {
      source,
      answeredBy: 'ffprobe',
      container: info.formatName ?? null,
      codec: info.audioCodec ?? null,
      sampleRate: Number(info.sampleRate) || null,
      channels: Number(info.channels) || null,
      durationSeconds: Number(info.duration) || 0,
      declaredBitRate: Number(info.bitRate) || null,
    }
  } catch (probeError) {
    // Probing failed. Try ffmpeg, first as it would, then with the demuxer named from the
    // file's own magic bytes — which is what rescues a file the prober mis-identified.
    const guessed = sniffContainer(source)
    const attempts = guessed === null ? [null] : [null, guessed]
    let lastStderr = ''
    for (const inputFormat of attempts) {
      const args = ['-hide_banner', '-nostats']
      if (inputFormat !== null) args.push('-f', inputFormat)
      args.push('-i', source, '-vn', '-f', 'null', '-')
      try {
        const result = await run({ tool: 'ffmpeg', args, config, timeoutMs: 10 * 60 * 1000 })
        lastStderr = result.stderr
      } catch (error) {
        lastStderr = typeof error?.stderr === 'string' ? error.stderr : ''
      }
      const parsed = parseFfmpegInput(lastStderr)
      if (parsed !== null) {
        return {
          source,
          answeredBy: 'ffmpeg',
          forcedFormat: inputFormat,
          container: parsed.container ?? inputFormat,
          codec: parsed.codec,
          sampleRate: parsed.sampleRate,
          channels: parsed.channels,
          durationSeconds: parsed.durationSeconds ?? 0,
          declaredBitRate: parsed.declaredBitRate,
          note:
            'ffprobe 无法探测这个容器（本机构建会把某些 WAV 误判成 MPEG-TS 并报 End of file），已改用 ffmpeg 的输入报告' +
            (inputFormat === null ? '。' : `，并显式指定 -f ${inputFormat}。`),
        }
      }
    }
    throw new AudioMeasureError(
      `无法读取媒体信息（${source}）：ffprobe 与 ffmpeg 都读不出来。` +
        `ffprobe 的报错是「${probeError instanceof Error ? probeError.message.split('\n')[0] : String(probeError)}」。` +
        (guessed === null ? '' : `按文件头看起来是 ${guessed}，显式指定后仍然失败。`),
    )
  }
}

/**
 * Run ffmpeg on a file, naming the demuxer only when automatic detection gets it wrong.
 *
 * Every decode, statistic and filter run in this module goes through here for one reason: a
 * file that ffmpeg mis-identifies (this build mistakes some 48 kHz WAVs for MPEG-TS) fails
 * once, and then succeeds when `-f wav` is put in front of it. Retrying with the container the
 * file's own magic bytes declare costs one extra process only in the failing case.
 *
 * @param {object} options - the run.
 * @param {string} options.source - the input file.
 * @param {(inputFormat: string|null) => string[]} options.argsFor - builds the argument list.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.timeoutMs] - kill after this long.
 * @param {'utf8'|'buffer'} [options.stdoutEncoding] - how to collect standard output.
 * @param {number} [options.maxStdoutBytes] - cap on collected standard output.
 * @returns {Promise<{code: number, stderr: string, stdout: string|Buffer, forcedFormat: string|null}>}
 */
export async function runAudio(options) {
  const config = options.config ?? {}
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  const invoke = (inputFormat) =>
    run({
      tool: 'ffmpeg',
      args: options.argsFor(inputFormat),
      config,
      timeoutMs,
      stdoutEncoding: options.stdoutEncoding ?? 'utf8',
      maxStdoutBytes: options.maxStdoutBytes ?? Number.POSITIVE_INFINITY,
    })

  try {
    const result = await invoke(null)
    return { ...result, forcedFormat: null }
  } catch (error) {
    const guessed = sniffContainer(options.source)
    if (guessed === null) throw error
    const result = await invoke(guessed)
    return { ...result, forcedFormat: guessed }
  }
}

/**
 * Map a file's speech and silence.
 *
 * `silencedetect` decides; this only orders the result and adds the arithmetic a caller
 * would otherwise redo (gap lengths, speech total, longest pause). The threshold and
 * minimum duration are echoed in the result because a segment list is meaningless without
 * them.
 *
 * @param {object} options - the measurement.
 * @param {string} options.source - file to measure.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.noiseDb] - level below which audio counts as silence; default -40.
 * @param {number} [options.minSeconds] - shortest silence worth reporting; default 0.25.
 * @returns {Promise<object>} silences, the speech segments between them, and their totals.
 */
export async function measureSilences(options) {
  const noiseDb = options.noiseDb ?? MEASURE_DEFAULTS.silenceNoiseDb
  const minSeconds = options.minSeconds ?? MEASURE_DEFAULTS.silenceMinSeconds
  const info = await describeAudio(options.source, options.config ?? {})
  const total = Number(info.durationSeconds) || 0

  const result = await runAudio({
    source: options.source,
    config: options.config,
    timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
    argsFor: (inputFormat) => [
      '-v', 'info', '-nostats',
      ...(inputFormat === null ? [] : ['-f', inputFormat]),
      '-i', options.source, '-vn',
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`,
      '-f', 'null', '-',
    ],
  })

  const silences = parseSilences(result.stderr).map((silence) => ({
    start: Number(silence.start.toFixed(4)),
    end: silence.end === null ? Number(total.toFixed(4)) : Number(silence.end.toFixed(4)),
  }))
  for (const silence of silences) {
    silence.seconds = Number((silence.end - silence.start).toFixed(4))
    silence.closed = silence.end < total
  }

  const speech = []
  let cursor = 0
  for (const silence of silences) {
    if (silence.start > cursor) speech.push({ start: Number(cursor.toFixed(4)), end: silence.start, seconds: Number((silence.start - cursor).toFixed(4)) })
    cursor = Math.max(cursor, silence.end)
  }
  if (cursor < total) speech.push({ start: Number(cursor.toFixed(4)), end: Number(total.toFixed(4)), seconds: Number((total - cursor).toFixed(4)) })

  const speechSeconds = speech.reduce((sum, entry) => sum + entry.seconds, 0)
  const longestGap = silences.reduce((best, entry) => (best === null || entry.seconds > best.seconds ? entry : best), null)

  return {
    source: options.source,
    durationSeconds: Number(total.toFixed(4)),
    thresholdDb: noiseDb,
    minSilenceSeconds: minSeconds,
    silence: silences,
    speech,
    speechSeconds: Number(speechSeconds.toFixed(4)),
    silenceSeconds: Number((total - speechSeconds).toFixed(4)),
    longestGap,
  }
}

/**
 * Decode a bounded slice of a file to mono (or N-channel) float samples.
 *
 * Windowed rather than whole-file so a two-hour recording does not have to fit in memory;
 * the caller loops with {@link scanPcm} when it needs the whole thing.
 *
 * @param {object} options - the decode.
 * @param {string} options.source - file to decode.
 * @param {number} [options.sampleRate] - target rate; default 8000.
 * @param {number} [options.channels] - 1 or 2; default 1.
 * @param {number} [options.start] - first second to decode.
 * @param {number} [options.duration] - how many seconds; omit for the rest of the file.
 * @param {number} [options.maxBytes] - refuse anything larger; default 48 MB.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<{samples: Float32Array, frames: number, channels: number, sampleRate: number, bytes: number}>}
 * @throws {AudioMeasureError} when ffmpeg fails or the slice exceeds the byte ceiling.
 */
export async function decodePcm(options) {
  const sampleRate = options.sampleRate ?? ANALYSIS_SAMPLE_RATE
  const channels = options.channels ?? 1
  const maxBytes = options.maxBytes ?? MAX_PCM_BYTES

  let result
  try {
    result = await runAudio({
      source: options.source,
      config: options.config,
      timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
      stdoutEncoding: 'buffer',
      maxStdoutBytes: maxBytes,
      argsFor: (inputFormat) => [
        ...(Number.isFinite(options.start) ? ['-ss', String(options.start)] : []),
        ...(Number.isFinite(options.duration) ? ['-t', String(options.duration)] : []),
        ...(inputFormat === null ? [] : ['-f', inputFormat]),
        '-i', options.source, '-vn',
        '-ac', String(channels), '-ar', String(sampleRate),
        '-f', 'f32le', '-',
      ],
    })
  } catch (error) {
    throw new AudioMeasureError(
      `解码失败（${options.source}）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }

  const buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '')
  const samples = float32FromBuffer(buffer)
  return {
    samples,
    frames: Math.floor(samples.length / channels),
    channels,
    sampleRate,
    bytes: buffer.length,
    forcedFormat: result.forcedFormat ?? null,
  }
}

/**
 * Walk a file in fixed windows, handing each window's samples to a callback.
 *
 * Used by the level and noise actions, which need sample-domain access over a file that may
 * be far longer than memory allows. The window start is an input seek, so a window boundary
 * can land up to one codec frame away from the requested time; the returned `aligned` flag
 * is false when any window came back short, which is exactly when that slop matters.
 *
 * @param {object} options - the scan.
 * @param {string} options.source - file to scan.
 * @param {number} [options.sampleRate] - decode rate; default 8000.
 * @param {number} [options.channels] - decode channels; default 1.
 * @param {number} [options.windowSeconds] - window length; default 60.
 * @param {number} [options.maxSeconds] - stop after this much audio.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(window: {samples: Float32Array, offsetSeconds: number, index: number}) => void} options.onWindow -
 *   called once per window with mono-summed-by-max samples and the window's start time.
 * @returns {Promise<{windows: number, seconds: number, aligned: boolean}>}
 */
export async function scanPcm(options) {
  const sampleRate = options.sampleRate ?? ANALYSIS_SAMPLE_RATE
  const channels = options.channels ?? 1
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS
  const maxSeconds = Number.isFinite(options.maxSeconds) ? options.maxSeconds : Number.POSITIVE_INFINITY
  const info = await describeAudio(options.source, options.config ?? {})
  const total = Math.min(Number(info.durationSeconds) || 0, maxSeconds)

  let windows = 0
  let seconds = 0
  let aligned = true
  for (let start = 0; start < total; start += windowSeconds) {
    const duration = Math.min(windowSeconds, total - start)
    const decoded = await decodePcm({ ...options, sampleRate, channels, start, duration })
    if (decoded.frames === 0) break
    const expected = Math.round(duration * sampleRate)
    if (Math.abs(decoded.frames - expected) > sampleRate * 0.05) aligned = false
    options.onWindow({ samples: decoded.samples, offsetSeconds: start, index: windows })
    windows += 1
    seconds += decoded.frames / sampleRate
    if (seconds >= total) break
  }
  return { windows, seconds: Number(seconds.toFixed(4)), aligned }
}

/**
 * Measure what a file's noise floor is made of.
 *
 * Three separate facts, because they have three different fixes: the broadband floor (gain
 * staging, or a denoiser), the mains hum family (a notch, or a different cable), and the
 * tilt (a codec or a microphone, nothing a filter should be pointed at).
 *
 * @param {object} options - the measurement.
 * @param {string} options.source - file to measure.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.mainsHz] - the mains frequency to look for; default 50.
 * @param {number} [options.windowSeconds] - analysis window; default 30.
 * @param {number} [options.fftSize] - FFT size for tilt and peaks; default 8192.
 * @returns {Promise<object>} floor, hum table, tilt, tonal peaks, and the spectrum's summary.
 */
export async function measureNoise(options) {
  const windowSeconds = options.windowSeconds ?? 30
  const fftSize = options.fftSize ?? MEASURE_DEFAULTS.fftSize
  const mainsHz = options.mainsHz ?? MEASURE_DEFAULTS.mainsHz

  let totalRms = 0
  let windows = 0
  let quietest = null
  let spectrum = null
  let spectrumAt = null
  let loudestRms = 0
  const hum = new Map()

  const scan = await scanPcm({
    source: options.source,
    config: options.config,
    sampleRate: SPECTRUM_SAMPLE_RATE,
    channels: 1,
    windowSeconds: Math.min(windowSeconds, DEFAULT_WINDOW_SECONDS),
    onWindow: ({ samples, offsetSeconds }) => {
      const rms = rmsOf(samples)
      totalRms += rms
      windows += 1
      if (quietest === null || rms < quietest.rms) quietest = { at: offsetSeconds, rms }
      if (rms > loudestRms) loudestRms = rms

      // The spectrum that describes the noise floor is the spectrum of the quietest window:
      // measuring the noise in a window that contains speech measures the speech.
      if (spectrum === null || rms <= quietest.rms) {
        spectrum = spectrumOf(samples, { size: fftSize })
        spectrumAt = offsetSeconds
      }

      for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
        for (const family of [50, 60]) {
          const frequency = family * harmonic
          if (frequency > SPECTRUM_SAMPLE_RATE / 2 - 50) continue
          const key = `${family}:${harmonic}`
          const db = goertzelDb(samples, SPECTRUM_SAMPLE_RATE, frequency)
          const entry = hum.get(key) ?? { familyHz: family, harmonic, frequencyHz: frequency, db: Number.NEGATIVE_INFINITY, worstAt: offsetSeconds }
          if (db > entry.db) {
            entry.db = db
            entry.worstAt = offsetSeconds
          }
          hum.set(key, entry)
        }
      }
    },
  })

  if (windows === 0 || spectrum === null) {
    throw new AudioMeasureError(`没有可分析的有效音频：${options.source}`)
  }

  const spectrumSummary = bandwidthOf(spectrum.magnitudes, SPECTRUM_SAMPLE_RATE, { dropDb: MEASURE_DEFAULTS.bandwidthDropDb })
  const tilt = tiltOf(spectrum.magnitudes, SPECTRUM_SAMPLE_RATE, TILT_BANDS)
  const peaks = tonalPeaks(spectrum.magnitudes, SPECTRUM_SAMPLE_RATE, {
    count: 8,
    prominenceDb: MEASURE_DEFAULTS.humProminenceDb,
    toHz: SPECTRUM_SAMPLE_RATE / 2 - 100,
  })

  const humTable = [...hum.values()]
    .map((entry) => ({
      ...entry,
      db: Number.isFinite(entry.db) ? Number(entry.db.toFixed(2)) : null,
      amplitude: Number.isFinite(entry.db) ? Number(amplitudeFromDb(entry.db).toFixed(6)) : null,
    }))
    .sort((a, b) => a.familyHz - b.familyHz || a.harmonic - b.harmonic)

  const sumFamily = (familyHz) => {
    let sum = 0
    for (const entry of humTable) {
      if (entry.familyHz === familyHz && entry.db !== null) sum += amplitudeFromDb(entry.db) ** 2
    }
    return Number(dbFromAmplitude(Math.sqrt(sum)).toFixed(2))
  }

  const mainsFamily = sumFamily(50) >= sumFamily(60) ? 50 : 60
  return {
    source: options.source,
    windows,
    analysedSeconds: Number(scan.seconds.toFixed(4)),
    windowAligned: scan.aligned,
    broadband: {
      meanRmsDb: Number(dbFromAmplitude(totalRms / windows).toFixed(2)),
      loudestRmsDb: Number(dbFromAmplitude(loudestRms).toFixed(2)),
      quietestRmsDb: Number(dbFromAmplitude(quietest.rms).toFixed(2)),
      quietestAt: Number(quietest.at.toFixed(3)),
    },
    // The floor the DSP answers come from: the quietest window, measured by ffmpeg's own
    // histogram statistic over the whole file, and by RMS over that window.
    hum: {
      requestedMainsHz: mainsHz,
      dominantFamilyHz: mainsFamily,
      sum50HzDb: sumFamily(50),
      sum60HzDb: sumFamily(60),
      harmonics: humTable,
    },
    spectrum: {
      atSeconds: Number((spectrumAt ?? 0).toFixed(3)),
      fftSize,
      sampleRate: SPECTRUM_SAMPLE_RATE,
      bandwidth: spectrumSummary,
      tilt,
      tonalPeaks: peaks,
    },
  }
}

/**
 * Sample-domain facts about a file: peak, RMS, crest factor, DC offset, exact clip runs and
 * a per-second level timeline.
 *
 * Decoded at the file's own sample rate, because resampling changes peaks: a clip that
 * exists at 24 kHz can disappear when the same audio is described at 8 kHz, and a level
 * meter that lies about clipping is worse than none.
 *
 * @param {object} options - the measurement.
 * @param {string} options.source - file to measure.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.clipThreshold] - amplitude counting as clipped; default 0.999.
 * @param {number} [options.minClipSamples] - shortest run worth listing; default 3.
 * @param {number} [options.maxSeconds] - stop after this much audio; default 600.
 * @param {boolean} [options.timeline] - include the per-second level timeline; default true.
 * @returns {Promise<object>} the sample-domain report.
 */
export async function measureLevels(options) {
  const clipThreshold = options.clipThreshold ?? 0.999
  const minClipSamples = options.minClipSamples ?? 3
  const maxSeconds = options.maxSeconds ?? 600
  const wantTimeline = options.timeline !== false

  const info = await describeAudio(options.source, options.config ?? {})
  const nativeRate = Number(info.sampleRate) || 48_000
  const channels = Math.min(2, Math.max(1, Number(info.channels) || 1))
  const total = Math.min(Number(info.durationSeconds) || 0, maxSeconds)

  // One decode per 30 s of audio at the native rate: enough to keep every sample of a long
  // file out of memory while still measuring at the rate the file actually uses.
  const chunkSeconds = 30
  const perChannelPeak = new Array(channels).fill(0)
  const perChannelDcSum = new Array(channels).fill(0)
  const perChannelSquares = new Array(channels).fill(0)
  const perChannelClipSamples = new Array(channels).fill(0)
  const runs = []
  let frameCount = 0
  let clipTotalHighSamples = 0
  let clipListedRuns = 0
  let clipTruncated = false
  const timeline = []
  let windows = 0
  let aligned = true

  for (let start = 0; start < total; start += chunkSeconds) {
    const duration = Math.min(chunkSeconds, total - start)
    const decoded = await decodePcm({
      source: options.source,
      config: options.config,
      sampleRate: nativeRate,
      channels,
      start,
      duration,
      maxBytes: MAX_PCM_BYTES,
    })
    if (decoded.frames === 0) break
    const expected = Math.round(duration * nativeRate)
    if (Math.abs(decoded.frames - expected) > nativeRate * 0.05) aligned = false

    // Loudest channel per frame, so a clip in either channel is seen.
    const mono = new Float32Array(decoded.frames)
    for (let frame = 0; frame < decoded.frames; frame += 1) {
      let best = 0
      for (let channel = 0; channel < channels; channel += 1) {
        const value = decoded.samples[frame * channels + channel]
        if (Math.abs(value) > Math.abs(best)) best = value
      }
      mono[frame] = best
    }

    for (let channel = 0; channel < channels; channel += 1) {
      for (let frame = 0; frame < decoded.frames; frame += 1) {
        const value = decoded.samples[frame * channels + channel]
        const absolute = Math.abs(value)
        if (absolute > perChannelPeak[channel]) perChannelPeak[channel] = absolute
        perChannelDcSum[channel] += value
        perChannelSquares[channel] += value * value
      }
    }

    if (wantTimeline) {
      for (const entry of envelopeDb(mono, nativeRate, 1)) {
        timeline.push({ at: Number((start + entry.at).toFixed(3)), rmsDb: entry.db })
      }
    }

    const found = clipRuns(mono, {
      threshold: clipThreshold,
      minRunSamples: minClipSamples,
      sampleRate: nativeRate,
      offsetSeconds: start,
      maxRuns: 200,
    })
    clipTotalHighSamples += found.totalHighSamples
    clipListedRuns += found.listedRuns
    clipTruncated = clipTruncated || found.truncated
    for (const run of found.runs) {
      if (runs.length < 200) runs.push({ ...run, channel: 'loudest' })
    }

    frameCount += decoded.frames
    windows += 1
  }

  const peak = Math.max(...perChannelPeak)
  const rms = frameCount > 0 ? Math.sqrt(perChannelSquares.reduce((sum, value) => sum + value, 0) / (frameCount * channels)) : 0
  const mixing = (perChannelDcSum.reduce((sum, value) => sum + value, 0) / Math.max(1, frameCount * channels))

  return {
    source: options.source,
    sampleRate: nativeRate,
    channels,
    analysedSeconds: Number((frameCount / nativeRate).toFixed(4)),
    requestedSeconds: Number(total.toFixed(4)),
    windowAligned: aligned,
    truncatedAtMaxSeconds: (Number(info.durationSeconds) || 0) > maxSeconds,
    peak: Number(peak.toFixed(6)),
    peakDbfs: Number(dbFromAmplitude(peak).toFixed(2)),
    rms: Number(rms.toFixed(6)),
    rmsDbfs: Number(dbFromAmplitude(rms).toFixed(2)),
    crestFactorDb: rms > 0 ? Number(dbFromAmplitude(peak / rms).toFixed(2)) : null,
    dcOffset: Number(mixing.toFixed(6)),
    dcOffsetDbfs: Number(dbFromAmplitude(Math.abs(mixing)).toFixed(2)),
    perChannel: perChannelPeak.map((value, index) => ({
      channel: index + 1,
      peak: Number(value.toFixed(6)),
      peakDbfs: Number(dbFromAmplitude(value).toFixed(2)),
      rmsDbfs: Number(dbFromAmplitude(Math.sqrt(perChannelSquares[index] / Math.max(1, frameCount))).toFixed(2)),
      dcOffset: Number((perChannelDcSum[index] / Math.max(1, frameCount)).toFixed(6)),
    })),
    clipping: {
      threshold: clipThreshold,
      minRunSamples: minClipSamples,
      totalHighSamples: clipTotalHighSamples,
      listedRuns: clipListedRuns,
      truncated: clipTruncated,
      runs,
    },
    timeline: wantTimeline ? timeline : null,
  }
}

/**
 * Full stream report for a file: what it claims to be, and what it decodes to.
 *
 * The gap between the two is the single most useful number in this module. A stated
 * duration comes from a header; the decoded sample count comes from the frames that are
 * actually readable, and a file that loses twenty percent of its frames reports a stated
 * duration it cannot deliver.
 *
 * @param {object} options - the measurement.
 * @param {string} options.source - file to inspect.
 * @param {object} [options.config] - normalized plugin config.
 * @param {boolean} [options.spectrum] - also measure bandwidth and tilt; default true.
 * @returns {Promise<object>} the format report.
 */
export async function identifyAudio(options) {
  const info = await describeAudio(options.source, options.config ?? {})
  const stats = await runAstats({ source: options.source, config: options.config })
  const sampleRate = Number(info.sampleRate) || 0
  const decodedSeconds = stats.decodedSamples !== null && sampleRate > 0 ? stats.decodedSamples / sampleRate : null
  const declared = Number(info.durationSeconds) || 0

  const report = {
    source: options.source,
    answeredBy: info.answeredBy,
    container: info.container ?? null,
    codec: info.codec ?? null,
    sampleRate,
    channels: Number(info.channels) || 0,
    declaredBitRate: info.declaredBitRate ?? null,
    declaredSeconds: Number(declared.toFixed(4)),
    decodedSeconds: decodedSeconds === null ? null : Number(decodedSeconds.toFixed(4)),
    decodedVsDeclaredSeconds: decodedSeconds === null ? null : Number((decodedSeconds - declared).toFixed(4)),
    decodedVsDeclaredPercent: decodedSeconds === null || declared === 0 ? null : Number((((decodedSeconds - declared) / declared) * 100).toFixed(2)),
    decodeErrors: stats.decodeErrors,
    errorSamples: stats.errorSamples,
    stats: stats.overall,
  }
  if (info.note !== undefined) report.note = info.note

  if (options.spectrum !== false) {
    try {
      const decoded = await decodePcm({
        source: options.source,
        config: options.config,
        sampleRate: Math.min(48_000, sampleRate > 0 ? sampleRate * 2 : 48_000),
        channels: 1,
        duration: 60,
        maxBytes: MAX_PCM_BYTES,
      })
      const spectrum = spectrumOf(decoded.samples, { size: MEASURE_DEFAULTS.fftSize })
      report.spectrum = {
        windowSeconds: Number((decoded.frames / decoded.sampleRate).toFixed(3)),
        bandwidth: bandwidthOf(spectrum.magnitudes, decoded.sampleRate, { dropDb: MEASURE_DEFAULTS.bandwidthDropDb }),
        tilt: tiltOf(spectrum.magnitudes, decoded.sampleRate, TILT_BANDS),
      }
    } catch (error) {
      report.spectrum = { error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
    }
  }

  return report
}
