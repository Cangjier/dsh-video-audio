/**
 * Media inspection: turn an ffprobe run into a plain object.
 *
 * The pipeline asks three questions of a file — how big is it, how long is it, and
 * does it carry audio — and the answers must be normalized, because ffprobe reports
 * them inconsistently across containers. A still image has no duration at all, a
 * stream's frame rate arrives as a rational string, and rotation can hide in either
 * a side-data field or a display matrix.
 *
 * @module dsh-video-audio/core/probe
 */
import { statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { FFmpegError, runProbe } from './ffmpeg.mjs'

/** Extensions treated as still images. */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.heic', '.heif', '.avif',
])

/** Extensions treated as audio. */
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'])

/** Extensions treated as video. */
export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv', '.wmv', '.ts', '.mpg', '.mpeg',
])

/** Raised when a file cannot be inspected at all. */
export class ProbeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeError'
  }
}

/**
 * Classify a path by extension.
 * @param {string} path - the file path.
 * @returns {'image'|'video'|'audio'|'unknown'} the media kind.
 */
export function classify(path) {
  const extension = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'unknown'
}

/**
 * Parse a ffprobe rational such as `30000/1001` into a number.
 * @param {string|undefined} value - the rational string.
 * @returns {number} the value, or 0 when it cannot be parsed.
 */
export function parseRational(value) {
  if (typeof value !== 'string' || value === '' || value === '0/0') return 0
  const [numerator, denominator] = value.split('/')
  const top = Number(numerator)
  const bottom = denominator === undefined ? 1 : Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0
  return top / bottom
}

/**
 * Extract the rotation angle from a video stream, in degrees.
 *
 * ffmpeg reports this in two places depending on version and container: a
 * `rotation` tag, or a `displaymatrix` side-data entry whose value is a matrix.
 * @param {object} stream - an ffprobe stream object.
 * @returns {number} a normalized angle in [0, 360).
 */
export function rotationOf(stream) {
  const tag = stream?.tags?.rotate
  if (tag !== undefined && Number.isFinite(Number(tag))) {
    return ((Number(tag) % 360) + 360) % 360
  }
  for (const entry of stream?.side_data_list ?? []) {
    if (typeof entry.rotation === 'number') return ((entry.rotation % 360) + 360) % 360
  }
  return 0
}

/**
 * Normalize one ffprobe result into the shape the pipeline uses.
 * @param {object} document - the parsed ffprobe JSON.
 * @param {string} path - the inspected path, for the record.
 * @returns {object} the normalized media info.
 */
function normalize(document, path) {
  const streams = Array.isArray(document?.streams) ? document.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const format = document?.format ?? {}

  const duration =
    Number(format.duration) ||
    Number(video?.duration) ||
    Number(audio?.duration) ||
    0

  let sizeBytes = Number(format.size) || 0
  if (sizeBytes === 0) {
    try {
      sizeBytes = statSync(path).size
    } catch {
      sizeBytes = 0
    }
  }

  const rotation = video === undefined ? 0 : rotationOf(video)
  const rotated = rotation === 90 || rotation === 270
  const width = Number(video?.width) || 0
  const height = Number(video?.height) || 0

  return {
    path: resolve(path),
    name: basename(path),
    kind: classify(path),
    duration,
    sizeBytes,
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
    // Display dimensions after rotation, which is what a viewer actually sees.
    width: rotated ? height : width,
    height: rotated ? width : height,
    codedWidth: width,
    codedHeight: height,
    rotation,
    fps: video === undefined ? 0 : parseRational(video.r_frame_rate) || parseRational(video.avg_frame_rate),
    pixFmt: video?.pix_fmt ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: Number(audio?.sample_rate) || 0,
    channels: Number(audio?.channels) || 0,
    bitRate: Number(format.bit_rate) || 0,
    formatName: format.format_name ?? null,
    nbFrames: Number(video?.nb_frames) || 0,
  }
}

/**
 * Inspect one media file.
 * @param {string} path - the file to inspect.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} the normalized media info.
 * @throws {ProbeError} when the file does not exist.
 * @throws {FFmpegError} when ffprobe fails on it.
 */
export async function probe(path, config = {}) {
  const absolute = resolve(path)
  try {
    statSync(absolute)
  } catch {
    throw new ProbeError(`文件不存在：${absolute}`)
  }
  const document = await runProbe(
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolute],
    config,
  )
  return normalize(document, absolute)
}

/**
 * Inspect several files, tolerating individual failures.
 *
 * A folder frequently contains one file ffprobe cannot read; reporting it as a
 * skipped entry is more useful than failing the whole inventory.
 *
 * @param {string[]} paths - files to inspect.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{items: object[], skipped: {path: string, reason: string}[]}>} results.
 */
export async function probeMany(paths, config = {}) {
  const items = []
  const skipped = []
  for (const path of paths) {
    try {
      items.push(await probe(path, config))
    } catch (error) {
      skipped.push({ path: resolve(path), reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { items, skipped }
}

/**
 * Whether a probed record looks like a still image rather than a moving picture.
 *
 * Extension alone is not enough: a `.png` can be a video stream in some containers,
 * and a `.mp4` can hold a single frame.
 * @param {object} info - a normalized media info record.
 * @returns {boolean} whether to treat it as a still.
 */
export function isStill(info) {
  if (info.kind === 'image') return true
  return info.hasVideo && info.duration <= 0.05
}

/**
 * Report which stream information is missing for a file the plan expects to use.
 * @param {object} info - a normalized media info record.
 * @returns {string[]} human-readable problems, empty when nothing is wrong.
 */
export function streamProblems(info) {
  const problems = []
  if (info.kind === 'unknown') problems.push(`${info.name}: 扩展名不受支持`)
  if (!info.hasVideo && info.kind !== 'audio') problems.push(`${info.name}: 没有视频流`)
  if (info.hasVideo && info.width === 0) problems.push(`${info.name}: 读不到画面尺寸`)
  return problems
}

export { FFmpegError }
