/**
 * The shared plugin home: one directory for the static dependencies every plugin in this family
 * borrows.
 *
 * Six plugins used to keep six `vendor/` directories, and the same 200 MB ffmpeg build was reachable
 * from all of them by a chain of `../<sibling>/vendor/...` guesses. That worked only while the
 * checkouts sat side by side; a machine that installed one plugin on its own, or moved a checkout,
 * lost a binary that was already on the disk. The layout below replaces the guess with one named
 * place:
 *
 * ```
 * ~/.dsh-plugins/
 *   ffmpeg/bin/            ffmpeg.exe, ffprobe.exe, ffplay.exe (dsh-ffmpeg owns the install)
 *   ocr/<source>/          the offline OCR engine, with its 7zr.exe under tools/ (dsh-ocr)
 *   models/yamnet/         YAMNet ONNX + class map (dsh-video-audio)
 *   models/u2netp/         the matting model (video-factory)
 *   lib/onnxruntime-web/   the ONNX WASM runtime, shared by matting and audio events
 * ```
 *
 * **Resolution is not an env var.** The root is derived from **the home directory** — one per user,
 * so two users on one machine cannot see or overwrite each other's 200 MB, and a machine that moves
 * keeps working. `DSH_PLUGIN_HOME` overrides it for the machine whose home directory is not where
 * the assets should go.
 *
 * Each plugin reads this directory and falls back to the layouts that existed before it (its own
 * `vendor/`, then a sibling checkout's), so a machine that installed a build earlier keeps working
 * without re-downloading. Nothing here writes anything; the installers own that, and every state
 * report names which rule answered.
 *
 * This module is deliberately self-contained and duplicated verbatim in each plugin: the six are
 * independent packages, and a plugin installed on its own must not need a checkout of the others to
 * find its own binaries.
 *
 * @module dsh-video-audio/core/home
 */
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** This plugin's package root, resolved from this module so a `link:` install still works. */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The directory name every plugin in this family shares. */
export const HOME_DIR_NAME = '.dsh-plugins'

/** Environment variable that overrides where the shared root is, for one machine. */
export const HOME_ENV = 'DSH_PLUGIN_HOME'

/** The absolute path of the shared root. The single place the layout is named. */
export const SHARED_ROOT = resolve(
  process.env[HOME_ENV]?.trim() ? process.env[HOME_ENV].trim() : join(homedir(), HOME_DIR_NAME),
)

/**
 * A path below the shared root.
 * @param {...string} parts - path segments below the root.
 * @returns {string} the absolute path.
 */
export function sharedPath(...parts) {
  return join(SHARED_ROOT, ...parts)
}

/** The shared ffmpeg directory: holds `bin/` and a `SOURCE.json`. */
export const SHARED_FFMPEG_DIR = sharedPath('ffmpeg')

/** The shared ffmpeg binary directory: what discovery runs, and what an install writes. */
export const SHARED_FFMPEG_BIN = sharedPath('ffmpeg', 'bin')

/** The shared OCR engine directory. */
export const SHARED_OCR_DIR = sharedPath('ocr')

/** The shared models directory. */
export const SHARED_MODELS_DIR = sharedPath('models')

/** The shared YAMNet directory. */
export const SHARED_YAMNET_DIR = sharedPath('models', 'yamnet')

/** The shared matting model directory. */
export const SHARED_MATTE_DIR = sharedPath('models', 'u2netp')

/** The shared library directory. The ONNX WASM runtime lives here. */
export const SHARED_LIB_DIR = sharedPath('lib')

/** The shared ONNX WASM runtime directory. */
export const SHARED_RUNTIME_DIR = sharedPath('lib', 'onnxruntime-web')

/**
 * The executable name for one ffmpeg-family tool on this platform.
 *
 * Only Windows carries this family today — every ffmpeg installer here downloads a `win64` build —
 * so on any other platform the name is one nothing will match, which is what a non-Windows host
 * should conclude from a directory of `.exe` files.
 *
 * @param {'ffmpeg'|'ffprobe'|'ffplay'} stem - which binary.
 * @returns {string} the file name.
 */
export function binaryName(stem) {
  return process.platform === 'win32' ? `${stem}.exe` : stem
}

/**
 * Where the shared root came from, for a report that has to be checkable.
 *
 * @returns {{sharedRoot: string, source: 'env'|'home', envVar: string, homeDir: string}} the root and the rule that produced it.
 */
export function sharedHomeState() {
  const fromEnv = typeof process.env[HOME_ENV] === 'string' && process.env[HOME_ENV].trim() !== ''
  return {
    sharedRoot: SHARED_ROOT,
    source: fromEnv ? 'env' : 'home',
    envVar: HOME_ENV,
    homeDir: homedir(),
  }
}

/** How many directory levels above this plugin a sibling checkout can be found. */
export const SIBLING_OFFSETS = [['..'], ['..', '..']]
