#!/usr/bin/env node
/**
 * Report the model-facing cost of this plugin's tool surface.
 *
 * Every tool schema enters the model context on every turn, so the surface is a budget and this is
 * the meter: how many bytes each `audio_*` tool costs, how long the single longest line of its
 * `action` enum is, how much of its prose is written twice, and how much detail lives in the
 * on-demand `audio_guide` instead.
 *
 * The numbers are asserted in `tests/surface.test.mjs`; this script is the human-readable view of
 * them, for comparing a change before and after. It imports the same two sources the schemas are
 * built from — `src/tools/index.mjs` for the definitions and `src/tools/registry.mjs` for the
 * prose — so it cannot report a surface the plugin does not have.
 *
 * Usage: node src/bin/surface-report.mjs [--json]
 *
 * @module dsh-video-audio/bin/surface-report
 */
import { toolDefinitions } from '../tools/index.mjs'
import { REGISTRY, TOOL_ORDER } from '../tools/registry.mjs'

/** A line longer than this is charged to every turn and is a candidate for the guide instead. */
const LINE_BUDGET = 300

/**
 * The whole surface's byte budget.
 *
 * Chosen from the measured surface, not the other way round: it is the current cost rounded up to
 * the next half kilobyte. The rule exists to catch a schema that grew by a paragraph, so it is set
 * where a genuine addition still fits and a page of prose does not.
 */
const TOTAL_BUDGET_BYTES = 18_000

const logger = { info() {}, warn() {}, error() {}, debug() {} }

/** Byte length of the part of a definition the model actually receives. */
function schemaBytes(definition) {
  return Buffer.byteLength(
    JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }),
    'utf8',
  )
}

/** Split prose into sentences, so duplication can be measured below the whole-line level. */
function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

/**
 * Measure one tool definition.
 * @param {object} definition - the tool definition as the model receives it.
 * @returns {object} the row this report prints.
 */
function measure(definition) {
  const actionLine = definition.parameters.properties.action.description
  const lines = actionLine.split('\n')
  const longestLine = Math.max(...lines.map((line) => line.length))
  const overBudget = lines.filter((line) => line.length > LINE_BUDGET).length

  // Duplicated prose, measured the way video-factory's budget report measures it: first whether the
  // enum description is repeated verbatim inside the tool description, then which of the tool
  // description's own sentences also appear in the enum description.
  const wholeLineDuplicated = definition.description.includes(actionLine)
  const repeatedSentences = sentences(definition.description).filter((sentence) => actionLine.includes(sentence))

  return {
    name: definition.name,
    actions: definition.parameters.properties.action.enum.length,
    arguments: Object.keys(definition.parameters.properties).length - 1,
    descriptionChars: definition.description.length,
    actionChars: actionLine.length,
    actionLines: lines.length,
    longestActionLine: longestLine,
    overBudgetActionLines: overBudget,
    wholeLineDuplicated,
    duplicatedChars: wholeLineDuplicated ? actionLine.length : 0,
    repeatedSentences: repeatedSentences.length,
    repeatedChars: repeatedSentences.reduce((sum, sentence) => sum + sentence.length, 0),
    bytes: schemaBytes(definition),
  }
}

const definitions = toolDefinitions({}, logger)
const rows = definitions.map(measure)
const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)

const rules = [
  {
    id: `action-line≤${LINE_BUDGET}`,
    detail: 'every line of every action enum',
    pass: rows.every((row) => row.overBudgetActionLines === 0),
  },
  {
    id: `total≤${TOTAL_BUDGET_BYTES}B`,
    detail: `${total('bytes')} bytes resident across ${rows.length} tools`,
    pass: total('bytes') <= TOTAL_BUDGET_BYTES,
  },
  {
    id: 'no-duplicated-prose',
    detail: `${total('duplicatedChars')} chars repeated verbatim, ${total('repeatedChars')} chars of shared sentences`,
    pass: total('duplicatedChars') + total('repeatedChars') === 0,
  },
  {
    id: 'registry-covers-tools',
    detail: `registry has ${Object.keys(REGISTRY).length} tools, definitions ${definitions.length}`,
    pass:
      rows.length === Object.keys(REGISTRY).length &&
      rows.every((row) => REGISTRY[row.name] !== undefined) &&
      TOOL_ORDER.every((name) => rows.some((row) => row.name === name)),
  },
]

const totals = {
  tools: rows.length,
  actions: total('actions'),
  bytes: total('bytes'),
  duplicatedChars: total('duplicatedChars'),
  repeatedChars: total('repeatedChars'),
  longestActionLine: Math.max(...rows.map((row) => row.longestActionLine)),
  budgetBytes: TOTAL_BUDGET_BYTES,
  lineBudget: LINE_BUDGET,
  ok: rules.every((rule) => rule.pass),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tools: rows, totals, rules }, null, 2))
} else {
  const pad = (value, width) => String(value).padStart(width)
  console.log(
    'tool'.padEnd(16) +
      pad('act', 4) +
      pad('args', 5) +
      pad('desc', 6) +
      pad('action', 7) +
      pad('lines', 6) +
      pad('longest', 8) +
      pad('dup', 6) +
      pad('bytes', 7),
  )
  for (const row of rows) {
    console.log(
      row.name.padEnd(16) +
        pad(row.actions, 4) +
        pad(row.arguments, 5) +
        pad(row.descriptionChars, 6) +
        pad(row.actionChars, 7) +
        pad(row.actionLines, 6) +
        pad(row.longestActionLine, 8) +
        pad(row.duplicatedChars + row.repeatedChars, 6) +
        pad(row.bytes, 7),
    )
  }
  console.log(
    `\n${totals.tools} tools, ${totals.actions} actions, resident ${totals.bytes} bytes, ` +
      `longest action line ${totals.longestActionLine} chars`,
  )
  console.log(
    `guide content: ${Object.keys(REGISTRY).length} tools in the registry, rendered on demand and never resident`,
  )
  console.log('')
  for (const rule of rules) {
    console.log(`${rule.pass ? 'PASS' : 'FAIL'}  ${rule.id}  — ${rule.detail}`)
  }
  console.log(`\n${totals.ok ? 'OK' : 'FAILED'}: ${rules.filter((rule) => rule.pass).length}/${rules.length} rules pass`)
}

process.exitCode = totals.ok ? 0 : 1
