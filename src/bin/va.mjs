#!/usr/bin/env node
/**
 * The optional command line for `dsh-video-audio`.
 *
 * It exposes the same operations the `audio_*` tools do, for two reasons: a stage can be debugged
 * without an agent in the loop (run the tone, listen to it, measure it, fix one flag and run it
 * again), and the test suite can drive the real code paths — the same `buildTone`, `measureLevels`
 * and `restoreAudio` the tools call, not a re-implementation of them.
 *
 * It deliberately has **no one-shot "process this audio" subcommand**. There is no `clean`, no
 * `master`, no `fix`. Every subcommand here does one stated thing to one stated file, because the
 * sequencing — which defect to remove, in what order, how much, and whether the result is usable —
 * is the caller's judgement, and a subcommand that made those choices would be hiding the very
 * decisions this plugin exists to keep visible. When a subcommand reports a number, it is a
 * measurement, not a verdict.
 *
 * `--json` prints the whole result object; without it the output is a short Chinese summary of the
 * numbers that matter, never the whole object. Progress and diagnostics go to stderr, so stdout
 * stays machine-readable even without `--json`.
 *
 * Usage: node src/bin/va.mjs <command> [options]
 *
 * @module dsh-video-audio/bin
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ASSEMBLE_METHODS,
  ASSEMBLE_SAMPLE_TOLERANCE,
  OVERLAP_POLICIES,
  RESTORE_CODECS,
  RESTORE_METHODS,
  TONE_KINDS,
  ANALYSIS_SAMPLE_RATE,
  assembleAudio,
  audioEventState,
  audioInstallState,
  auditIntegrity,
  buildTone,
  decodePcm,
  envelopeLag,
  findBinary,
  identifyAudio,
  installAudio,
  linearFit,
  listCaptureDevices,
  measureClips,
  measureLevels,
  measureLoudness,
  measureNoise,
  measureSilences,
  planPlacements,
  recordAudio,
  refineLag,
  removeAudio,
  restoreAudio,
  verifyInstalledAudio,
  versionOf,
} from '../core/index.mjs'

/** Print a JSON result on stdout. */
const emit = (value) => console.log(JSON.stringify(value, null, 2))

/** Drop keys whose value is `undefined`, so a core default is not overwritten by absence. */
const defined = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

/** Parse an optional numeric option. */
const numberOrUndefined = (value) => (value === undefined ? undefined : Number(value))

/** Parse a required positive numeric option. */
function requiredNumber(value, what) {
  const parsed = Number(value)
  if (value === undefined || !Number.isFinite(parsed)) {
    throw new Error(`${what} 必须是数字，收到 ${JSON.stringify(value)}`)
  }
  return parsed
}

/** Parse `--step '{"method":"dehum","mainsHz":50}'`, naming the offending value when it is broken. */
function parseStep(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `--step 不是合法 JSON：${JSON.stringify(text)}（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--step 必须是 JSON 对象，例如 '{"method":"dehum","mainsHz":50}'；收到 ${JSON.stringify(text)}`)
  }
  if (typeof parsed.method !== 'string' || parsed.method === '') {
    throw new Error(`--step 缺少 method 字段（可选：${RESTORE_METHODS.join(', ')}）；收到 ${JSON.stringify(parsed)}`)
  }
  return parsed
}

/**
 * Parse one `--clip` value: `<source>@<at>[:<until>]`, with times in seconds.
 *
 * The source path keeps every colon it contains — a Windows drive letter and an ffmpeg filter
 * time (`C:\take.wav:00:00:01`) both use them — so the times are read from the end of the string
 * only when they match a strict number:number pattern.
 *
 * @param {string} text - the raw option value.
 * @returns {{source: string, at: number, until: number|undefined}} the clip.
 */
function parseClip(text) {
  const match = /^(?<source>.+?)@(?<at>\d+(?:\.\d+)?)(?::(?<until>\d+(?:\.\d+)?))?$/.exec(String(text))
  if (match === null) {
    throw new Error(
      `--clip 必须写成 <文件>@<起点秒>[:<终点秒>]，例如 take.wav@2:8；收到 ${JSON.stringify(text)}`,
    )
  }
  return {
    source: match.groups.source,
    at: Number(match.groups.at),
    until: match.groups.until === undefined ? undefined : Number(match.groups.until),
  }
}

/** Start and end of the sound in a decoded signal, so a lead-in does not dominate the correlation. */
function loudExtent(samples) {
  let peak = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
  }
  const floor = Math.max(1e-4, peak * 0.02)
  let first = -1
  let last = -1
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) > floor) {
      if (first < 0) first = index
      last = index
    }
  }
  return first < 0 || last <= first ? null : { first, last }
}

/**
 * Drop the trailing silence from a decoded signal, and nothing else.
 *
 * The leading silence must stay. A delay is very often exactly a longer lead-in — the recorder
 * started rolling before the slate — so trimming the front normalises away the offset that is being
 * measured. Doing that made two recordings whose content sat two seconds apart correlate perfectly
 * at zero offset, because after the trim both began at their first loud sample. The tail is
 * different: it carries nothing but the room, so removing it keeps a long take from dragging the
 * correlation towards a lag that is only an artefact of how long each file happens to run.
 */
function withoutTrailingSilence(samples) {
  const extent = loudExtent(samples)
  return extent === null ? null : samples.subarray(0, extent.last + 1)
}

/**
 * Measure the offset, and the drift, between two recordings of the same audio.
 *
 * There is no `sync` in `src/core` yet: the registry documents the action but the deterministic
 * function behind it has not been lifted out of the tool layer, so the CLI composes it from the
 * primitives that are in the core — {@link envelopeLag} for the coarse lag, {@link refineLag} for
 * the sample-accurate one, {@link linearFit} for the drift. Everything here is a measurement; the
 * caller decides whether the offset is worth correcting.
 *
 * @param {object} options - the measurement.
 * @param {string} options.reference - the file the comparison is measured against.
 * @param {string} options.comparison - the file whose delay is reported.
 * @param {number} [options.maxLagSeconds] - how far either way to search; default 5.
 * @param {number} [options.windows] - how many windows the drift fit uses; default 5.
 * @param {number} [options.sampleRate] - decode rate; default 8000.
 * @param {number} [options.maxSeconds] - analyse at most this much; default 120.
 * @returns {Promise<object>} the reported shape: offset, correlation, drift, windows.
 */
async function measureSync({ reference, comparison, maxLagSeconds = 5, windows = 5, sampleRate = ANALYSIS_SAMPLE_RATE, maxSeconds = 120 }) {
  const wanted = windows * 3 * 2
  const duration = Math.max(4, Math.min(maxSeconds, wanted))
  const decode = (source) =>
    decodePcm({ source, config: {}, sampleRate, channels: 1, duration, maxBytes: 48 * 1024 * 1024 })
  const [a, b] = await Promise.all([decode(reference), decode(comparison)])

  const refTrimmed = withoutTrailingSilence(a.samples)
  const cmpTrimmed = withoutTrailingSilence(b.samples)
  if (refTrimmed === null || cmpTrimmed === null) {
    throw new Error('两个文件里至少有一个几乎是静音，没有可用于对齐的结构。')
  }

  const coarse = envelopeLag(refTrimmed, cmpTrimmed, sampleRate, { envelopeRate: 100, maxLagSeconds })
  if (coarse === null) {
    throw new Error(
      `共同音频太短：粗对齐需要至少 ${(maxLagSeconds * 2 + 0.08).toFixed(2)}s 的重叠（当前参考 ${(refTrimmed.length / sampleRate).toFixed(2)}s，` +
        `对比 ${(cmpTrimmed.length / sampleRate).toFixed(2)}s）。`,
    )
  }
  const offset = refineLag(refTrimmed, cmpTrimmed, coarse.lagSeconds, sampleRate, 0.05)

  const spanStart = Math.max(0, -Math.floor(offset.lagSeconds * sampleRate))
  const span = Math.min(refTrimmed.length - spanStart, cmpTrimmed.length - spanStart - Math.floor(offset.lagSeconds * sampleRate))
  const usable = Math.max(0, span)
  const windowCount = Math.max(2, Math.round(windows))
  const windowSamples = Math.floor(usable / windowCount)
  const found = []
  for (let index = 0; index < windowCount; index += 1) {
    const from = spanStart + index * windowSamples
    const slice = (signal) => {
      const start = Math.max(0, Math.min(signal.length, from))
      return signal.subarray(start, Math.min(signal.length, start + windowSamples))
    }
    const left = slice(refTrimmed)
    const right = slice(cmpTrimmed)
    const local = refineLag(left, right, offset.lagSeconds, sampleRate, 0.005)
    const at = Number((from / sampleRate).toFixed(3))
    found.push({ at, offsetSeconds: local.lagSeconds, correlation: local.correlation })
  }

  const fit = linearFit(found.map((entry) => entry.at), found.map((entry) => entry.offsetSeconds))
  return {
    reference,
    comparison,
    sampleRate,
    analysedSeconds: Number((usable / sampleRate).toFixed(3)),
    offsetSeconds: offset.lagSeconds,
    correlation: offset.correlation,
    maxLagSeconds,
    driftPpm: fit === null ? null : Number((fit.slope * 1e6).toFixed(1)),
    driftFitted: fit !== null,
    windows: found,
    note:
      'offsetSeconds 为正表示 comparison 比 reference 晚。correlation 低于 0.3 时这个偏移不应被信任。' +
      'driftPpm 由各窗偏移的线性拟合得到：非 0 表示两台的时钟不同，对齐一次之后越往后越偏。',
  }
}

/**
 * Read one option that is allowed to start with `-`.
 *
 * `node:util`'s parser cannot tell `--start -5` from an option, so a negative number has to be
 * written `--start=-5` on the command line; this reads that form, and tolerates the other one when
 * the value is already in the parsed set.
 */
const negativeSafe = (values, key) => (values[key] === undefined ? undefined : values[key])

/** Per-action options the CLI accepts, in the order `usage()` shows them. */
const ACTION_OPTIONS = {
  identify: '[--json]',
  levels: '[--clip-threshold 0.999] [--min-clip-samples 3] [--max-seconds 600] [--no-timeline] [--json]',
  loudness: '[--timeline] [--json]',
  'speech-map': '[--noise-db -40] [--min-seconds 0.25] [--json]',
  integrity: '[--repair] [--repair-path <文件>] [--json]',
  noise: '[--window-seconds 30] [--fft-size 8192] [--mains-hz 50] [--json]',
  sync: '[--max-lag 5] [--windows 5] [--sample-rate 8000] [--max-seconds 120] [--json]',
  devices: '[--json]',
  record: '[--sample-rate 48000] [--channels 1] [--json]',
  events: '[--start 秒] [--duration 秒] [--top-k 3] [--min-score 0.1] [--silence-rms 0.002] [--json]',
  install: '[--force] [--archive <本地文件或目录>] [--remove]',
}

/**
 * The usage text: every subcommand with every option it takes.
 * @returns {string} the text printed for `--help`, `-h`, and no arguments.
 */
function usage() {
  return `dsh-video-audio — 造声音、修声音、量声音

用法：node src/bin/va.mjs <命令> [选项]

命令：
  doctor                             体检：ffmpeg/ffprobe 在哪、由哪条规则找到，音频事件模型是否可用
  status                             只报磁盘上装了什么（模型与运行时），不装不删
  install [--force] [--archive <本地文件或目录>] [--remove]
                                     装/卸 YAMNet 模型与共享 ONNX 运行时到 vendor/audio/
  tone [--kind ${TONE_KINDS.join('|')}]
       --seconds <秒> [--frequency 1000] [--sweep-to 20000] [--level-dbfs -3]
       [--sample-rate 48000] [--channels 2] [--seed 1] [--bit-depth s16|s24|f32]
       [--out <文件>] [--json]
                                     生成完全指定参数的测试信号，写完再读回来核对采样数
  assemble --clip <文件@起点秒[:终点秒]> [--clip …] [--total <秒>] [--tail <秒>]
           [--sample-rate 48000] [--channels 2] [--overlap ${OVERLAP_POLICIES.join('|')}]
           [--method ${ASSEMBLE_METHODS.join('|')}] [--out <文件>] [--json]
                                     采样级装配时间线；verification.exact 为 false 时以非零退出

  identify <文件…> ${ACTION_OPTIONS.identify}
                                     报容器/编码、声明时长对解码时长、解码错误、带宽与频谱倾斜
  levels <文件> ${ACTION_OPTIONS.levels}
                                     采样域事实：峰值、RMS、波峰因数、直流偏移、削波段与电平时间线
  loudness <文件…> ${ACTION_OPTIONS.loudness}
                                     EBU R128 整体响度、响度范围、真峰值；多文件时给出离散度
  speech-map <文件> ${ACTION_OPTIONS['speech-map']}
                                     语音与静音在哪里（按阈值，不是语音识别）
  integrity <文件> ${ACTION_OPTIONS.integrity}
                                     帧链逐帧审计；--repair 另写一份修复副本，绝不动原文件
  noise <文件> ${ACTION_OPTIONS.noise}
                                     噪声底由什么构成：宽带底、50/60Hz 谐波族、频谱倾斜、最强单音
  sync <参考> <对比> ${ACTION_OPTIONS.sync}
                                     两个录音之间的偏移与时钟漂移（包络相关 + 逐采样细化）
  devices ${ACTION_OPTIONS.devices}
                                     列出 DirectShow 采集设备的确切名字
  record --device <名字> --seconds <秒> [--out <文件>] ${ACTION_OPTIONS.record}
                                     从指定设备录固定秒数并测量这一条（本插件唯一的非确定性动作）
  restore <文件> [--step '<JSON>']… [--out <文件>] [--codec ${RESTORE_CODECS.join('|')}]
          [--sample-rate <赫兹>] [--channels <1|2>] [--no-measure] [--json]
                                     跑一条显式修复链（${RESTORE_METHODS.join('/')}），写完再测一次报变化
  events <文件> ${ACTION_OPTIONS.events}
                                     YAMNet 把音轨分成 521 类声学事件并给出时间点

每个命令都接受 --json：给了就打印完整 JSON，不给就打印简短中文摘要。

没有"一键处理音频"命令：先测什么、再修什么、修到什么程度、结果能不能用，都是调用方的判断；
本命令行只做一件件说明白的事，并且只报数字，不下结论。`
}

const USAGE = usage()

/** Human-readable reports, one per subcommand. Kept short on purpose: the numbers that matter only. */
const HUMAN = {
  doctor(report) {
    const line = (label, entry) =>
      entry.found
        ? `${label}：${entry.path}（来源 ${entry.source}）\n  ${entry.version ?? '无法读取版本'}`
        : `${label}：未找到`
    console.log(line('ffmpeg', report.ffmpeg))
    console.log(line('ffprobe', report.ffprobe))
    console.log(
      `音频事件模型：${report.audio.available ? `可用（${report.audio.classes} 类，来自 ${report.audio.vendorSource}）` : `不可用（缺少 ${report.audio.missing.join(', ')}）`}`,
    )
    console.log(`Node ${report.node}，${report.platform}`)
    for (const problem of report.problems) console.log(`问题：${problem}`)
    for (const note of report.notes) console.log(`注意：${note}`)
  },

  status(state) {
    console.log(`可用：${state.available}，本插件 vendor/audio 里 ${state.fileCount} 个文件，共 ${(state.totalBytes / 1024 / 1024).toFixed(2)} MB`)
    console.log(`  模型 ${(state.modelBytes / 1024 / 1024).toFixed(2)} MB，运行时 ${(state.runtimeBytes / 1024 / 1024).toFixed(2)} MB`)
    console.log(`  读取目录：${state.vendorDir}（来源 ${state.vendorSource}）`)
    if (state.vendorSource === 'sibling') {
      console.log('  注意：现在读的是同级插件里的副本；install 会把它们复制到本插件的 vendor/audio。')
    }
    if (state.missing.length > 0) console.log(`  缺少：${state.missing.join(', ')}`)
    if (state.reason !== null) console.log(`  原因：${state.reason}`)
  },

  install(result) {
    console.log(`安装：${result.installed ? '完成' : '未安装'}${result.skipped ? '（已存在且校验通过，跳过）' : ''}`)
    if (result.adopted === true) console.log(`  从同级插件复制：${result.from}，未下载`)
    if (result.removed !== undefined) console.log(`  删除：${result.removed === true ? '完成' : '本来就没有'}`)
    const verify = result.verify ?? null
    if (verify !== null) console.log(`  校验：检查 ${verify.checked} 个，不匹配 ${verify.mismatched.length} 个，缺失 ${verify.missing.length} 个`)
    if (result.stillVisibleFrom !== undefined && result.stillVisibleFrom !== null) {
      console.log(`  注意：${result.stillVisibleFrom} 里还有一份副本，检测仍然可用`)
    }
  },

  tone(result) {
    const resolved = result.resolved
    // `kind` is on the result, not inside `resolved`, which holds only the parameters that were
    // actually applied to the signal.
    console.log(
      `${result.kind} ${resolved.durationSeconds}s ${resolved.sampleRate}Hz ${resolved.channels}ch ` +
        `${resolved.levelDbfs}dBFS${resolved.frequencyHz === null ? '' : ` @${resolved.frequencyHz}Hz`}` +
        `${resolved.seed === null ? '' : ` seed=${resolved.seed}`}`,
    )
    console.log(`  ${result.path}（${(result.written.bytes / 1024).toFixed(1)} KiB，${resolved.bitDepth}）`)
    console.log(
      `  采样差 ${result.written.sampleDelta}，峰值 ${result.measured.peakDbfs}dBFS，RMS ${result.measured.rmsDbfs}dBFS，` +
        `解码错误 ${result.measured.decodeErrors}`,
    )
  },

  assemble(result) {
    console.log(`装配 ${result.method}/${result.channels}ch ${result.sampleRate}Hz，${result.placements.length} 段 → ${result.path}`)
    for (const placement of result.placements) {
      console.log(
        `  #${placement.index} ${String(placement.source).split(/[\\/]/).pop()} @${placement.at}s ` +
          `${placement.seconds}s（${placement.atSamples}+${placement.samples} 采样${placement.trimmed ? '，已截断' : ''}）`,
      )
    }
    const verification = result.verification
    console.log(
      `  验证：计划 ${verification.expectedSamples} 采样，解码 ${verification.decodedSamples}，差 ${verification.sampleDelta}，` +
        `exact=${verification.exact}`,
    )
    console.log(`  峰值 ${verification.peakDbfs}dBFS，RMS ${verification.rmsDbfs}dBFS，解码错误 ${verification.decodeErrors}`)
    if (result.overlaps.length > 0) console.log(`  重叠 ${result.overlaps.length} 处（策略已接受）`)
    if (result.manifest !== undefined) console.log(`  清单：${result.manifest}`)
  },

  identify(report) {
    console.log(`${report.source}`)
    console.log(
      `  ${report.container}/${report.codec} ${report.sampleRate}Hz ${report.channels}ch，声明 ${report.declaredSeconds}s，` +
        `解码 ${report.decodedSeconds}s，差 ${report.decodedVsDeclaredSeconds}s（${report.decodedVsDeclaredPercent}%）`,
    )
    if (report.spectrum !== undefined && report.spectrum.error === undefined) {
      console.log(`  带宽 ${report.spectrum.bandwidth.bandwidthHz}Hz（分析窗 ${report.spectrum.windowSeconds}s）`)
    } else if (report.spectrum !== undefined) {
      console.log(`  频谱未能测量：${report.spectrum.error}`)
    }
    if (report.decodeErrors > 0) console.log(`  解码错误 ${report.decodeErrors}：${(report.errorSamples ?? []).join(' | ')}`)
  },

  levels(report) {
    console.log(`${report.source} ${report.sampleRate}Hz ${report.channels}ch，分析 ${report.analysedSeconds}s`)
    console.log(
      `  峰值 ${report.peakDbfs}dBFS，RMS ${report.rmsDbfs}dBFS，波峰因数 ${report.crestFactorDb}，直流偏移 ${report.dcOffset}（${report.dcOffsetDbfs}dBFS）`,
    )
    console.log(
      `  削波（阈值 ${report.clipping.threshold}）：${report.clipping.totalHighSamples} 个超阈采样，列出 ${report.clipping.listedRuns} 段` +
        `${report.clipping.truncated ? '（列表已截断）' : ''}`,
    )
    for (const run of report.clipping.runs.slice(0, 5)) {
      console.log(`    @${run.atSeconds}s  ${run.samples} 采样`)
    }
    if (report.timeline === null) console.log('  时间线：未采集')
  },

  loudness(reports) {
    // The core's loudness report does not echo the path it measured, so the path is kept here
    // rather than invented from a result that does not carry one.
    console.log(`${reports.length} 个文件`)
    for (const entry of reports) {
      console.log(`  ${entry.source}  I=${entry.loudness.integratedLufs} LUFS  LRA=${entry.loudness.loudnessRangeLu} LU  真峰值=${entry.loudness.truePeakDbfs} dBFS`)
    }
    const measured = reports.map((entry) => entry.loudness.integratedLufs).filter((value) => Number.isFinite(value))
    if (measured.length > 1) {
      const spread = Number((Math.max(...measured) - Math.min(...measured)).toFixed(2))
      const sorted = [...measured].sort((a, b) => a - b)
      const median = sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : Number(((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(2))
      console.log(`  离散度 ${spread} LU，中位数 ${median} LUFS`)
    }
  },

  'speech-map'(report) {
    console.log(`${report.source}，${report.durationSeconds}s，阈值 ${report.thresholdDb}dB / 最短静音 ${report.minSilenceSeconds}s`)
    console.log(
      `  语音 ${report.speech.length} 段共 ${report.speechSeconds}s（占比 ${((report.speechSeconds / Math.max(report.durationSeconds, 1e-9)) * 100).toFixed(1)}%），` +
        `静音 ${report.silence.length} 段共 ${report.silenceSeconds}s`,
    )
    if (report.longestGap !== null) {
      console.log(`  最长停顿 ${report.longestGap.seconds}s，在 ${report.longestGap.start}s`)
    }
  },

  integrity(report) {
    const walk = report.frameWalk
    console.log(`${report.source}，容器 ${report.container}/${report.codec}`)
    console.log(
      `  声明 ${report.declaredSeconds}s，解码 ${report.decodedSeconds}s，差 ${report.decodedVsDeclaredSeconds}s，解码错误 ${report.decodeErrors}`,
    )
    if (walk.applies !== true) {
      console.log(`  逐帧链检查不适用：${walk.note}`)
    } else {
      console.log(
        `  帧链：${walk.frames} 帧 / 走过 ${walk.walkedSeconds}s，断裂 ${walk.breakCount} 处共 ${walk.breakBytes} 字节，` +
          `估计丢失 ${walk.estimatedLostSeconds}s${walk.stoppedEarly ? '（提前停止）' : ''}`,
      )
      for (const entry of Object.entries(walk.gapHistogram ?? {})) console.log(`    间隙 ${entry[0]} 字节：${entry[1]} 处`)
    }
    if (report.repair !== undefined) {
      console.log(`  修复副本 ${report.repair.path}：去间隙 ${report.repair.removedGaps} 处 / ${report.repair.removedBytes} 字节，${report.repair.frames} 帧`)
    }
  },

  noise(report) {
    console.log(`${report.source}，${report.windows} 个窗，共 ${report.analysedSeconds}s（分析窗对齐 ${report.windowAligned}）`)
    console.log(
      `  宽带底：均值 ${report.broadband.meanRmsDb}dB，最静窗 ${report.broadband.quietestRmsDb}dB @${report.broadband.quietestAt}s，` +
        `最响窗 ${report.broadband.loudestRmsDb}dB`,
    )
    console.log(
      `  工频：主导 ${report.hum.dominantFamilyHz}Hz 族，50Hz 族合计 ${report.hum.sum50HzDb}dB，60Hz 族合计 ${report.hum.sum60HzDb}dB`,
    )
    for (const entry of report.hum.harmonics.filter((h) => h.db !== null).sort((a, b) => b.db - a.db).slice(0, 3)) {
      console.log(`    ${entry.frequencyHz}Hz（${entry.familyHz}Hz 第 ${entry.harmonic} 次）${entry.db}dB`)
    }
    console.log(`  带宽 ${report.spectrum.bandwidth.bandwidthHz}Hz，频谱取自 ${report.spectrum.atSeconds}s（${report.spectrum.fftSize} 点）`)
    for (const peak of report.spectrum.tonalPeaks.slice(0, 3)) {
      console.log(`    单音 ${peak.frequencyHz}Hz ${peak.db}dB（突出 ${peak.prominenceDb}dB）`)
    }
  },

  sync(report) {
    console.log(`${report.reference} ← ${report.comparison}`)
    console.log(
      `  偏移 ${report.offsetSeconds}s（正=对比更晚），相关 ${report.correlation}，漂移 ${report.driftPpm} ppm，` +
        `分析 ${report.analysedSeconds}s`,
    )
    for (const window of report.windows) {
      console.log(`    @${window.at}s  偏移 ${window.offsetSeconds}s  相关 ${window.correlation}`)
    }
    if (!(report.correlation >= 0.3)) console.log('  警告：相关低于 0.3，这个偏移不应被信任。')
  },

  devices(report) {
    console.log(`dshow 可用：${report.supported}`)
    if (report.audio.length === 0) console.log('  没有音频采集设备（这是有效答案，不是失败）')
    for (const device of report.audio) {
      console.log(`  ${device.name}${device.alternative === null ? '' : `  （别名 ${device.alternative}）`}`)
    }
    if (report.error !== null && report.error !== undefined) console.log(`  ${report.error}`)
  },

  record(result) {
    console.log(`${result.path}  ${result.device}`)
    console.log(
      `  请求 ${result.requestedSeconds}s，实测 ${result.measuredSeconds}s，误差 ${result.durationErrorSeconds}s，截止 ${result.deadlineSeconds}s`,
    )
    if (result.measured !== null) {
      console.log(`  峰值 ${result.measured.peakDbfs}dBFS，RMS ${result.measured.rmsDbfs}dBFS，解码错误 ${result.measured.decodeErrors}`)
    }
    if (result.noise !== null) {
      console.log(`  噪声：最静窗 ${result.noise.quietestRmsDb}dB，主导工频 ${result.noise.dominantMainsHz}Hz，带宽 ${result.noise.bandwidthHz}Hz`)
    }
  },

  restore(result) {
    console.log(`${result.source} → ${result.path}（${result.codec}）`)
    // `chain` is the joined ffmpeg filter string; `resolvedSteps` is the same chain with every
    // parameter named, which is the part a caller can check against what they asked for.
    console.log(`  链：${result.chain}`)
    for (const step of result.resolvedSteps) console.log(`    ${step.method} ${JSON.stringify(step)}`)
    if (result.change !== null) {
      console.log(
        `  峰值 ${result.before.peakDbfs}→${result.after.peakDbfs}dBFS（${result.change.peakDb}），` +
          `噪声底 ${result.before.noiseFloorDb}→${result.after.noiseFloorDb}dB（${result.change.noiseFloorDb}）`,
      )
      for (const family of ['hum50Hz', 'hum60Hz']) {
        const delta = result.change[family]
        if (delta !== null && delta !== undefined) console.log(`  ${family}: ${delta.fromDb}→${delta.toDb}dB（${delta.changedDb}）`)
      }
    } else {
      console.log('  未测量（--no-measure）：没有前后数字，就没有这条链有效的证据。')
    }
  },

  events(report) {
    console.log(`${report.path}，${report.durationSec.toFixed(2)}s，${report.soundtrack.windows} 个分析窗（分类 ${report.soundtrack.classified}，静音 ${report.soundtrack.silent}）`)
    for (const [label, times] of Object.entries(report.events)) {
      console.log(`  ${label}  ${times.length} 次  ${times.slice(0, 6).join(', ')}${times.length > 6 ? ' …' : ''}`)
    }
    for (const note of report.notes ?? []) console.log(`  注意：${note}`)
  },
}

const COMMANDS = {
  /** Report the environment: where the borrowed ffmpeg came from, and whether the model is installed. */
  async doctor(options) {
    const ffmpeg = findBinary('ffmpeg', null)
    const ffprobe = findBinary('ffprobe', null)
    const problems = []
    if (ffmpeg === null) {
      problems.push(
        '找不到 ffmpeg。查找顺序：config.ffmpegPath → 环境变量 DSH_AUDIO_FFMPEG → 本插件 vendor/ffmpeg/bin/ → 共享目录 ~/.dsh-plugins/ffmpeg/bin → 同级 video-factory/vendor/ffmpeg/bin/ → PATH。',
      )
    }
    if (ffprobe === null) {
      problems.push(
        '找不到 ffprobe。查找顺序：config.ffprobePath → 环境变量 DSH_AUDIO_FFPROBE → 本插件 vendor/ffmpeg/bin/ → 共享目录 ~/.dsh-plugins/ffmpeg/bin → 同级 video-factory/vendor/ffmpeg/bin/ → PATH。',
      )
    }

    const report = {
      ok: problems.length === 0,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      ffmpeg: ffmpeg === null ? { found: false } : { found: true, path: ffmpeg.path, source: ffmpeg.source, version: await versionOf(ffmpeg.path) },
      ffprobe: ffprobe === null ? { found: false } : { found: true, path: ffprobe.path, source: ffprobe.source, version: await versionOf(ffprobe.path) },
      // The live state, not the whole manifest: the model and runtime metadata are what `status`
      // reports, and doctor stays a page the caller can read at a glance.
      audio: (({ available, kind, classes, missing, vendorDir, vendorSource, reason }) => ({
        available,
        kind,
        classes,
        missing,
        vendorDir,
        vendorSource,
        reason,
      }))(audioEventState()),
      notes: [],
      problems,
    }

    if (!report.audio.available) {
      report.notes.push(
        '音频事件检测（events）尚未安装：装它用 install，只想知道状态用 status；其余测量命令不需要它。',
      )
    }
    if (options.json === true) emit(report)
    else HUMAN.doctor(report)
    return report.ok ? 0 : 1
  },

  /** Report what is on disk, without changing anything. */
  async status(options) {
    const state = audioInstallState()
    const verify = verifyInstalledAudio()
    const report = { ...state, verify }
    if (options.json === true) emit(report)
    else {
      HUMAN.status(state)
      console.log(`  校验：检查 ${verify.checked} 个文件，不匹配 ${verify.mismatched.length} 个，缺失 ${verify.missing.length} 个`)
      for (const mismatch of verify.mismatched) console.log(`    不匹配：${mismatch.path}`)
      for (const missing of verify.missing) console.log(`    缺失：${missing}`)
    }
    return 0
  },

  /** Install, or remove, the YAMNet model and the shared ONNX runtime. */
  async install(options) {
    const onProgress = (message) => console.error(message)
    if (options.remove === true) {
      const result = removeAudio({ onProgress })
      const report = { ...result, state: audioInstallState() }
      if (options.json === true) emit(report)
      else HUMAN.install(report)
      return 0
    }
    const result = await installAudio({
      force: options.force === true,
      modelArchive: options.archive,
      onProgress,
    })
    const report = { ...result, state: audioInstallState(), verify: verifyInstalledAudio() }
    if (options.json === true) emit(report)
    else HUMAN.install(report)
    return 0
  },

  /** Generate one test signal with every parameter stated. */
  async tone(options) {
    const seconds = options.seconds
    if (seconds === undefined) throw new Error('tone: --seconds <秒> is required')
    const outPath = resolve(options.out ?? 'tone.wav')
    const request = defined({
      kind: options.kind,
      durationSeconds: requiredNumber(seconds, 'tone: --seconds'),
      frequencyHz: numberOrUndefined(options.frequency),
      sweepToHz: numberOrUndefined(options['sweep-to']),
      levelDbfs: numberOrUndefined(negativeSafe(options, 'level-dbfs')),
      sampleRate: numberOrUndefined(options['sample-rate']),
      channels: numberOrUndefined(options.channels),
      seed: numberOrUndefined(options.seed),
      bitDepth: options['bit-depth'],
      outPath,
    })
    const result = await buildTone({ request, config: {} })
    if (options.json === true) emit(result)
    else HUMAN.tone(result)
    return result.written.sampleDelta === 0 ? 0 : 1
  },

  /** Place clips on one timeline to the sample, and prove where they landed. */
  async assemble(options) {
    const clips = (options.clip ?? []).map(parseClip).map((clip) => ({ ...clip, source: resolve(clip.source) }))
    if (clips.length === 0) throw new Error('assemble: at least one --clip <文件@起点[:终点]> is required')
    const outPath = resolve(options.out ?? join('audio', 'timeline.wav'))
    const method = options.method
    const sampleRate = numberOrUndefined(options['sample-rate'])

    const measured = await measureClips(clips, {})
    if (measured.missing.length > 0) {
      throw new Error(`assemble: 读不出这些片段的长度（文件不存在或不是音频）：${measured.missing.join(', ')}`)
    }
    const required = measured.clips.reduce((max, clip) => Math.max(max, clip.at + (clip.until ?? clip.seconds)), 0)
    const tail = numberOrUndefined(options.tail) ?? 0
    const totalSeconds = numberOrUndefined(options.total) ?? Number((required + tail).toFixed(6))

    const plan = planPlacements({
      clips: measured.clips.map((clip) => defined({ source: clip.source, at: clip.at, seconds: clip.seconds, until: clip.until })),
      totalSeconds,
      sampleRate: sampleRate ?? 48_000,
      overlap: options.overlap,
    })
    const result = await assembleAudio({ plan, method, channels: numberOrUndefined(options.channels), outPath, config: {} })

    if (options.json === true) emit(result)
    else HUMAN.assemble(result)

    if (result.verification.exact !== true) {
      const rate = plan.sampleRate
      console.error(
        `错误：装配结果不是采样级精确——计划 ${result.verification.expectedSamples} 采样，解码出 ${result.verification.decodedSamples}，` +
          `差 ${result.verification.sampleDelta} 采样（容差 ${ASSEMBLE_SAMPLE_TOLERANCE}）。` +
          `写出的文件在 ${outPath}，请先看 verification 再决定是否使用。`,
      )
      return 1
    }
    return 0
  },

  /** What a file claims versus what it delivers. */
  async identify(options) {
    const paths = options.paths ?? []
    if (paths.length === 0) throw new Error('identify: at least one <文件> is required')
    const reports = []
    for (const path of paths) reports.push(await identifyAudio({ source: resolve(path), config: {} }))
    const value = reports.length === 1 ? reports[0] : reports
    if (options.json === true) emit(value)
    else for (const report of reports) HUMAN.identify(report)
    return reports.every((report) => report.decodeErrors === 0) ? 0 : 1
  },

  /** Sample-domain facts about one file. */
  async levels(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('levels: <文件> is required')
    const report = await measureLevels({
      source: resolve(target),
      config: {},
      ...defined({
        clipThreshold: numberOrUndefined(options['clip-threshold']),
        minClipSamples: numberOrUndefined(options['min-clip-samples']),
        maxSeconds: numberOrUndefined(options['max-seconds']),
        timeline: options['no-timeline'] === true ? false : undefined,
      }),
    })
    if (options.json === true) emit(report)
    else HUMAN.levels(report)
    return 0
  },

  /** EBU R128 loudness, one or several files. */
  async loudness(options) {
    const paths = options.paths ?? []
    if (paths.length === 0) throw new Error('loudness: at least one <文件> is required')
    const reports = []
    for (const path of paths) {
      const source = resolve(path)
      // The core's report does not echo the file it measured; carrying the resolved path beside it
      // is what lets several files be told apart without guessing from their order.
      reports.push({ source, ...(await measureLoudness({ source, config: {}, timeline: options.timeline === true })) })
    }
    const value = reports.length === 1 ? reports[0] : reports
    if (options.json === true) emit(value)
    else HUMAN.loudness(reports)
    return 0
  },

  /** Where speech is and where silence is. */
  async 'speech-map'(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('speech-map: <文件> is required')
    const report = await measureSilences({
      source: resolve(target),
      config: {},
      ...defined({
        noiseDb: numberOrUndefined(negativeSafe(options, 'noise-db')),
        minSeconds: numberOrUndefined(options['min-seconds']),
      }),
    })
    if (options.json === true) emit(report)
    else HUMAN['speech-map'](report)
    return 0
  },

  /** Whether the file is all there, and on request a repaired copy. */
  async integrity(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('integrity: <文件> is required')
    const source = resolve(target)
    const repair = options.repair === true
    const repairPath = options['repair-path'] === undefined
      ? (repair ? `${source}.repaired.mp3` : undefined)
      : resolve(options['repair-path'])
    const report = await auditIntegrity({ source, config: {}, ...defined({ repair, repairPath }) })
    if (options.json === true) emit(report)
    else HUMAN.integrity(report)
    const gaps = report.frameWalk.applies === true ? report.frameWalk.breakCount : 0
    return gaps > 0 && options.repair !== true ? 1 : 0
  },

  /** What the noise floor is made of. */
  async noise(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('noise: <文件> is required')
    const report = await measureNoise({
      source: resolve(target),
      config: {},
      ...defined({
        windowSeconds: numberOrUndefined(options['window-seconds']),
        fftSize: numberOrUndefined(options['fft-size']),
        mainsHz: numberOrUndefined(options['mains-hz']),
      }),
    })
    if (options.json === true) emit(report)
    else HUMAN.noise(report)
    return 0
  },

  /** The offset, and the drift, between two recordings of the same audio. */
  async sync(options) {
    const [reference, comparison] = options.paths ?? []
    if (reference === undefined || comparison === undefined) {
      throw new Error('sync: <参考文件> <对比文件> are required')
    }
    const report = await measureSync({
      reference: resolve(reference),
      comparison: resolve(comparison),
      ...defined({
        maxLagSeconds: numberOrUndefined(options['max-lag']),
        windows: numberOrUndefined(options.windows),
        sampleRate: numberOrUndefined(options['sample-rate']),
        maxSeconds: numberOrUndefined(options['max-seconds']),
      }),
    })
    if (options.json === true) emit(report)
    else HUMAN.sync(report)
    return 0
  },

  /** The capture devices DirectShow reports. */
  async devices(options) {
    const report = await listCaptureDevices({ config: {} })
    if (options.json === true) emit(report)
    else HUMAN.devices(report)
    return 0
  },

  /** Record a fixed number of seconds from one named device. */
  async record(options) {
    if (options.device === undefined) throw new Error('record: --device <名字> is required')
    if (options.seconds === undefined) throw new Error('record: --seconds <秒> is required')
    const seconds = requiredNumber(options.seconds, 'record: --seconds')
    const outPath = resolve(options.out ?? 'take.wav')
    const result = await recordAudio({
      device: options.device,
      seconds,
      outPath,
      config: {},
      ...defined({
        sampleRate: numberOrUndefined(options['sample-rate']),
        channels: numberOrUndefined(options.channels),
      }),
    })
    if (options.json === true) emit(result)
    else HUMAN.record(result)
    return Math.abs(result.durationErrorSeconds) > 0.05 ? 1 : 0
  },

  /** Apply an explicit restoration chain, then measure what came out. */
  async restore(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('restore: <文件> is required')
    const steps = (options.step ?? []).map(parseStep)
    if (steps.length === 0) {
      throw new Error(`restore: at least one --step '<JSON>' is required（可选方法：${RESTORE_METHODS.join(', ')}）`)
    }
    const outPath = resolve(options.out ?? `${target.replace(/\.[^./\\]+$/, '')}.restored.wav`)
    const result = await restoreAudio({
      source: resolve(target),
      outPath,
      steps,
      config: {},
      ...defined({
        codec: options.codec,
        sampleRate: numberOrUndefined(options['sample-rate']),
        channels: numberOrUndefined(options.channels),
        measure: options['no-measure'] === true ? false : undefined,
      }),
    })
    if (options.json === true) emit(result)
    else HUMAN.restore(result)
    return 0
  },

  /** Classify a soundtrack into timestamped acoustic events. */
  async events(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('events: <文件> is required')
    const state = audioEventState()
    if (!state.available) throw new Error(state.reason ?? '音频事件检测不可用')
    const { detectAudioEvents } = await import('../core/audio-events.mjs')
    const report = await detectAudioEvents(resolve(target), {
      config: {},
      ...defined({
        start: numberOrUndefined(options.start),
        duration: numberOrUndefined(options.duration),
        topK: numberOrUndefined(options['top-k']),
        minScore: numberOrUndefined(options['min-score']),
        silenceRms: numberOrUndefined(options['silence-rms']),
      }),
      onProgress: (message) => console.error(message),
    })
    if (options.json === true) emit(report)
    else HUMAN.events(report)
    return 0
  },
}

/**
 * Parse one subcommand and run it.
 *
 * @param {string} command - the subcommand.
 * @param {string[]} rest - everything after it.
 * @returns {Promise<{code: number, human: boolean, help: boolean}>} the verdict.
 */
async function handle(command, rest) {
  const handler = COMMANDS[command]
  if (handler === undefined) {
    console.error(`未知命令：${command}（可用：${Object.keys(COMMANDS).join(', ')}）`)
    return { code: 1, human: false, help: false }
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      out: { type: 'string' },
      kind: { type: 'string' },
      seconds: { type: 'string' },
      frequency: { type: 'string' },
      'sweep-to': { type: 'string' },
      'level-dbfs': { type: 'string' },
      'sample-rate': { type: 'string' },
      channels: { type: 'string' },
      seed: { type: 'string' },
      'bit-depth': { type: 'string' },
      clip: { type: 'string', multiple: true },
      total: { type: 'string' },
      tail: { type: 'string' },
      overlap: { type: 'string' },
      method: { type: 'string' },
      'clip-threshold': { type: 'string' },
      'min-clip-samples': { type: 'string' },
      'max-seconds': { type: 'string' },
      'no-timeline': { type: 'boolean' },
      timeline: { type: 'boolean' },
      'noise-db': { type: 'string' },
      'min-seconds': { type: 'string' },
      repair: { type: 'boolean' },
      'repair-path': { type: 'string' },
      'window-seconds': { type: 'string' },
      'fft-size': { type: 'string' },
      'mains-hz': { type: 'string' },
      'max-lag': { type: 'string' },
      windows: { type: 'string' },
      device: { type: 'string' },
      step: { type: 'string', multiple: true },
      codec: { type: 'string' },
      'no-measure': { type: 'boolean' },
      start: { type: 'string' },
      duration: { type: 'string' },
      'top-k': { type: 'string' },
      'min-score': { type: 'string' },
      'silence-rms': { type: 'string' },
      archive: { type: 'string' },
      force: { type: 'boolean' },
      remove: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })

  const options = { ...values }
  if (positionals.length > 0) options.paths = positionals
  if (options.help === true) return { code: 0, human: false, help: true }

  try {
    const code = await handler(options)
    return { code: typeof code === 'number' ? code : 0, human: options.json !== true, help: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`错误：${message}`)
    // A missing file is the common typo, and a message that only says "ffmpeg failed" sends the
    // caller looking in the wrong place, so the resolved path is echoed with its existence.
    const first = options.paths?.[0]
    if (first !== undefined && /找不到|No such file|不存在|读不出/.test(message)) {
      const absolute = resolve(first)
      console.error(`（解析后的路径：${absolute}${existsSync(absolute) ? ' 存在' : ' 不存在'}）`)
    }
    return { code: 1, human: false, help: false }
  }
}

/** Entry point: help, dispatch, then the exit code. */
async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  const outcome = await handle(command, rest)
  if (outcome.help) console.log(USAGE)
  return outcome.code
}

process.exitCode = await main()
