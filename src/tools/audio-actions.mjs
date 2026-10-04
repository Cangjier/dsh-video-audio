/**
 * The `audio_build` / `audio_measure` actions: the builds, repairs, captures and measurements.
 *
 * The handlers are thin on purpose. Each one resolves paths, states the defaults it applied,
 * calls one core function, and returns that function's numbers unchanged. Anything that
 * looks like a decision — which clip goes where, what a noise floor should be, whether a
 * take is usable — is not made here; it is either supplied in the arguments or left as a
 * number in the result.
 *
 * Determinism is reported, not asserted: every result echoes the resolved parameters, the
 * exact filter chain or command where one was used, and what the written file measured.
 *
 * Two tool prefixes live in this one table, because the twelve original actions were split by
 * purpose (`audio_build` makes files, `audio_measure` reads them) and the classifier was added
 * to the measuring half. `TOOL_OF` below is what keeps an error message naming the tool the
 * caller can actually retry.
 *
 * @module dsh-video-audio/tools/audio-actions
 */
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  ANALYSIS_SAMPLE_RATE,
  AudioMeasureError,
  MEASURE_DEFAULTS,
  decodePcm,
  identifyAudio,
  measureLevels,
  measureLoudness,
  measureNoise,
  measureSilences,
} from '../core/audio-measure.mjs'
import { AudioBuildError, assembleAudio, buildTone, measureClips, planPlacements } from '../core/audio-build.mjs'
import { AudioIntegrityError, auditIntegrity } from '../core/audio-integrity.mjs'
import { AudioRestoreError, restoreAudio } from '../core/audio-restore.mjs'
import { AudioRecordError, listCaptureDevices, recordAudio } from '../core/audio-record.mjs'
import {
  AUDIO_TMP_DIR,
  AudioEventError,
  MAX_AUDIO_SECONDS,
  audioEventState,
  detectAudioEvents,
} from '../core/audio-events.mjs'
import { envelopeLag, linearFit, refineLag } from '../core/audio-signal.mjs'
import { AudioPluginError } from './shared.mjs'

/** How loudness may disagree between takes before the report names the outliers, in LU. */
const LOUDNESS_OUTLIER_LU = 2

/** Which tool owns each action, so a refusal can name the call the caller should retry. */
const TOOL_OF = {
  tone: 'audio_build',
  assemble: 'audio_build',
  restore: 'audio_build',
  record: 'audio_build',
  identify: 'audio_measure',
  speech_map: 'audio_measure',
  loudness: 'audio_measure',
  levels: 'audio_measure',
  integrity: 'audio_measure',
  sync: 'audio_measure',
  noise: 'audio_measure',
  devices: 'audio_measure',
  audio_events: 'audio_measure',
  audio_status: 'audio_measure',
}

/**
 * The `audio_build <action>` / `audio_measure <action>` prefix for one action's messages.
 * @param {string} action - the action name.
 * @returns {string} the prefix, without the trailing colon.
 */
const label = (action) => `${TOOL_OF[action] ?? 'audio_measure'} ${action}`

/**
 * Turn a list of path fragments into one filesystem-safe file name.
 * @param {Array<string|number|null|undefined>} parts - fragments, joined by `-`.
 * @returns {string} the name.
 */
function slug(parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && `${part}` !== '')
    .map((part) => `${part}`.replace(/[^0-9A-Za-z._-]+/g, ''))
    .filter((part) => part !== '')
    .join('-')
}

/** Local timestamp for capture file names: captures are takes, and takes must not overwrite. */
function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Build the `audio_build` / `audio_measure` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createAudioActions(config, logger) {
  /**
   * Resolve one required input file, with an actionable message when it is missing.
   * @param {string} value - the argument as given.
   * @param {string} cwd - the working directory.
   * @param {string} action - the action name, for the message.
   * @param {string} field - the argument name, for the message.
   * @returns {string} the absolute path.
   */
  const requireFile = (value, cwd, action, field) => {
    if (typeof value !== 'string' || value === '') {
      throw new AudioPluginError(`${label(action)}: 需要 "${field}"。`)
    }
    const path = resolve(cwd, value)
    if (!existsSync(path)) throw new AudioPluginError(`${label(action)}: 找不到文件 ${path}`)
    return path
  }

  /** Every file a batched action was asked about. */
  const listOf = (args, cwd, action) => {
    const values = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : [args.target]
    const paths = values
      .filter((value) => typeof value === 'string' && value !== '')
      .map((value) => requireFile(value, cwd, action, 'target/paths'))
    if (paths.length === 0) throw new AudioPluginError(`${label(action)}: 需要 "target" 或 "paths"。`)
    return paths
  }

  /** Wrap a core error so the model sees an actionable message rather than a stack. */
  const guard = (action, error) => {
    if (
      error instanceof AudioMeasureError ||
      error instanceof AudioBuildError ||
      error instanceof AudioIntegrityError ||
      error instanceof AudioRestoreError ||
      error instanceof AudioRecordError ||
      error instanceof AudioEventError
    ) {
      return new AudioPluginError(`${label(action)}: ${error.message}`)
    }
    return error
  }

  const audioDir = (cwd) => join(cwd, 'audio')

  return {
    /**
     * Write one test signal whose every parameter is stated.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the artifact and its measurements.
     */
    async tone(args, context) {
      const kind = args.kind ?? 'sine'
      const durationSeconds = Number(args.durationSeconds)
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new AudioPluginError('audio_build tone: 需要 "durationSeconds"（正数，单位秒）。')
      }
      const sampleRate = Number.isFinite(args.sampleRate) ? args.sampleRate : 48_000
      const channels = Number.isFinite(args.channels) ? args.channels : 2
      const levelDbfs = Number.isFinite(args.levelDbfs) ? args.levelDbfs : undefined
      const outPath =
        typeof args.outPath === 'string' && args.outPath !== ''
          ? resolve(context.cwd, args.outPath)
          : join(
              audioDir(context.cwd),
              `${slug([
                'tone',
                kind,
                kind === 'sine' ? `${args.frequencyHz ?? 1000}hz` : kind === 'sweep' ? `${args.frequencyHz ?? 1000}to${args.sweepToHz ?? 20_000}hz` : null,
                `${durationSeconds}s`,
                `${sampleRate}hz`,
                `${channels}ch`,
                kind === 'silence' ? null : `${levelDbfs ?? -3}db`,
                args.bitDepth ?? 's16',
              ])}.wav`,
            )
      try {
        const result = await buildTone({
          request: {
            kind,
            durationSeconds,
            sampleRate,
            channels,
            levelDbfs,
            frequencyHz: args.frequencyHz,
            sweepToHz: args.sweepToHz,
            seed: args.seed,
            bitDepth: args.bitDepth,
            outPath,
          },
          config,
        })
        logger.info(`dsh-video-audio: 生成测试信号 ${basename(outPath)}（${kind}, ${durationSeconds}s）`)
        return { action: 'tone', ...result }
      } catch (error) {
        throw guard('tone', error)
      }
    },

    /**
     * Place clips on a timeline to the sample, then verify what was written.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the artifact, the plan as executed, and the verification.
     */
    async assemble(args, context) {
      const clips = Array.isArray(args.clips) ? args.clips : []
      if (clips.length === 0) {
        throw new AudioPluginError('audio_build assemble: 需要 "clips":[{"source":"...", "at":0}]。')
      }
      const resolvedClips = clips.map((clip, index) => {
        if (clip === null || typeof clip !== 'object') {
          throw new AudioPluginError(`audio_build assemble: clips[${index}] 必须是对象。`)
        }
        const source = requireFile(clip.source, context.cwd, 'assemble', `clips[${index}].source`)
        const at = Number(clip.at)
        if (!Number.isFinite(at) || at < 0) {
          throw new AudioPluginError(`audio_build assemble: clips[${index}].at 必须是非负数（秒）。`)
        }
        const until = clip.until === undefined || clip.until === null ? undefined : Number(clip.until)
        return { source, at, until }
      })

      const sampleRate = Number.isFinite(args.sampleRate) ? Math.round(args.sampleRate) : 48_000
      const channels = Number.isFinite(args.channels) ? Math.round(args.channels) : 2
      const measured = await measureClips(resolvedClips, config)
      if (measured.missing.length > 0) {
        throw new AudioPluginError(
          `audio_build assemble: 这些片段读不出时长（文件损坏或不是音频）：${measured.missing.join(', ')}`,
        )
      }

      const requiredSeconds = measured.clips.reduce(
        (max, clip) => Math.max(max, clip.at + Math.min(clip.until ?? clip.seconds, clip.seconds)),
        0,
      )
      const totalSeconds = Number.isFinite(args.totalSeconds)
        ? Number(args.totalSeconds)
        : requiredSeconds + (Number.isFinite(args.tailSeconds) ? Number(args.tailSeconds) : 0)

      let plan
      try {
        plan = planPlacements({
          clips: measured.clips,
          totalSeconds,
          sampleRate,
          overlap: args.overlap ?? 'reject',
        })
      } catch (error) {
        throw guard('assemble', error)
      }

      const method = args.method ?? (plan.overlaps.length > 0 ? 'mix' : 'concat')
      const outPath =
        typeof args.outPath === 'string' && args.outPath !== ''
          ? resolve(context.cwd, args.outPath)
          : join(audioDir(context.cwd), 'timeline.wav')

      try {
        const result = await assembleAudio({
          plan,
          method,
          channels,
          outPath,
          bitDepth: args.bitDepth,
          config,
        })
        logger.info(
          `dsh-video-audio: 装配音轨 ${basename(outPath)}（${plan.placements.length} 段，${plan.totalSeconds}s，${method}）`,
        )
        return {
          action: 'assemble',
          requestedSeconds: Number(totalSeconds.toFixed(6)),
          requiredSeconds: plan.requiredSeconds,
          overlaps: plan.overlaps,
          methodChosen: method,
          ...result,
        }
      } catch (error) {
        throw guard('assemble', error)
      }
    },

    /**
     * Report what a file claims to be and what it actually delivers.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the report, or one per file.
     */
    async identify(args, context) {
      const paths = listOf(args, context.cwd, 'identify')
      try {
        const reports = []
        for (const path of paths) reports.push(await identifyAudio({ source: path, config }))
        return { action: 'identify', count: reports.length, files: reports }
      } catch (error) {
        throw guard('identify', error)
      }
    },

    /**
     * Find the speech and the silence in a file.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the segment lists and their totals.
     */
    async speech_map(args, context) {
      const target = requireFile(args.target, context.cwd, 'speech_map', 'target')
      const noiseDb = Number.isFinite(args.noiseDb) ? Number(args.noiseDb) : undefined
      const minSeconds = Number.isFinite(args.minSeconds) ? Number(args.minSeconds) : undefined
      try {
        const result = await measureSilences({ source: target, config, noiseDb, minSeconds })
        return {
          action: 'speech_map',
          ...result,
          speechRatio: result.durationSeconds > 0 ? Number((result.speechSeconds / result.durationSeconds).toFixed(4)) : null,
          note:
            'silencedetect 按阈值判定，阈值变了结果就变；thresholdDb 和 minSilenceSeconds 已回显在你的参数里。' +
            '要按声学类别（音乐/语音/环境声）划分，用 audio_measure {action:"audio_events"}。',
        }
      } catch (error) {
        throw guard('speech_map', error)
      }
    },

    /**
     * Measure loudness, optionally across several files at once.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the measurements and, for several files, the spread.
     */
    async loudness(args, context) {
      const paths = listOf(args, context.cwd, 'loudness')
      const wantTimeline = args.timeline === true
      try {
        const files = []
        for (const path of paths) {
          const measured = await measureLoudness({ source: path, config, timeline: wantTimeline })
          files.push({
            source: path,
            integratedLufs: measured.loudness.integratedLufs,
            loudnessRangeLu: measured.loudness.loudnessRangeLu,
            truePeakDbfs: measured.loudness.truePeakDbfs,
            thresholdLufs: measured.loudness.thresholdLufs,
            peakDbfs: measured.stats.overall?.['Peak level dB'] ?? null,
            rmsDbfs: measured.stats.overall?.['RMS level dB'] ?? null,
            dcOffset: measured.stats.overall?.['DC offset'] ?? null,
            noiseFloorDb: measured.stats.overall?.['Noise floor dB'] ?? null,
            decodedSamples: measured.stats.decodedSamples,
            decodeErrors: measured.stats.decodeErrors,
            channels: measured.stats.channels,
            loudestSecond: measured.loudestSecond ?? null,
            quietestSecond: measured.quietestSecond ?? null,
            timeline: measured.timeline ?? null,
          })
        }

        const finite = files.map((file) => file.integratedLufs).filter((value) => Number.isFinite(value))
        const spread = finite.length > 1 ? Number((Math.max(...finite) - Math.min(...finite)).toFixed(2)) : null
        const median = finite.length === 0 ? null : [...finite].sort((a, b) => a - b)[Math.floor(finite.length / 2)]
        const outliers =
          median === null
            ? []
            : files
                .filter((file) => Number.isFinite(file.integratedLufs) && Math.abs(file.integratedLufs - median) > LOUDNESS_OUTLIER_LU)
                .map((file) => ({ source: file.source, integratedLufs: file.integratedLufs, fromMedianLu: Number((file.integratedLufs - median).toFixed(2)) }))
        // A file whose frames are damaged is measured on a timeline with holes in it, so the
        // loudness numbers are not wrong so much as unanswerable. Say so instead of letting the
        // caller compare them with healthy files.
        const damaged = files
          .filter((file) => file.decodeErrors > 0)
          .map((file) => ({ source: file.source, decodeErrors: file.decodeErrors }))

        return {
          action: 'loudness',
          standard: 'EBU R128 (ffmpeg ebur128), integrated I / LRA / true peak',
          count: files.length,
          files,
          spreadLu: spread,
          medianIntegratedLufs: median === null ? null : Number(median.toFixed(2)),
          outliersBeyond: { thresholdLu: LOUDNESS_OUTLIER_LU, files: outliers },
          damagedFiles: damaged,
          note:
            'spreadLu 是同一批文件里最响与最轻的差；outliersBeyond 只是偏离中位数超过阈值的清单，好坏仍由你判断。' +
            (damaged.length === 0
              ? 'loudnorm 会把这个差压掉一部分，但那是动态增益，先逐段对齐电平再接更稳。'
              : '注意 damagedFiles 里有解码报错的文件：它们的帧是缺的，响度与真峰值都是在有洞的时间轴上算出来的，' +
                '先跑 audio_measure {action:"integrity"} 确认文件完整再比较电平。'),
        }
      } catch (error) {
        throw guard('loudness', error)
      }
    },

    /**
     * Report sample-domain facts: peak, RMS, DC, clipping runs, level timeline.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the measurement.
     */
    async levels(args, context) {
      const target = requireFile(args.target, context.cwd, 'levels', 'target')
      try {
        const result = await measureLevels({
          source: target,
          config,
          clipThreshold: Number.isFinite(args.clipThreshold) ? Number(args.clipThreshold) : undefined,
          minClipSamples: Number.isFinite(args.minClipSamples) ? Math.round(Number(args.minClipSamples)) : undefined,
          maxSeconds: Number.isFinite(args.maxSeconds) ? Number(args.maxSeconds) : undefined,
          timeline: args.timeline !== false,
        })
        return {
          action: 'levels',
          ...result,
          note:
            '所有数字都在文件自身的采样率上算，没有重采样，所以削波不会被抹平。' +
            'clipping.runs 只列前 200 段，totalHighSamples 是精确总数。',
        }
      } catch (error) {
        throw guard('levels', error)
      }
    },

    /**
     * Check whether a file is all there, and optionally write a repaired copy.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} declared versus decoded, frame-chain breaks, and any repair.
     */
    async integrity(args, context) {
      const target = requireFile(args.target, context.cwd, 'integrity', 'target')
      const repairPath =
        args.repair === true
          ? typeof args.repairPath === 'string' && args.repairPath !== ''
            ? resolve(context.cwd, args.repairPath)
            : join(dirname(target), `${basename(target, '.mp3')}.repaired.mp3`)
          : undefined
      try {
        const report = await auditIntegrity({
          source: target,
          config,
          repair: args.repair === true,
          repairPath,
        })
        if (args.repair === true && report.repair !== undefined) {
          logger.info(`dsh-video-audio: 已写出修复副本 ${report.repair.path}（删除 ${report.repair.removedGaps} 处缺口）`)
        }
        return { action: 'integrity', ...report }
      } catch (error) {
        throw guard('integrity', error)
      }
    },

    /**
     * Measure the offset and drift between two recordings of the same audio.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the offset, the per-window lags and the drift.
     */
    async sync(args, context) {
      const reference = requireFile(args.reference, context.cwd, 'sync', 'reference')
      const comparison = requireFile(args.comparison, context.cwd, 'sync', 'comparison')
      const sampleRate = ANALYSIS_SAMPLE_RATE
      const maxLagSeconds = Number.isFinite(args.maxLagSeconds) ? Number(args.maxLagSeconds) : 5
      const maxSeconds = Number.isFinite(args.maxSeconds) ? Number(args.maxSeconds) : 300
      const windows = Number.isFinite(args.windows) ? Math.max(1, Math.round(Number(args.windows))) : 5

      try {
        const [a, b] = [
          await decodePcm({ source: reference, config, sampleRate, channels: 1, duration: maxSeconds }),
          await decodePcm({ source: comparison, config, sampleRate, channels: 1, duration: maxSeconds }),
        ]
        const common = Math.min(a.frames, b.frames)
        if (common < sampleRate * 2) {
          throw new AudioPluginError('audio_measure sync: 两个文件重叠部分不足 2 秒，无法比较。')
        }
        const coarse = envelopeLag(a.samples, b.samples, sampleRate, { maxLagSeconds })
        if (coarse === null) throw new AudioPluginError('audio_measure sync: 两段音频太短或没有可对齐的共同结构。')
        const refined = refineLag(a.samples, b.samples, coarse.lagSeconds, sampleRate, 0.5)

        const perWindow = []
        const windowSeconds = common / sampleRate / windows
        for (let index = 0; index < windows; index += 1) {
          const from = index * windowSeconds
          const to = (index + 1) * windowSeconds
          const start = Math.round(from * sampleRate)
          const end = Math.round(to * sampleRate)
          const sliceA = a.samples.subarray(start, end)
          const sliceB = b.samples.subarray(start, end)
          const window = refineLag(sliceA, sliceB, refined.lagSeconds, sampleRate, 0.25)
          perWindow.push({
            fromSeconds: Number(from.toFixed(3)),
            toSeconds: Number(to.toFixed(3)),
            offsetSeconds: window.lagSeconds,
            correlation: window.correlation,
          })
        }
        const fit = linearFit(
          perWindow.map((entry) => (entry.fromSeconds + entry.toSeconds) / 2),
          perWindow.map((entry) => entry.offsetSeconds),
        )

        return {
          action: 'sync',
          reference,
          comparison,
          sampleRate,
          analysedSeconds: Number((common / sampleRate).toFixed(3)),
          offsetSeconds: refined.lagSeconds,
          correlation: refined.correlation,
          offsetMeaning:
            '正值表示 comparison 比 reference 晚（同一句话在 comparison 里出现得更迟）；负值表示它更早。',
          coarse: { offsetSeconds: coarse.lagSeconds, correlation: coarse.correlation, envelopeRate: coarse.envelopeRate },
          windows: perWindow,
          drift:
            fit === null
              ? null
              : {
                  secondsPerSecond: Number(fit.slope.toExponential(4)),
                  ppm: Number((fit.slope * 1e6).toFixed(2)),
                  windows: fit.samples,
                  meaning: 'ppm 是每百万秒的漂移；剪辑里 100 ppm 相当于 2 分钟偏 12 毫秒。',
                },
          note:
            '对的是包络（语音的起止形状），不是波形：两份文件经过不同编码、不同噪声，波形相关没有意义。' +
            '相关性低于 0.3 时这个偏移不可信，别照着它改时间轴。',
        }
      } catch (error) {
        throw guard('sync', error)
      }
    },

    /**
     * Report what a file's noise floor is made of.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the floor, the hum families, the tilt and the tonal peaks.
     */
    async noise(args, context) {
      const target = requireFile(args.target, context.cwd, 'noise', 'target')
      try {
        const result = await measureNoise({
          source: target,
          config,
          mainsHz: Number.isFinite(args.mainsHz) ? Number(args.mainsHz) : undefined,
          fftSize: Number.isFinite(args.fftSize) ? Math.round(Number(args.fftSize)) : undefined,
          windowSeconds: Number.isFinite(args.windowSeconds) ? Number(args.windowSeconds) : undefined,
        })
        return {
          action: 'noise',
          ...result,
          defaults: {
            mainsHz: MEASURE_DEFAULTS.mainsHz,
            fftSize: MEASURE_DEFAULTS.fftSize,
            windowSeconds: MEASURE_DEFAULTS.windowSeconds,
          },
          note:
            'hum 表按工频的整数倍列出每个谐波的 dBFS（Goertzel，逐频精确），dominantFamilyHz 是两族能量更大的一族。' +
            'spectrum 取自最安静的那个窗口：在有人说话的窗口里量噪声，量到的是人声。',
        }
      } catch (error) {
        throw guard('noise', error)
      }
    },

    /**
     * Apply an explicit restoration chain and measure what changed.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the artifact, the chain, and the before/after numbers.
     */
    async restore(args, context) {
      const source = requireFile(args.target ?? args.source, context.cwd, 'restore', 'target')
      const steps = Array.isArray(args.steps) ? args.steps : []
      const codec = args.codec ?? 'pcm_s16le'
      const extension = codec === 'aac' ? 'm4a' : 'wav'
      const outPath =
        typeof args.outPath === 'string' && args.outPath !== ''
          ? resolve(context.cwd, args.outPath)
          : join(audioDir(context.cwd), `${basename(source).replace(/\.[^.]+$/, '')}.restored.${extension}`)
      try {
        const result = await restoreAudio({
          source,
          steps,
          outPath,
          codec,
          sampleRate: Number.isFinite(args.sampleRate) ? Number(args.sampleRate) : undefined,
          channels: Number.isFinite(args.channels) ? Number(args.channels) : undefined,
          mainsHz: Number.isFinite(args.mainsHz) ? Number(args.mainsHz) : undefined,
          measure: args.measure !== false,
          config,
        })
        logger.info(`dsh-video-audio: 修复音频写出 ${basename(outPath)}（${result.filters.length} 个滤波器）`)
        return { action: 'restore', ...result }
      } catch (error) {
        throw guard('restore', error)
      }
    },

    /**
     * List the capture devices this machine reports.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the devices and the exact names to use.
     */
    async devices(args, context) {
      try {
        const result = await listCaptureDevices({ config })
        return {
          action: 'devices',
          ...result,
          usage: '把 audio[i].name 原样传给 action:"record" 的 "device"（含括号与空格）；alternative 是本机语言无关的稳定标识。',
        }
      } catch (error) {
        throw guard('devices', error)
      }
    },

    /**
     * Record a fixed number of seconds from one named device and measure the take.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the artifact and the measurements.
     */
    async record(args, context) {
      const seconds = Number(args.seconds)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new AudioPluginError('audio_build record: 需要 "seconds"（要录多少秒）。先用 action:"devices" 列设备。')
      }
      const outPath =
        typeof args.outPath === 'string' && args.outPath !== ''
          ? resolve(context.cwd, args.outPath)
          : join(audioDir(context.cwd), `record-${stamp()}.wav`)
      mkdirSync(dirname(outPath), { recursive: true })
      try {
        const result = await recordAudio({
          device: args.device,
          seconds,
          outPath,
          sampleRate: Number.isFinite(args.sampleRate) ? Number(args.sampleRate) : undefined,
          channels: Number.isFinite(args.channels) ? Number(args.channels) : undefined,
          rtBufferMb: Number.isFinite(args.rtBufferMb) ? Number(args.rtBufferMb) : undefined,
          measure: args.measure !== false,
          config,
        })
        logger.info(`dsh-video-audio: 录音完成 ${basename(outPath)}（${result.measuredSeconds}s）`)
        return { action: 'record', ...result }
      } catch (error) {
        throw guard('record', error)
      }
    },

    /**
     * Classify a soundtrack into timestamped acoustic events.
     *
     * "duration" here means how much of the file to analyse, not how long the file is. That
     * inversion is the one argument in this family with two readings, and it is the reason the
     * schema spells it out: the caller who wanted the first ten seconds and got "the file is ten
     * seconds long" has no way to notice.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the segment report.
     */
    async audio_events(args, context) {
      const target = requireFile(args.target, context.cwd, 'audio_events', 'target')
      try {
        const report = await detectAudioEvents(target, {
          config,
          start: Number.isFinite(args.start) ? args.start : undefined,
          duration: Number.isFinite(args.duration) ? args.duration : undefined,
          topK: Number.isFinite(args.topK) ? args.topK : undefined,
          minScore: Number.isFinite(args.minScore) ? args.minScore : undefined,
          silenceRms: Number.isFinite(args.silenceRms) ? args.silenceRms : undefined,
          onProgress: (progress) => {
            if (progress.done % 25 === 0 || progress.done === progress.total) {
              logger.info(`dsh-video-audio: 音频分类 ${progress.done}/${progress.total}`)
            }
          },
        })
        if (args.includeSegments === false) {
          const { segments, ...rest } = report
          return { action: 'audio_events', ...rest, segmentCount: segments.length }
        }
        return { action: 'audio_events', ...report }
      } catch (error) {
        // The core refuses anything longer than MAX_AUDIO_SECONDS. Its own message names the
        // limit; naming the call that fixes it is what turns a refusal into a next step, and the
        // plugin deliberately does not choose the split points itself.
        if (error instanceof AudioEventError && /超过上限/.test(error.message)) {
          throw new AudioPluginError(
            `audio_measure audio_events: ${error.message}` +
              `单次分析的硬上限是 ${MAX_AUDIO_SECONDS} 秒（${Math.round(MAX_AUDIO_SECONDS / 60)} 分钟）：` +
              '请用 audio_measure {action:"audio_events", target, start, duration} 分段调用，切在哪里由你决定。',
          )
        }
        throw guard('audio_events', error)
      }
    },

    /**
     * Report whether the audio event model is installed, without analysing anything.
     * @returns {object} the state, plus where to install it and where scratch files go.
     */
    async audio_status() {
      return {
        action: 'audio_status',
        ...audioEventState(),
        tmpDir: AUDIO_TMP_DIR,
        installWith: 'audio_setup {action:"install"}',
      }
    },
  }
}
