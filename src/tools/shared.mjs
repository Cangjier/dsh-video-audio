/**
 * Shared helpers for building the model-facing `audio_*` tool definitions.
 *
 * Three rules shape everything here, and they were learned by paying for them:
 *
 * 1. **The JSON Schema of every tool enters the model context on every turn.** So the surface is
 *    grouped into a few tools with an `action` dispatcher rather than spread across a dozen flat
 *    ones, and no sentence is written twice inside one schema.
 *
 * 2. **The prose lives in exactly one place.** `registry.mjs` holds what each action does, when to
 *    use it, what it requires and what it costs; this module derives the tool description and the
 *    `action` enum description from it, so the two can never disagree and the model is never
 *    charged twice for the same sentence. The long tail — return shapes, pitfalls, measured costs,
 *    examples — is one `audio_guide` call away instead of being resident.
 *
 * 3. **A tool is a deterministic operation, never a judgement.** Nothing here decides whether a
 *    take is usable, how much noise reduction is acceptable, or which clip belongs where. Those
 *    are the caller's calls, and the results are numbers precisely so they can be made.
 *
 * @module dsh-video-audio/tools/shared
 */
import { lookupTool } from './registry.mjs'

/** Render any tool result as one pretty-printed JSON text block. */
export const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
  },
}

/** Shared `cwd` property: every path-taking tool resolves against it. */
export const CWD_PROPERTY = {
  type: 'string',
  description:
    'Working directory that relative paths resolve against. Defaults to the plugin project root, then the process working directory.',
}

/**
 * Error type for a request this plugin refuses, with a message meant for the model.
 * Thrown errors surface as tool failures, so they must be actionable.
 */
export class AudioPluginError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioPluginError'
  }
}

/** Where the full reference for a tool can be read. Kept short: it is repeated per tool. */
function guideHint(name) {
  return `Full detail: audio_guide {action:"tool", tool:"${name}"}.`
}

/**
 * One decision-grade line for an action, used as the enum description the model reads when
 * choosing.
 *
 * The line is built by priority and bounded, because it is resident on every turn: what the action
 * produces, then the arguments it requires (the thing a first call gets wrong), then the mistake it
 * prevents when that is short enough to be worth the space, then when to reach for it. Everything
 * that does not fit is one `audio_guide {action:"action"}` call away.
 *
 * @param {string} action - the action name.
 * @param {object} entry - its registry entry.
 * @returns {string} one line of prose.
 */
export function describeAction(action, entry) {
  const BUDGET = 215
  let line = `${action} — ${entry.summary}`
  if (Array.isArray(entry.required) && entry.required.length > 0) line += ` Requires: ${entry.required.join(', ')}.`

  const optional = [
    entry.avoid && entry.avoid.length <= 100 ? ` Avoid: ${entry.avoid}` : null,
    entry.use ? ` Use: ${entry.use}` : null,
  ]
  for (const clause of optional) {
    if (clause !== null && line.length + clause.length <= BUDGET) line += clause
  }
  return line
}

/**
 * Build a tool's description from its registry entry.
 *
 * @param {string} name - tool name.
 * @param {object} entry - its registry entry.
 * @param {string[]} actions - the declared action list, in dispatch order.
 * @returns {string} the model-facing description.
 */
export function describeTool(name, entry, actions) {
  return [
    entry.purpose,
    `Actions: ${actions.join(', ')}.`,
    `Needs: ${entry.needs.join(' ')}`,
    `Next: ${entry.next.join(' ')}`,
    guideHint(name),
  ].join('\n')
}

/**
 * Build one family tool.
 *
 * The definition is derived from `registry.mjs` rather than described beside it, and the registry
 * is checked against the declarations here: a tool or action that exists in one and not the other
 * is a bug that would otherwise surface as a silently under-documented schema, so it fails loudly
 * at load time instead.
 *
 * @param {object} spec - family definition.
 * @param {string} spec.name - tool name, for example `audio_measure`.
 * @param {string[]} spec.actions - every legal `action` value, in dispatch order.
 * @param {object} spec.extraProperties - additional JSON Schema properties.
 * @param {Record<string, (args: object, context: object) => Promise<object>>} spec.handlers -
 *   one implementation per action.
 * @returns {object} a raw tool definition suitable for `ctx.tools.register`.
 */
export function defineFamilyTool(spec) {
  const actions = [...spec.actions]
  const entry = lookupTool(spec.name)
  if (entry === undefined) {
    throw new Error(`dsh-video-audio: no registry entry for tool ${spec.name}; add it to src/tools/registry.mjs`)
  }

  const documented = Object.keys(entry.actions)
  for (const action of actions) {
    if (entry.actions[action] === undefined) {
      throw new Error(`dsh-video-audio: ${spec.name}.${action} is not documented in src/tools/registry.mjs`)
    }
    if (typeof spec.handlers[action] !== 'function') {
      throw new Error(`dsh-video-audio: ${spec.name}.${action} is declared but has no handler`)
    }
  }
  for (const action of documented) {
    if (!actions.includes(action)) {
      throw new Error(`dsh-video-audio: ${spec.name}.${action} is documented in the registry but not declared here`)
    }
  }

  const actionsHelp = actions.map((action) => describeAction(action, entry.actions[action])).join('\n')

  return {
    name: spec.name,
    description: describeTool(spec.name, entry, actions),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: actionsHelp,
        },
        ...spec.extraProperties,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, context) {
      // Dispatch goes through the declared list, not through the handler table: a handler that
      // belongs to a sibling tool must be unreachable from this one, or a split surface would be
      // cosmetic.
      const handler = actions.includes(args?.action) ? spec.handlers[args.action] : undefined
      if (handler === undefined) {
        throw new AudioPluginError(
          `${spec.name}: unknown action ${JSON.stringify(args?.action)}; expected one of ${actions.join(', ')}`,
        )
      }
      // The host does not guarantee a second argument, so a missing or partial context is
      // normalized once here rather than defended against in every action.
      const safeContext = {
        cwd: typeof context?.cwd === 'string' && context.cwd !== '' ? context.cwd : process.cwd(),
        ...context,
      }
      return handler(args ?? {}, safeContext)
    },
  }
}
