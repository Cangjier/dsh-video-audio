/**
 * Registers every model-facing `audio_*` tool.
 *
 * The surface is deliberately small and grouped by what the caller is doing: each tool
 * dispatches on an `action`, because every schema enters the model context on every turn.
 * What the schemas carry is only what the choice needs — one tool MAKES and REPAIRS sound, one
 * MEASURES it, one changes what is on disk, one explains the rest — and `audio_guide` renders
 * the full reference (arguments, returns, cost, pitfalls, examples, rules) on demand from the
 * same registry the schemas are built from.
 *
 * The tool list itself comes from that registry, so a tool cannot be registered without
 * being documented, and cannot be documented without being registered. `defineFamilyTool`
 * checks the action lists both ways at construction, which turns a missing handler or an
 * undocumented action into a load-time failure rather than a silently thin schema.
 *
 * @module dsh-video-audio/tools
 */
import { createAudioBuildTool, createAudioMeasureTool, createGuideTool, createSetupTool } from './audio.mjs'
import { createAudioActions } from './audio-actions.mjs'
import { createGuideActions } from './guide.mjs'
import { createSetupActions } from './setup-actions.mjs'
import { TOOL_ORDER } from './registry.mjs'

/** Every tool name this plugin registers, in the order the surface presents them. */
export const TOOL_NAMES = [...TOOL_ORDER]

/**
 * Build every tool definition.
 *
 * Each family pairs a schema module (what the model sees) with an actions module (what
 * actually runs). Keeping them apart means the schema can be read and reviewed on its
 * own, and that the deterministic core is never reachable except through an action.
 *
 * `audio_guide` is built last and handed a thunk, because it is itself one of the tools it
 * documents: at construction time the list is incomplete, at call time it is not.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object[]} raw tool definitions.
 */
export function toolDefinitions(config, logger) {
  const audioActions = createAudioActions(config, logger)
  const setupActions = createSetupActions(config, logger)

  const definitions = [
    createAudioBuildTool(audioActions),
    createAudioMeasureTool(audioActions),
    createSetupTool(setupActions),
  ]
  definitions.push(createGuideTool(createGuideActions(() => definitions)))

  const rank = (definition) => {
    const index = TOOL_ORDER.indexOf(definition.name)
    return index < 0 ? TOOL_ORDER.length : index
  }
  return definitions.sort((left, right) => rank(left) - rank(right))
}

/**
 * Register every tool on a context that already carries the `tools` service.
 *
 * A failing registration must not take the whole plugin down: the others are still
 * useful, and the failure is reported to the log.
 *
 * @param {object} toolsCtx - the sub-context providing `tools`.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {{registered: string[], failed: {name: string, error: string}[]}} the outcome.
 */
export function registerTools(toolsCtx, config, logger) {
  const registered = []
  const failed = []
  for (const definition of toolDefinitions(config, logger)) {
    try {
      toolsCtx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ name: definition.name, error: message })
      logger.error(`dsh-video-audio: 注册工具 ${definition.name} 失败：${message}`)
    }
  }
  logger.info(`dsh-video-audio: 已注册 ${registered.length} 个工具：${registered.join(', ')}`)
  return { registered, failed }
}
