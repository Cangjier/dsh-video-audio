/**
 * `audio_guide` — the on-demand reference for everything this plugin can do.
 *
 * Why a tool rather than more prose in each schema: every sentence in a tool schema is paid
 * for on every turn, so the resident surface can only carry what the choice itself needs.
 * The long tail — every argument with its meaning and default, return shapes, cost, the
 * pitfalls that keep repeating, runnable examples, the rules that decide what a measurement
 * is worth — is worth much more when it is read once, on purpose, than when it is resident
 * and skimmed.
 *
 * Everything here is rendered from `registry.mjs` (the same source the schemas are built from)
 * and from the core constants themselves, so the reference cannot describe an action that no
 * longer exists, and a default quoted here cannot drift from the default the code applies.
 * The live parameter schemas are used too when the caller wires them in, which is what lets
 * `tool` print which argument belongs to which action.
 *
 * @module dsh-video-audio/tools/guide
 */
import { AudioPluginError, CWD_PROPERTY, defineFamilyTool } from './shared.mjs'
import { REGISTRY, TOOL_ORDER, lookupAction, lookupTool } from './registry.mjs'
import { ANALYSIS_SAMPLE_RATE, MEASURE_DEFAULTS, SPECTRUM_SAMPLE_RATE } from '../core/audio-measure.mjs'
import { DEFAULT_NOISE_SEED, DEFAULT_TONE_LEVEL_DBFS } from '../core/audio-build.mjs'
import { RECORD_DEADLINE_SLACK_SECONDS, RECORD_DEFAULTS } from '../core/audio-record.mjs'
import {
  DEFAULT_MIN_SCORE,
  DEFAULT_SILENCE_RMS,
  DEFAULT_TOP_K,
  MAX_AUDIO_SECONDS,
} from '../core/audio-events.mjs'

export const GUIDE_TOOL_NAME = 'audio_guide'

/** Every action this family exposes, in dispatch order. */
export const GUIDE_ACTIONS = ['overview', 'tool', 'action', 'rules']

/** The reference takes one argument naming a tool, and one naming an action. */
const GUIDE_PROPERTIES = {
  tool: {
    type: 'string',
    enum: TOOL_ORDER,
    description:
      'tool / action: which tool to describe. For "action" this is the family the action belongs to; it may be omitted when the action name exists in only one tool.',
  },
  actionName: {
    type: 'string',
    description:
      'action: the action to describe in full, for example "assemble" or "noise". It goes here, not in "action" — "action" selects this reference action.',
  },
  cwd: CWD_PROPERTY,
}

/**
 * The rules that decide what a measurement is worth.
 *
 * These are consequences of the implementation, not taste: each one exists because the code
 * makes it true, and each one is written as a rule with the reason that makes it one.
 *
 * @returns {{id: string, rule: string, why: string}[]} the rules.
 */
function rules() {
  return [
    {
      id: 'determinism',
      rule: '除 audio_build {action:"record"} 外，每个 action 都是确定性的：同一组参数产生同一批字节。',
      why:
        '它们只是 ffmpeg 的纯函数式调用；record 的输入是房间，所以它把这次的时长误差、峰值、噪声底和工频能量一起报出来，' +
        '而不是声称自己可复现。噪声信号只有在给出 seed（默认 1）时才可复现，换 seed 就换字节。',
    },
    {
      id: 'measurements-do-not-write',
      rule: 'audio_measure 的每个 action 都不改写被测量的文件；唯一落盘的是 integrity 的修复副本。',
      why:
        '读与写分开，测量结果才能先看后决定。repair:true 写到 repairPath（省略时写在源文件旁边），' +
        '原文件一个字节都不改；宽损坏会被拒绝而不是猜着修。',
    },
    {
      id: 'thresholds-are-arguments',
      rule: '所有阈值都是参数，并且原样回显在结果里。',
      why:
        '静音门限、削波门限、最短静音、噪声窗口、声学模型的分数下限都不是内置判断：换一个参数就是另一次测量。' +
        '回显让一个意外的数字能追到产生它的那个参数，而不是看起来像一个关于文件的事实。',
    },
    {
      id: 'artifacts-are-re-decoded',
      rule: '写出的文件都会被重新解码核对，而不是假定写成功。',
      why:
        'tone / assemble / restore / record 都报名义时长、解码采样数与期望采样数之差；' +
        'assemble 的 verification.exact 只有在解码采样数与计划完全一致时才为 true。',
    },
    {
      id: 'no-verdicts',
      rule: '结果里没有"好 / 太响 / 够干净"这类判断：插件执行，DSH 决定。',
      why:
        '报告只给能据以判断的数字与清单（outliersBeyond、damagedFiles、gapHistogram），' +
        '判断本身留在调用方。这也是同一批数字既能用于交付、也能用于否掉一条素材的原因。',
    },
    {
      id: 'loudness-comparison-needs-paths',
      rule: '要比较多个文件的响度，用 loudness 的 paths 一次传进来。',
      why:
        'spreadLu、medianIntegratedLufs 和 outliersBeyond 只有在同一次调用里拿到多个文件时才存在；' +
        '分成多次单文件调用，就没有同一批的中位数可比，也看不到 5–7 LU 那样的段间落差。',
    },
    {
      id: 'integrity-is-mpeg-specific',
      rule: 'integrity 的逐帧检查只对 MPEG 家族（MP3、AAC 帧链）有意义。',
      why:
        'frameWalk.applies 为 false 时（FLAC、PCM、Opus 等）帧链不适用，逐帧结论不成立；' +
        '那类文件只能看 decodedVsDeclaredPercent 与 decodeErrors。',
    },
    {
      id: 'sync-needs-common-material',
      rule: 'sync 需要大约 10 秒以上的共同素材，并且相关性高于约 0.3 才可用。',
      why:
        '默认 maxLagSeconds=5 意味着要在 ±5 秒里搜，所以实际需要约 10 秒共同内容，尽管代码守卫只要求 2 秒；' +
        '素材更短会以"太短或没有可对齐的共同结构"失败。相关性低说明两段不是同一份素材的不同副本，这个偏移不该照用。',
    },
    {
      id: 'noise-and-identify-spectra-are-not-comparable',
      rule: 'noise 的频谱取自最安静窗口、固定在 48 kHz 上；identify 的频谱取自前 60 秒、采样率是 min(48000, 2×源采样率)。两者不可比。',
      why:
        '窗口不同、分析采样率不同，带宽与 tilt 会系统性地给出不同的数字。' +
        '要比两份文件，就用同一个 action 各测一次，而不是拿 noise 的数字去比 identify 的。',
    },
    {
      id: 'levels-caps-at-max-seconds',
      rule: 'levels 默认只分析前 600 秒。',
      why:
        '上限是为了界定一次解码的内存与耗时。超长文件里第十一分钟之后的削波不会被看到，' +
        'truncatedAtMaxSeconds 会说明发生了截断；要覆盖全部内容就分段测。',
    },
    {
      id: 'event-window-smearing',
      rule: 'audio_events 只给 RMS ≥ silenceRms 的窗口贴标签，窗口是 0.96 s、跳步 0.48 s。',
      why:
        '比窗口更短的事件会被摊到相邻两个 segment 上，所以一次标签出现不等于一个精确边界；' +
        '比 silenceRms 更轻的窗口报 silent 且不给任何标签——安静段落"没有标签"是正确答案，不是模型失败。',
    },
  ]
}

/**
 * The environment traps: each one produces a plausible wrong number rather than an error.
 * @returns {{id: string, trap: string, consequence: string}[]} the traps.
 */
function traps() {
  return [
    {
      id: 'sine-source-level',
      trap: 'ffmpeg 的 sine 源比满刻度低约 18 dB。',
      consequence:
        '用它去"设置 -6 dBFS"会静默地得到约 -24 dBFS。本插件的 tone 对正弦与扫频改用 aevalsrc，' +
        '所以 levelDbfs 才是可信的；自己写 ffmpeg 命令复现时不要用 sine 源。',
    },
    {
      id: 'ffprobe-wav-misdetect',
      trap: 'ffprobe 会把某些 WAV 误判成 MPEG-TS：48 kHz 单声道、内容恰好长得像 TS 同步字节的 WAV，探测会报 End of file 退出。',
      consequence:
        '处理方式是探测失败后按文件头（RIFF/WAVE、ID3、0xFFEx、ftyp、fLaC …）显式指定 -f 重试，' +
        '结果里带 answeredBy:"ffmpeg" 或 forcedFormat，不隐藏这件事。看到这些字段就说明这次不是 ffprobe 答的。',
    },
    {
      id: 'astats-log-level',
      trap: 'astats 只在 -v info -nostats 下打印，-v error 下什么都不输出。',
      consequence:
        '统计读取全部走 -v info -nostats，所以本插件的数字是有的；' +
        '但自己用 -v error 复算会得到"没有统计"，很容易被读成"静音"或"0"。',
    },
    {
      id: 'edge-tts-tail-silence',
      trap: 'edge-tts 每段音频的尾部都带约 0.8 s 静音（上游用固定的 8,750,000 ticks ≈ 0.875 s 补偿它）。',
      consequence:
        'assemble 不用 until 切掉的话，每段之间就多出这 0.8 s，整条音轨比场景长度长，最后一句会拖过画面。' +
        '这是服务端行为，不是文件坏了。',
    },
    {
      id: 'noise-echoed-window-default',
      trap: 'noise 回显的 defaults.windowSeconds 是 60，而真正的默认窗口是 30。',
      consequence:
        '这是少见的"回显本身是错的"的字段：MEASURE_DEFAULTS.windowSeconds 是 60，而 measureNoise 的默认值是 30。' +
        '以结果里的 windowSeconds（实测窗口）和你实际传入的参数为准。',
    },
    {
      id: 'assemble-sum-plus-concat',
      trap: 'assemble 同时给 overlap:"sum" 和显式 method:"concat"。',
      consequence:
        '片段会落到上一段的结尾而不是请求的 at，而 verification 仍可能报 exact:true——' +
        '"精确"说的是写出文件与计划一致，不是计划与你的意图一致。要重叠就用 method:"mix"，否则用 overlap:"reject"。',
    },
    {
      id: 'nested-overlap-unreported',
      trap: '重叠检测只比较排序后的相邻片段。',
      consequence:
        '一个片段完全嵌在另外两个片段之间时，重叠可能不被报出，overlap:"reject" 也拦不住它，' +
        '结果听起来像两段同时说话。放多个片段前先按 at 排序并检查区间关系。',
    },
  ]
}

/**
 * Where a neighbouring capability takes over. Named as facts, because each one is a real
 * boundary and not a preference.
 * @returns {{id: string, need: string, owner: string, fact: string}[]} the boundaries.
 */
function boundaries() {
  return [
    {
      id: 'transcription',
      need: '把语音转成文字',
      owner: 'video_narrate {action:"transcribe"}',
      fact: '本插件不做转录：speech_map 只按电平阈值标出有声与无声的区间，一个词也给不出。',
    },
    {
      id: 'loudness-normalisation',
      need: '响度归一化与成片混音',
      owner: 'video_render {action:"finalize"}',
      fact: '本插件只测量响度（EBU R128）并按你给的链做滤波；restore 里没有增益或归一化步骤，那是成片混音的活。',
    },
    {
      id: 'film-assembly',
      need: '把音轨放进成片',
      owner: '独立的 video-factory 插件的 video_* 工具',
      fact: '本插件的产物是文件路径；把它摆进画面时间轴、混音并交付，由 video-factory 插件负责。',
    },
    {
      id: 'matting-runtime',
      need: '抠像所需的 ONNX 推理运行时',
      owner: 'video_setup {action:"install_matte"}，复用 audio_setup {action:"install"} 装好的运行时',
      fact:
        'video-factory 里的抠图模型没有自己的 WASM 运行时，它读本插件的 vendor/audio/runtime；' +
        '所以 audio_setup {action:"remove"} 会把那台机器上的抠图一起弄坏。',
    },
  ]
}

/**
 * Real numbers measured on this machine or recorded in the source, each labelled with what it
 * is. Nothing here is a target or a recommendation: it is what was observed.
 * @returns {Record<string, {value: number|number[], what: string}>} the measurements.
 */
function measured() {
  return {
    tonePeakErrorDb: { value: 0.05, what: '-6 dBFS 正弦的实测峰值误差上限（tests/audio-actions.test.mjs 断言 < 0.05 dB）' },
    sineSourceOffsetDb: { value: 18, what: '本机 ffmpeg 的 sine 源比满刻度低约 18 dB，所以 tone 改用 aevalsrc（docs/声音工具.md）' },
    edgeTtsTailSeconds: { value: 0.875, what: 'edge-tts 每段尾部静音 ≈ 0.875 s（8,750,000 ticks），文档按 0.8 s 说' },
    mp3GapIntervalFrames: { value: 5, what: '读出声服务的分帧缺陷：每 5 个 MP3 帧插入一个 2 字节 0d0a 缺口' },
    mp3GapBytes: { value: 2, what: '缺口大小' },
    mp3LostPercent: { value: 20, what: '每个缺口报废一帧，约 20% 音频消失，且整段比时码短约 20%' },
    lowBitrateMp3BandwidthHz: { value: 11_000, what: '48 kbps 的 24 kHz MP3 有效带宽约在 11 kHz 截断' },
    loudnessSpreadTypicalLu: { value: [5, 7], what: '逐段合成的配音常见的段间响度落差' },
    levelsDefaultMaxSeconds: { value: 600, what: 'levels 默认只分析前 600 秒（core/audio-measure.mjs）' },
    spectrumAnalysisHz: { value: SPECTRUM_SAMPLE_RATE, what: 'noise / identify 的频谱分析采样率（SPECTRUM_SAMPLE_RATE）' },
    envelopeAnalysisHz: { value: ANALYSIS_SAMPLE_RATE, what: 'sync 的包络与相关分析采样率（ANALYSIS_SAMPLE_RATE），顶层 sampleRate 被忽略' },
    identifySpectrumWindowSeconds: { value: 60, what: 'identify 的频谱取自前 60 秒' },
    yamnetWindowSeconds: { value: 0.96, what: 'YAMNet 窗口（15360 采样 @16 kHz）' },
    yamnetHopSeconds: { value: 0.48, what: 'YAMNet 跳步，所以相邻段重叠一半' },
    yamnetMsPerWindow: { value: [70, 80], what: '实测单窗口 CPU 推理耗时，三分钟素材约两分钟' },
    syncCommonMaterialSeconds: { value: 10, what: '默认 maxLagSeconds=5 时实际需要的共同素材长度' },
    syncCorrelationFloor: { value: 0.3, what: '低于这个相关性时偏移不可信' },
    recordDeadlineSlackSeconds: { value: RECORD_DEADLINE_SLACK_SECONDS, what: '录音进程在 seconds + 这个值之后被强杀' },
  }
}

/**
 * The defaults this plugin applies, read from the core constants rather than retyped.
 * @returns {object} the defaults, grouped by where they come from.
 */
function defaults() {
  return {
    measure: {
      silenceNoiseDb: MEASURE_DEFAULTS.silenceNoiseDb,
      silenceMinSeconds: MEASURE_DEFAULTS.silenceMinSeconds,
      fftSize: MEASURE_DEFAULTS.fftSize,
      bandwidthDropDb: MEASURE_DEFAULTS.bandwidthDropDb,
      humProminenceDb: MEASURE_DEFAULTS.humProminenceDb,
      mainsHz: MEASURE_DEFAULTS.mainsHz,
      note: '这些来自 MEASURE_DEFAULTS；noise 真正的窗口默认值是 30，而回显的 defaults.windowSeconds 是 60，见 traps。',
    },
    tone: {
      levelDbfs: DEFAULT_TONE_LEVEL_DBFS,
      noiseSeed: DEFAULT_NOISE_SEED,
      note: 'sampleRate 默认 48000、channels 默认 2、bitDepth 默认 s16 是 action 层的字面量，不在 core 常量里。',
    },
    record: { ...RECORD_DEFAULTS },
    events: {
      topK: DEFAULT_TOP_K,
      minScore: DEFAULT_MIN_SCORE,
      silenceRms: DEFAULT_SILENCE_RMS,
      maxAudioSeconds: MAX_AUDIO_SECONDS,
    },
  }
}

/**
 * The hard limits a request can hit, each naming the action it constrains.
 * @returns {{id: string, value: number|string, action: string, why: string}[]} the limits.
 */
function limits() {
  return [
    {
      id: 'audio-events-max-seconds',
      value: MAX_AUDIO_SECONDS,
      action: 'audio_measure {action:"audio_events"}',
      why: '单次解码的硬上限；超过就拒绝而不是自动分段，切在哪里由调用方决定。',
    },
    {
      id: 'levels-max-seconds',
      value: 600,
      action: 'audio_measure {action:"levels"}',
      why: '默认分析上限；truncatedAtMaxSeconds 说明发生了截断，更长要分段。',
    },
    {
      id: 'record-max-seconds',
      value: 3600,
      action: 'audio_build {action:"record"}',
      why: '一次录音最多一小时，进程在 seconds + 20 秒被强杀，不会挂住。',
    },
    {
      id: 'yamnet-window',
      value: '0.96 s 窗口 / 0.48 s 跳步',
      action: 'audio_measure {action:"audio_events"}',
      why: '事件的时间分辨率因此受限于窗口，短事件会被摊到两个 segment 上。',
    },
    {
      id: 'sync-guard',
      value: '2 s 守卫 / 约 10 s 实用',
      action: 'audio_measure {action:"sync"}',
      why: '代码守卫只要求 2 秒共同素材，而默认搜索范围 ±5 秒才决定实际需要约 10 秒。',
    },
  ]
}

/**
 * Render one action's full entry as markdown.
 *
 * @param {string} tool - tool name.
 * @param {string} action - action name.
 * @param {object} entry - the registry entry for that action.
 * @returns {string} markdown.
 */
function renderAction(tool, action, entry) {
  const lines = [`### ${tool} {action:"${action}"}`, '', entry.summary, '']
  lines.push(`- **Use**: ${entry.use}`)
  if (entry.avoid) lines.push(`- **Avoid**: ${entry.avoid}`)
  lines.push(`- **Requires**: ${entry.required.length > 0 ? entry.required.join(', ') : 'nothing beyond "action"'}`)
  lines.push(`- **Returns**: ${entry.returns}`)
  lines.push(`- **Cost**: ${entry.cost}`)
  lines.push(`- **Example**: \`${JSON.stringify(entry.example)}\``)
  if (entry.seeAlso.length > 0) lines.push(`- **Goes with**: ${entry.seeAlso.join(', ')}`)
  if (entry.gotchas.length > 0) {
    lines.push('- **Pitfalls**:')
    for (const gotcha of entry.gotchas) lines.push(`  - ${gotcha}`)
  }
  return lines.join('\n')
}

/**
 * Attribute every declared parameter to the actions whose description names it.
 *
 * Parameter descriptions are written as `"action / action: meaning"`, which is what lets the
 * reference say which arguments an action actually reads without a second registry to keep in
 * sync.
 *
 * @param {object} definition - the live tool definition.
 * @param {string[]} actions - the tool's actions.
 * @returns {{ usedBy: string[]|null, name: string, schema: object }[]} parameters in schema order.
 */
function attributeParameters(definition, actions) {
  const properties = definition?.parameters?.properties ?? {}
  const rows = []
  for (const [name, schema] of Object.entries(properties)) {
    if (name === 'action') continue
    const description = typeof schema?.description === 'string' ? schema.description : ''
    const match = /^([a-z_]+(?: \/ [a-z_]+)*): /.exec(description)
    let usedBy = null
    if (match !== null) {
      const candidates = match[1].split(' / ')
      if (candidates.every((candidate) => actions.includes(candidate))) usedBy = candidates
    }
    rows.push({ name, schema, usedBy })
  }
  return rows
}

/**
 * Render one tool in full, including the parameter reference the schema only implies.
 *
 * @param {string} name - the tool name, which the definition may not carry if it was not wired in.
 * @param {object|undefined} definition - the live tool definition, when the caller wired it in.
 * @param {object} entry - the registry entry for the tool.
 * @returns {string} markdown.
 */
function renderTool(name, definition, entry) {
  const actions = definition?.parameters?.properties?.action?.enum ?? Object.keys(entry.actions)
  const lines = [
    `## ${name}`,
    '',
    entry.purpose,
    '',
    `- **Use it when**: ${entry.use.join('; ')}`,
    `- **Do not use it for**: ${entry.avoid.join('; ')}`,
    `- **Needs**: ${entry.needs.join(' ')}`,
    `- **Next**: ${entry.next.join(' ')}`,
    '',
    '### Arguments',
    '',
    '| argument | type | required by | meaning |',
    '| --- | --- | --- | --- |',
  ]

  const parameters = attributeParameters(definition, actions)
  for (const { name, schema, usedBy } of parameters) {
    const requiredBy = actions.filter((action) => {
      const actionEntry = entry.actions[action]
      return actionEntry.required.some((requirement) => requirement.includes(name))
    })
    const type = Array.isArray(schema.type) ? schema.type.join(' \\| ') : (schema.type ?? 'any')
    const meaning = typeof schema.description === 'string' ? schema.description.replace(/\|/g, '\\|') : ''
    const scope = requiredBy.length > 0 ? `${requiredBy.join(', ')} (required)` : usedBy === null ? 'shared' : usedBy.join(', ')
    lines.push(`| \`${name}\` | ${type} | ${scope} | ${meaning} |`)
  }

  lines.push('', '### Actions', '')
  for (const action of actions) {
    lines.push(renderAction(name, action, entry.actions[action]))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The whole surface as structured data: every tool, every action, and the facts that apply to
 * all of them.
 *
 * @param {object[]} definitions - every live tool definition, in surface order.
 * @returns {object} the index.
 */
function overviewData(definitions) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const tools = []
  const actions = []
  for (const name of TOOL_ORDER) {
    const entry = lookupTool(name)
    if (entry === undefined) continue
    const definition = byName.get(name)
    const actionNames = definition?.parameters?.properties?.action?.enum ?? Object.keys(entry.actions)
    tools.push({
      name,
      purpose: entry.purpose,
      needs: entry.needs,
      next: entry.next,
      actions: [...actionNames],
    })
    for (const action of actionNames) {
      actions.push({ tool: name, action, requires: [...(entry.actions[action]?.required ?? [])] })
    }
  }
  return {
    action: 'overview',
    tools,
    actions,
    rules: rules(),
    traps: traps(),
    boundaries: boundaries(),
    measured: measured(),
    defaults: defaults(),
    limits: limits(),
  }
}

/**
 * Build the `audio_guide` action table.
 *
 * @param {() => object[]} [getDefinitions] - returns every live tool definition. It is a thunk
 *   because the guide is itself one of them: at construction time the list is incomplete, at
 *   call time it is not. Omitting it only costs the parameter table in `tool` output.
 * @returns {{overview: Function, tool: Function, action: Function, rules: Function}} handlers.
 */
export function createGuideActions(getDefinitions = () => []) {
  /** Resolve a tool name, or refuse with the list of valid ones. */
  const findTool = (name, action) => {
    if (typeof name !== 'string' || name === '') {
      throw new AudioPluginError(`audio_guide ${action}: 需要 "tool"（可用：${TOOL_ORDER.join(', ')}）。`)
    }
    const definition = getDefinitions().find((entry) => entry.name === name)
    const entry = lookupTool(name)
    if (entry === undefined) {
      throw new AudioPluginError(`audio_guide ${action}: 未知的工具 ${JSON.stringify(name)}（可用：${TOOL_ORDER.join(', ')}）。`)
    }
    return { definition, entry }
  }

  /** Every action name the registry documents, for a refusal that can suggest one. */
  const allActionNames = () => TOOL_ORDER.flatMap((name) => Object.keys(lookupTool(name).actions))

  return {
    /**
     * The whole surface in one page.
     * @returns {object} the index, the rules, the traps, the measurements and the defaults.
     */
    async overview() {
      return overviewData(getDefinitions())
    },

    /**
     * One tool in full, including the arguments the schema only implies.
     * @param {object} args - the request; `tool` names the family.
     * @returns {object} the rendered entry.
     */
    async tool(args) {
      const { definition, entry } = findTool(args.tool, 'tool')
      return { action: 'tool', tool: args.tool, text: renderTool(args.tool, definition, entry) }
    },

    /**
     * One action in full.
     *
     * The action name goes in `actionName`, `tool` is optional. When an action name exists in
     * two tools the call is refused with both candidates instead of guessing, because the two
     * implementations are different jobs.
     *
     * @param {object} args - the request; `actionName` names the action.
     * @returns {object} the rendered entry.
     */
    async action(args) {
      const name = args.actionName
      if (typeof name !== 'string' || name === '') {
        throw new AudioPluginError(
          `audio_guide action: 需要 "actionName"（全部动作见 audio_guide {action:"overview"}）。`,
        )
      }
      let tool = typeof args.tool === 'string' && args.tool !== '' ? args.tool : null
      if (tool === null) {
        const candidates = TOOL_ORDER.filter((candidate) => lookupAction(candidate, name) !== undefined)
        if (candidates.length === 0) {
          throw new AudioPluginError(
            `audio_guide action: 没有动作 ${JSON.stringify(name)}（可用：${allActionNames().join(', ')}）。`,
          )
        }
        if (candidates.length > 1) {
          throw new AudioPluginError(
            `audio_guide action: 动作 ${JSON.stringify(name)} 同时存在于 ${candidates.join(' 与 ')}；请用 "tool" 指明是哪一个。`,
          )
        }
        tool = candidates[0]
      } else {
        // Validate the tool name even though the action lookup would fail anyway: the message
        // for an unknown tool is the useful one.
        findTool(tool, 'action')
      }

      const entry = lookupAction(tool, name)
      if (entry === undefined) {
        const definition = getDefinitions().find((candidate) => candidate.name === tool)
        const available = definition?.parameters?.properties?.action?.enum ?? Object.keys(lookupTool(tool).actions)
        throw new AudioPluginError(
          `audio_guide action: ${tool} 没有动作 ${JSON.stringify(name)}（可用：${available.join(', ')}）。`,
        )
      }
      const toolEntry = lookupTool(tool)
      const header = [`# ${tool} {action:"${name}"}`, '', toolEntry.purpose, ''].join('\n')
      return { action: 'action', tool, actionName: name, text: `${header}\n${renderAction(tool, name, entry)}` }
    },

    /**
     * The rules, the environment traps and the boundaries.
     * @returns {object} the three lists.
     */
    async rules() {
      return { action: 'rules', rules: rules(), traps: traps(), boundaries: boundaries() }
    },
  }
}

/**
 * Build the `audio_guide` tool definition.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createGuideTool(actions) {
  return defineFamilyTool({
    name: GUIDE_TOOL_NAME,
    actions: GUIDE_ACTIONS,
    extraProperties: GUIDE_PROPERTIES,
    handlers: actions,
  })
}

/** The registry, re-exported so a caller can reason about the surface without importing it twice. */
export const GUIDE_REGISTRY = REGISTRY

/** Every tool documented here, for callers that want the list. */
export const GUIDE_TOOL_NAMES = TOOL_ORDER
