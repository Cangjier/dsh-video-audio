/**
 * Environment facts: where this plugin lives, and how it finds the tools it borrows.
 *
 * This plugin owns one external dependency — ffmpeg — and it *borrows* rather than owns it.
 * ffmpeg is a few hundred megabytes, and the machine that produces audio almost always already
 * has one, because the sibling `video-factory` plugin downloaded it to render video. Copying it
 * here would mean two 194 MB builds on one disk for no benefit, so discovery reaches into a
 * sibling checkout instead.
 *
 * Discovery follows the precedence the sibling plugins established, extended by one case:
 *
 *   1. explicit configuration (`config.ffmpegPath`);
 *   2. this plugin's own environment variable (`DSH_AUDIO_FFMPEG`);
 *   3. a build vendored inside this plugin (`vendor/ffmpeg/bin`);
 *   4. a sibling `video-factory` checkout's vendored build — that is the normal case, and the
 *      report always names which candidate answered, so "it worked on my machine" stays
 *      explainable;
 *   5. `PATH`.
 *
 * The same sibling search locates the shared ONNX runtime: `vendor/audio` is where this plugin
 * installs YAMNet, and a sibling `video-factory` may already hold a copy from when the muxing
 * work lived there. Nothing is ever written to a sibling — only read.
 *
 * @module dsh-video-audio/core/env
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/** Plugin package root, resolved from this module so a `link:` install still works. */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BINARY_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const PROBE_NAME = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

/** Environment variable that overrides ffmpeg discovery outright. */
export const FFMPEG_ENV = 'DSH_AUDIO_FFMPEG'

/** Environment variable that overrides ffprobe discovery outright. */
export const FFPROBE_ENV = 'DSH_AUDIO_FFPROBE'

/** Environment variable that points at a shared `vendor/audio` directory outright. */
export const AUDIO_DIR_ENV = 'DSH_AUDIO_VENDOR'

/**
 * A configured audio directory, set once at plugin activation.
 *
 * The row's `config.audio.vendorDir` is the honest way to say where the shared model lives on a
 * machine whose layout discovery cannot guess; `process.env` is the way to say it to the CLI. Both
 * funnel through here so there is exactly one rule about precedence, and the discovery report
 * always names which directory answered.
 *
 * @type {string|null}
 */
let configuredAudioDir = null

/**
 * Record the configured audio directory. Called from `apply()`, before any tool runs.
 *
 * @param {string|null|undefined} directory - an absolute or relative path, or nothing.
 * @returns {void}
 */
export function setConfiguredAudioDir(directory) {
  configuredAudioDir =
    typeof directory === 'string' && directory.trim() !== '' ? resolve(directory) : null
}

/**
 * Resolve the working directory for one request.
 *
 * @param {object} config - normalized plugin config.
 * @param {string} [requested] - a caller-supplied directory.
 * @returns {string} an absolute working directory.
 */
export function resolveCwd(config, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested)
  if (typeof config?.projectRoot === 'string' && config.projectRoot.trim() !== '') return resolve(config.projectRoot)
  return process.cwd()
}

/**
 * Where a sibling plugin's vendored files would be.
 *
 * The hits are the layouts that actually occur: repositories checked out side by side, and a
 * `link:` install whose real path is inside a package directory.
 *
 * @param {string} tail - the path inside the sibling, for example `vendor/ffmpeg/bin`.
 * @returns {string[]} candidate directories, nearest first.
 */
function siblingPaths(tail) {
  const siblings = ['video-factory']
  const roots = [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]
  const candidates = []
  for (const root of roots) {
    for (const sibling of siblings) candidates.push(join(root, sibling, ...tail.split('/')))
  }
  return candidates
}

/**
 * Locate one borrowed binary: explicit config, then the environment, then a vendored build,
 * then a sibling plugin's vendored build, then PATH.
 *
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {string|null} explicit - a configured path.
 * @returns {{path: string, source: 'config'|'env'|'vendor'|'sibling'|'path'}|null} where it was found.
 */
export function findBinary(stem, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '' && existsSync(explicit)) {
    return { path: resolve(explicit), source: 'config' }
  }

  const fromEnv = stem === 'ffmpeg' ? process.env[FFMPEG_ENV] : process.env[FFPROBE_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && existsSync(fromEnv)) {
    return { path: resolve(fromEnv), source: 'env' }
  }

  const name = stem === 'ffmpeg' ? BINARY_NAME : PROBE_NAME
  const vendored = join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin', name)
  if (existsSync(vendored)) return { path: vendored, source: 'vendor' }

  for (const directory of siblingPaths('vendor/ffmpeg/bin')) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return { path: candidate, source: 'sibling' }
  }

  // PATH lookup without spawning a shell: on Windows a bare name would otherwise let the shell
  // resolve it and lose the absolute path the report needs.
  const entries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const entry of entries) {
    if (entry.trim() === '') continue
    const candidate = join(entry, name)
    if (existsSync(candidate)) return { path: candidate, source: 'path' }
  }
  return null
}

/**
 * Locate one binary and report only its path.
 *
 * @param {string} stem - `ffmpeg` or `ffprobe`.
 * @param {string|null} explicit - a configured path.
 * @returns {string|null} an existing absolute path, or null.
 */
export function resolveBinary(stem, explicit) {
  return findBinary(stem, explicit)?.path ?? null
}

/**
 * Every directory that could hold the shared audio assets, in preference order.
 *
 * The first entry is this plugin's own `vendor/audio`: that is where `audio_setup
 * {action:"install"}` writes, and a local copy always wins over a sibling's.
 *
 * @returns {string[]} candidate `vendor/audio` directories, nearest first.
 */
export function audioDirCandidates() {
  return audioDirCandidatesWithSource().map((candidate) => candidate.dir)
}

/**
 * The same candidates, each labelled with the rule that produced it.
 *
 * The label is what makes "it works on my machine" answerable: every state report names the
 * directory AND which rule found it, so a machine reading a sibling checkout can say so.
 *
 * @returns {{dir: string, source: 'config'|'env'|'vendor'|'sibling'}[]} candidates, nearest first.
 */
export function audioDirCandidatesWithSource() {
  const candidates = []
  if (configuredAudioDir !== null) candidates.push({ dir: configuredAudioDir, source: 'config' })
  if (typeof process.env[AUDIO_DIR_ENV] === 'string' && process.env[AUDIO_DIR_ENV].trim() !== '') {
    candidates.push({ dir: resolve(process.env[AUDIO_DIR_ENV]), source: 'env' })
  }
  candidates.push({ dir: join(PLUGIN_ROOT, 'vendor', 'audio'), source: 'vendor' })
  for (const directory of siblingPaths('vendor/audio')) candidates.push({ dir: directory, source: 'sibling' })
  return candidates
}

/**
 * The directory the shared audio assets are actually read from.
 *
 * @returns {{dir: string, source: 'config'|'env'|'vendor'|'sibling'}} the first candidate that
 *   exists, falling back to this plugin's own directory when none does.
 */
export function resolveAudioDir() {
  const candidates = audioDirCandidatesWithSource()
  for (const candidate of candidates) {
    if (existsSync(candidate.dir)) return candidate
  }
  // Nothing exists yet: report the install target, which is where an install will put it.
  return candidates.find((candidate) => candidate.source === 'vendor') ?? candidates[0]
}

/**
 * Read the first line of a binary's `-version` output.
 *
 * @param {string} binary - absolute path to an executable.
 * @returns {Promise<string|null>} the version line, or null on failure.
 */
export async function versionOf(binary) {
  try {
    const { stdout, stderr } = await runFile(binary, ['-version'], { timeout: 15000, windowsHide: true })
    const text = `${stdout}${stderr}`.split('\n').find((line) => line.trim() !== '')
    return text ? text.trim() : null
  } catch {
    return null
  }
}
