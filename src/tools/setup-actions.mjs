/**
 * `audio_setup` actions: install, remove and report the shared audio assets.
 *
 * Two files make audio event detection possible, and both are read from a directory that is
 * resolved at call time rather than assumed: this plugin's own `vendor/audio`, or — when a
 * machine already ran the installer back when the runtime lived in the sibling muxing plugin —
 * a `video-factory` checkout's copy. That is what `vendorSource: 'sibling'` means in a result:
 * **the files are being read out of a video-factory checkout**, nothing was written there, and
 * `audio_setup {action:"remove"}` will not delete them, because reaching into another plugin's
 * directory is not this plugin's to do. Removing therefore only affects this plugin's own
 * `vendor/audio` tree, and `remove` says so again in `stillVisibleFrom`.
 *
 * Nothing here measures anything: this family changes what is on disk, and it is kept apart from
 * `audio_measure` so that "check the machine" and "download 28 MB" are never adjacent choices.
 *
 * @module dsh-video-audio/tools/setup-actions
 */
import { resolve } from 'node:path'
import { AudioPluginError } from './shared.mjs'
import {
  AUDIO_MODEL,
  AUDIO_RUNTIME_PACKAGES,
  audioInstallState,
  installAudio,
  removeAudio,
  verifyInstalledAudio,
} from '../core/audio-install.mjs'
import { audioEventState } from '../core/audio-events.mjs'

/**
 * Build the `audio_setup` action table.
 *
 * @param {object} config - normalized plugin config. Accepted for symmetry with the other action
 *   factories; where the assets live is core/env's decision (`audioDirCandidates`,
 *   `resolveAudioDir`), so nothing here re-derives it from the config.
 * @param {object} logger - the host plugin's logger.
 * @returns {{status: Function, install: Function, remove: Function}} action handlers.
 */
export function createSetupActions(config, logger) {
  const progress = (line) => logger.info(`dsh-video-audio: ${line}`)

  /**
   * Wrap a core error so the model sees an actionable message.
   *
   * Broader than the guard in `audio-actions.mjs`, and deliberately so: the installers throw
   * plain `Error`s whose text is already the actionable part ("sha256 不匹配，已中止…"), so the
   * prefix is added to every one instead of to a short list of core error classes.
   *
   * @param {string} action - the action that failed.
   * @param {unknown} error - the thrown value.
   * @returns {AudioPluginError} the error to throw.
   */
  const guard = (action, error) => {
    const message = error instanceof Error ? error.message : String(error)
    return new AudioPluginError(`audio_setup ${action}: ${message}`)
  }

  /** The model constants, flattened into the facts a caller needs to judge an install. */
  const modelFacts = () => {
    const files = AUDIO_MODEL.files.map((file) => ({
      name: file.name,
      url: file.url,
      bytes: file.bytes,
      sha256: file.sha256,
    }))
    return {
      id: AUDIO_MODEL.id,
      label: AUDIO_MODEL.label,
      license: AUDIO_MODEL.license,
      classes: AUDIO_MODEL.classes,
      input: AUDIO_MODEL.input,
      output: AUDIO_MODEL.output,
      provenance: AUDIO_MODEL.provenance,
      provenanceWarning: AUDIO_MODEL.provenanceWarning,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    }
  }

  /** The runtime constants: each tarball is pinned by the registry's own sha512 integrity. */
  const runtimeFacts = () => {
    const packages = AUDIO_RUNTIME_PACKAGES.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      url: pkg.url,
      integrity: pkg.integrity,
      unpackedBytes: pkg.unpackedSize,
    }))
    return {
      // The runtime has no id of its own in the constants; it is the package whose WASM backend
      // detection loads, and that is the first entry.
      id: AUDIO_RUNTIME_PACKAGES[0].name,
      packages,
      // The tarballs' unpacked sizes are what the registry claims, not what is kept: the kept
      // subset is far smaller, and `totalBytes` in the status result is the disk truth.
      totalUnpackedBytes: packages.reduce((sum, pkg) => sum + pkg.unpackedBytes, 0),
    }
  }

  return {
    /**
     * Report what is present, without downloading or deleting anything.
     * @returns {object} the on-disk state, the verification verdict and the pinned facts.
     */
    status() {
      return {
        action: 'status',
        ...audioInstallState(),
        // Re-read from disk rather than trusted from the manifest: a file that is present but
        // not the file that was recorded is exactly the case this reports.
        verify: verifyInstalledAudio(),
        installWith: 'audio_setup {action:"install"}',
        model: modelFacts(),
        runtime: runtimeFacts(),
      }
    },

    /**
     * Fetch the model and runtime, or adopt a verified sibling copy, then re-read the disk.
     * @param {object} args - the request; `archive` names a local model file to use instead.
     * @returns {Promise<object>} the install report, the state and the verification.
     */
    async install(args = {}) {
      try {
        const result = await installAudio({
          force: args.force === true,
          // Resolved against the process working directory, not against "cwd": the file is the
          // caller's own, brought in ahead of time, and is not part of the job's directory.
          modelArchive: typeof args.archive === 'string' && args.archive !== '' ? resolve(args.archive) : undefined,
          onProgress: (line) => logger.info(`dsh-video-audio: install: ${line}`),
        })
        return {
          action: 'install',
          ...result,
          // Re-read from disk: "installed" must mean the files are there, not that a call
          // returned without throwing.
          state: audioEventState(),
          verify: verifyInstalledAudio(),
        }
      } catch (error) {
        throw guard('install', error)
      }
    },

    /**
     * Delete this plugin's own vendored tree, and say what is still visible elsewhere.
     * @returns {object} the removal outcome and the state afterwards.
     */
    async remove() {
      try {
        const result = removeAudio({ onProgress: (line) => logger.info(`dsh-video-audio: remove: ${line}`) })
        return { action: 'remove', ...result, state: audioEventState() }
      } catch (error) {
        throw guard('remove', error)
      }
    },
  }
}
