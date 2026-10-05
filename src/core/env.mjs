/**
 * Environment facts: where this plugin lives, and how it finds the tools it borrows.
 *
 * This plugin owns one external dependency — ffmpeg — and it *borrows* rather than owns it.
 * ffmpeg is a few hundred megabytes, and the machine that produces audio almost always already
 * has one, because a sibling plugin downloaded it to render video. Copying it here would mean two
 * builds on one disk for no benefit, so discovery reaches into **the shared plugin home**
 * (`~/.dsh-plugins/ffmpeg/bin`, one build for all six plugins) and only then into a sibling
 * checkout.
 *
 * Discovery follows the precedence the sibling plugins established, extended by one case:
 *
 *   1. explicit configuration (`config.ffmpegPath`);
 *   2. this plugin's own environment variable (`DSH_AUDIO_FFMPEG`);
 *   3. a build vendored inside this plugin (`vendor/ffmpeg/bin`) — the legacy location;
 *   4. **the shared plugin home**;
 *   5. a sibling `video-factory` checkout's vendored build;
 *   6. `PATH`.
 *
 * `path` still answers last, but every earlier rule names itself in the report, so "it worked on
 * my machine" stays explainable.
 *
 * The shared assets follow the same shape: the YAMNet model lives in
 * `~/.dsh-plugins/models/yamnet`, the ONNX WASM runtime in `~/.dsh-plugins/lib/onnxruntime-web`,
 * and `vendor/audio` plus a sibling `video-factory` copy remain as the layouts that existed before
 * the shared home. Nothing is ever written to a sibling — only read.
 *
 * @module dsh-video-audio/core/env
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  PLUGIN_ROOT,
  SHARED_FFMPEG_BIN,
  SHARED_FFMPEG_DIR,
  SHARED_RUNTIME_DIR,
  SHARED_YAMNET_DIR,
  binaryName,
  sharedHomeState,
} from './home.mjs'

const runFile = promisify(execFile)

export { PLUGIN_ROOT }

const BINARY_NAME = binaryName('ffmpeg')
const PROBE_NAME = binaryName('ffprobe')

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
 * then the shared plugin home, then a sibling plugin's vendored build, then PATH.
 *
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {string|null} explicit - a configured path.
 * @returns {{path: string, source: 'config'|'env'|'vendor'|'home'|'sibling'|'path'}|null} where it was found.
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

  const shared = join(SHARED_FFMPEG_BIN, name)
  if (existsSync(shared)) return { path: shared, source: 'home' }

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
 * The **shared plugin home** is the install target now that the runtime is shared with matting
 * and the model is shared with `video-factory`; the plugin's own `vendor/audio` and a sibling
 * copy follow, because they are where a machine that installed the runtime before the shared home
 * put it, and re-downloading 28 MB to move a directory would be absurd.
 *
 * @returns {string[]} candidate asset directories, nearest first.
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
 * @returns {{dir: string, source: 'config'|'env'|'home'|'vendor'|'sibling'}[]} candidates, nearest first.
 */
export function audioDirCandidatesWithSource() {
  const candidates = []
  if (configuredAudioDir !== null) candidates.push({ dir: configuredAudioDir, source: 'config' })
  if (typeof process.env[AUDIO_DIR_ENV] === 'string' && process.env[AUDIO_DIR_ENV].trim() !== '') {
    candidates.push({ dir: resolve(process.env[AUDIO_DIR_ENV]), source: 'env' })
  }
  candidates.push({ dir: SHARED_YAMNET_DIR, source: 'home' })
  candidates.push({ dir: join(PLUGIN_ROOT, 'vendor', 'audio'), source: 'vendor' })
  for (const directory of siblingPaths('vendor/audio')) candidates.push({ dir: directory, source: 'sibling' })
  return candidates
}

/**
 * The `onnxruntime-web` package directory inside a runtime install root.
 *
 * The shared home keeps npm's own shape — `lib/onnxruntime-web/node_modules/onnxruntime-web`,
 * beside its four dependencies — because the WASM entry point imports `flatbuffers`, `long` and
 * `protobufjs` by bare specifier, and Node resolves those by walking up from the importing file.
 * Put the package anywhere else and the import fails at load time.
 */
export const SHARED_ORT_PACKAGE = join(SHARED_RUNTIME_DIR, 'node_modules', 'onnxruntime-web')

/**
 * Every directory the shared audio assets are actually read from, in one answer.
 *
 * The model and the runtime are two separate downloads that happen to have been installed
 * together, and a machine can legitimately have one and not the other. Each therefore resolves on
 * its own, and each answer names the rule that produced it:
 *
 *   - the **model** comes from `~/.dsh-plugins/models/yamnet` when it is there, otherwise from a
 *     legacy `vendor/audio` tree, otherwise from the shared home (where an install will put it);
 *   - the **runtime** comes from `~/.dsh-plugins/lib/onnxruntime-web` when it is there, otherwise
 *     from the `runtime/node_modules/onnxruntime-web` inside a legacy tree.
 *
 * @returns {object} the resolved asset set, every path absolute.
 */
export function resolveAudioAssets() {
  const runtimeEntry = join(SHARED_ORT_PACKAGE, 'dist', 'ort.wasm.mjs')
  const runtimeBinary = join(SHARED_ORT_PACKAGE, 'dist', 'ort-wasm-simd-threaded.wasm')
  const runtimeLoader = join(SHARED_ORT_PACKAGE, 'dist', 'ort-wasm-simd-threaded.mjs')
  const shared = {
    dir: SHARED_YAMNET_DIR,
    source: 'home',
    manifest: join(SHARED_YAMNET_DIR, 'SOURCE.json'),
    model: join(SHARED_YAMNET_DIR, 'yamnet.onnx'),
    classMap: join(SHARED_YAMNET_DIR, 'yamnet_class_map.csv'),
    modelDir: SHARED_YAMNET_DIR,
    modelSource: 'home',
    runtimeDir: SHARED_RUNTIME_DIR,
    runtimePackageDir: SHARED_ORT_PACKAGE,
    runtimeSource: 'home',
    runtimeEntry,
    runtimeBinary,
    runtimeLoader,
  }

  // A configured or environment directory names a whole legacy tree, model and runtime together,
  // and wins outright: it is the operator saying where to look, which is not a guess to improve on.
  const explicit = audioDirCandidatesWithSource().find(
    (candidate) => candidate.source === 'config' || candidate.source === 'env',
  )
  const legacyRoots = [
    ...(explicit === undefined ? [] : [explicit.dir]),
    join(PLUGIN_ROOT, 'vendor', 'audio'),
    ...siblingPaths('vendor/audio'),
  ]

  for (const root of legacyRoots) {
    const model = join(root, 'yamnet', 'yamnet.onnx')
    const entry = join(root, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.mjs')
    const modelThere = existsSync(model)
    const runtimeThere = existsSync(entry)
    if (!modelThere && !runtimeThere) continue
    const source = root === explicit?.dir ? explicit.source : root === join(PLUGIN_ROOT, 'vendor', 'audio') ? 'vendor' : 'sibling'
    return {
      ...shared,
      dir: root,
      source,
      manifest: join(root, 'SOURCE.json'),
      manifestSource: source,
      modelDir: modelThere ? root : shared.modelDir,
      modelSource: modelThere ? source : 'home',
      runtimeDir: runtimeThere ? root : shared.runtimeDir,
      runtimePackageDir: runtimeThere ? join(root, 'runtime', 'node_modules', 'onnxruntime-web') : shared.runtimePackageDir,
      runtimeSource: runtimeThere ? source : 'home',
      model: modelThere ? model : shared.model,
      classMap: modelThere ? join(root, 'yamnet', 'yamnet_class_map.csv') : shared.classMap,
      runtimeEntry: runtimeThere ? entry : shared.runtimeEntry,
      runtimeBinary: runtimeThere
        ? join(root, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm')
        : shared.runtimeBinary,
      runtimeLoader: runtimeThere
        ? join(root, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs')
        : shared.runtimeLoader,
    }
  }

  return shared
}

/**
 * The directory the legacy shared assets are read from, kept for the reports that name one path.
 *
 * @returns {{dir: string, source: 'config'|'env'|'home'|'vendor'|'sibling'}} the first candidate that
 *   exists, falling back to the shared home's model directory when none does.
 */
export function resolveAudioDir() {
  const assets = resolveAudioAssets()
  return { dir: assets.modelDir, source: assets.modelSource }
}

/**
 * The shared home, as a report.
 * @returns {object} where the root came from, and the two asset directories inside it.
 */
export function sharedAssetsState() {
  return {
    ...sharedHomeState(),
    modelDir: SHARED_YAMNET_DIR,
    runtimeDir: SHARED_RUNTIME_DIR,
    ffmpegDir: SHARED_FFMPEG_DIR,
  }
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
