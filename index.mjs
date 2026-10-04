/**
 * The `dsh-video-audio` Host plugin: deterministic audio tools for DSH.
 *
 * The plugin is a plain ESM module with no harness import, so a profile can install it without a
 * build step and without a dependency edge on the harness packages it composes with. It validates
 * its own config, because validating through the Loader would require the dependency this module
 * exists to avoid.
 *
 * Division of labour, which the rest of the code depends on:
 *   DSH decides what the sound should be — which take is usable, where a cut belongs, how much
 *   noise reduction is acceptable, whether a mix is done.
 *   This plugin only executes: same input, same output, except for `record`, where the room is
 *   the input.
 *
 * @module dsh-video-audio
 */
import { registerTools } from './src/tools/index.mjs'
import { disposeAudioSession } from './src/core/audio-events.mjs'
import { setConfiguredAudioDir } from './src/core/env.mjs'

/** Stable Cordis plugin name. */
export const name = 'dsh-video-audio'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** Read an optional string field, allowing null to mean "use the default". */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`dsh-video-audio: ${where} must be a string or null`)
  return value
}

/** Read an optional positive number field. */
function optionalPositiveNumber(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-video-audio: ${where} must be a positive number`)
  }
  return value
}

/**
 * Validate and normalize the row's config.
 *
 * Misconfiguration fails loud here, at activation, rather than surfacing later as a confusing tool
 * error. Nothing here is required: with an empty config and ffmpeg somewhere on the machine — even
 * in a sibling `video-factory` checkout — every measurement action works.
 *
 * @param {object} [raw] - the row's `config`.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type.
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const audio = config.audio ?? {}

  return {
    projectRoot: optionalString(config, 'projectRoot', null, 'config.projectRoot'),
    ffmpegPath: optionalString(config, 'ffmpegPath', null, 'config.ffmpegPath'),
    ffprobePath: optionalString(config, 'ffprobePath', null, 'config.ffprobePath'),
    pathBudget: optionalPositiveNumber(config, 'pathBudget', 200, 'config.pathBudget'),
    audio: {
      // Where the shared YAMNet model and ONNX runtime are read from. null = discover:
      // this plugin's own vendor/audio, then a sibling video-factory checkout.
      vendorDir: optionalString(audio, 'vendorDir', null, 'config.audio.vendorDir'),
    },
  }
}

/**
 * Mount the tools.
 *
 * Registration is wrapped so a failure to reach the `tools` service is logged clearly instead of
 * looking like a silent no-op: a plugin that loads but exposes nothing is the hardest kind of
 * failure to notice.
 *
 * @param {object} ctx - plugin context.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`dsh-video-audio: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  ctx.inject(['tools'], (toolsCtx) => {
    // The configured store is applied before anything can read it, and it is applied through the
    // same function the CLI path uses, so there is one precedence rule and one report of which
    // directory answered.
    setConfiguredAudioDir(config.audio.vendorDir)
    const outcome = registerTools(toolsCtx, config, ctx.logger)
    if (outcome.registered.length === 0) {
      ctx.logger.error('dsh-video-audio: 没有注册任何工具，插件实际上不可用')
    }
  })

  // A loaded YAMNet session holds a WASM heap; it must not outlive the plugin that started it.
  // `on` is optional because a minimal composition need not expose it.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      disposeAudioSession()
    })
  }
}
