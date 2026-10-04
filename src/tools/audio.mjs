/**
 * The four `audio_*` tools: sound, split by what you are doing with it.
 *
 * The family used to be one tool with twelve actions and thirty-eight arguments. It was
 * coherent in intent and incoherent as a choice: "write a test tone" and "find the offset
 * between two recordings" sat in one enum, and every argument of every action was declared
 * whatever the caller picked. Splitting it by purpose — one tool that MAKES and REPAIRS
 * sound, one that MEASURES it, one that changes what is on disk, one that explains the
 * surface — means the tool name carries the intent, each schema declares only the arguments
 * its own actions read, and no enum is a menu of unrelated jobs.
 *
 * The division:
 *
 * - **audio_build** — `tone` writes a signal whose every parameter is stated; `assemble` places
 *   clips on a timeline to the sample and verifies the file it wrote; `restore` applies an
 *   explicit chain and re-measures; `record` captures a fixed length from a named device.
 * - **audio_measure** — `identify` reports declared against decoded reality; `speech_map` finds
 *   the speech and the silence; `loudness`, `levels`, `integrity` and `sync` each answer one
 *   question with numbers and no verdict; `noise` says what the noise floor is made of;
 *   `devices` lists the capture hardware; `audio_events` classifies the soundtrack into
 *   AudioSet classes; `audio_status` reports whether that classifier is installed.
 * - **audio_setup** — install, remove and status of the shared model and runtime. Kept apart
 *   from the measurements because one downloads 28 MB and the other is free.
 * - **audio_guide** — the on-demand reference, rendered from the same registry these schemas
 *   are built from.
 *
 * None of them decides anything. They produce files, numbers and lists, and the reading of
 * those stays with DSH.
 *
 * @module dsh-video-audio/tools/audio
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'
import { GUIDE_ACTIONS, createGuideTool } from './guide.mjs'

/** Every action of the build tool, in dispatch order. */
export const AUDIO_BUILD_ACTIONS = ['tone', 'assemble', 'restore', 'record']

/** Every action of the measure tool, in dispatch order. */
export const AUDIO_MEASURE_ACTIONS = [
  'identify',
  'speech_map',
  'loudness',
  'levels',
  'integrity',
  'sync',
  'noise',
  'devices',
  'audio_events',
  'audio_status',
]

/** Every action the two sound tools expose between them. */
export const AUDIO_ACTIONS = [...AUDIO_BUILD_ACTIONS, ...AUDIO_MEASURE_ACTIONS]

/** Every action of the provisioning tool, in dispatch order. */
export const SETUP_ACTIONS = ['status', 'install', 'remove']

export const AUDIO_BUILD_TOOL_NAME = 'audio_build'
export const AUDIO_MEASURE_TOOL_NAME = 'audio_measure'
export const AUDIO_SETUP_TOOL_NAME = 'audio_setup'

export { GUIDE_ACTIONS, createGuideTool }

/** Arguments used by more than one tool, declared once so the schemas cannot drift. */
const SHARED = {
  cwd: CWD_PROPERTY,
}

/**
 * Build the `audio_build` tool.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createAudioBuildTool(actions) {
  return defineFamilyTool({
    name: AUDIO_BUILD_TOOL_NAME,
    actions: AUDIO_BUILD_ACTIONS,
    extraProperties: {
      kind: {
        type: 'string',
        enum: ['sine', 'sweep', 'silence', 'white', 'pink', 'brown'],
        description: 'tone: which signal to generate. Default "sine".',
      },
      durationSeconds: {
        type: 'number',
        description:
          'tone: how many seconds of signal to write. Required, and it is the one argument with no default — a test signal whose length is guessed is not a reference.',
      },
      frequencyHz: {
        type: 'number',
        description: 'tone: tone frequency, or the start frequency of a sweep. Default 1000. Must be below Nyquist.',
      },
      sweepToHz: {
        type: 'number',
        description: 'tone: end frequency of a linear sweep. Default 20000.',
      },
      seed: {
        type: 'integer',
        description: 'tone: noise seed for white/pink/brown. Default 1; it is what makes a noise request reproducible.',
      },
      levelDbfs: {
        type: 'number',
        description: 'tone: nominal level of the generated signal in dBFS. Default -3, which leaves true-peak headroom.',
      },
      bitDepth: {
        type: 'string',
        enum: ['s16', 's24', 'f32'],
        description: 'tone / assemble: sample format of the written WAV. Default "s16".',
      },
      clips: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            source: { type: 'string' },
            at: { type: 'number' },
            until: { type: 'number' },
          },
          required: ['source', 'at'],
        },
        description:
          'assemble: the clips. Each is {source, at} where "at" is the start time in seconds; add "until" to use only the first part of that clip (which is how a trailing silence gets cut).',
      },
      totalSeconds: {
        type: 'number',
        description:
          'assemble: how long the result should be. Default: exactly as long as the last clip ends, plus tailSeconds.',
      },
      tailSeconds: {
        type: 'number',
        description: 'assemble: extra room after the last clip when totalSeconds is not given. Default 0.',
      },
      overlap: {
        type: 'string',
        enum: ['reject', 'sum'],
        description:
          'assemble: what to do when two clips overlap in time. "reject" (default) refuses the plan and names the overlaps; "sum" mixes them, which is almost always two people talking at once, so it must be asked for. Do not combine "sum" with an explicit method:"concat": the clips then land at the previous clip\'s end instead of "at".',
      },
      method: {
        type: 'string',
        enum: ['concat', 'mix'],
        description:
          'assemble: "concat" (default when nothing overlaps) builds one continuous stream and is sample-exact; "mix" sums clips and is what overlapping clips require.',
      },
      sampleRate: {
        type: 'number',
        description: 'tone / assemble / record: sample rate. Default 48000 for both builds and capture.',
      },
      channels: {
        type: 'number',
        description: 'tone / assemble / record: channel count, 1 or 2. Default 2 for builds, 1 for capture.',
      },
      target: {
        type: 'string',
        description: 'restore: the audio or video file to clean.',
      },
      source: {
        type: 'string',
        description: 'restore: an accepted alias for "target", kept because the two names were used interchangeably.',
      },
      steps: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description:
          'restore: the chain, in order. Each step is {method, ...parameters}: denoise {noiseFloorDb|trackNoise, noiseReductionDb, noiseType}; dehum {mainsHz, harmonics, widthHz}; notch {frequencyHz, widthHz}; gate {thresholdDb, rangeDb, ratio, attackMs, releaseMs}; highpass/lowpass {frequencyHz, poles}. There is no gain or normalisation step.',
      },
      codec: {
        type: 'string',
        enum: ['pcm_s16le', 'pcm_f32le', 'aac'],
        description: 'restore: output codec. Default pcm_s16le (WAV). aac writes an .m4a at 192 kbps.',
      },
      measure: {
        type: 'boolean',
        description:
          'restore / record: measure before and after, and report what changed. Default true; false removes the only evidence the work helped.',
      },
      outPath: {
        type: 'string',
        description:
          'tone / assemble / restore / record: where to write. Defaults to a name derived from the parameters under <cwd>/audio/, and for assemble that default silently overwrites the previous timeline.',
      },
      device: {
        type: 'string',
        description: 'record: the capture device name exactly as audio_measure {action:"devices"} lists it.',
      },
      seconds: {
        type: 'number',
        description: 'record: how many seconds to record. Required; at most 3600, and the process is killed twenty seconds after that.',
      },
      rtBufferMb: {
        type: 'number',
        description: 'record: DirectShow real-time buffer in MB. Default 64; raise it if samples are dropped.',
      },
      mainsHz: {
        type: 'number',
        enum: [50, 60],
        description: 'restore: the mains frequency to notch out, with the harmonics the dehum step is asked for. Default 50.',
      },
      cwd: SHARED.cwd,
    },
    handlers: actions,
  })
}

/**
 * Build the `audio_measure` tool.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createAudioMeasureTool(actions) {
  return defineFamilyTool({
    name: AUDIO_MEASURE_TOOL_NAME,
    actions: AUDIO_MEASURE_ACTIONS,
    extraProperties: {
      target: {
        type: 'string',
        description:
          'identify / speech_map / loudness / levels / integrity / sync / noise / audio_events: the audio or video file to measure — the single-file argument nearly every measure action reads. The exception is sync, which takes two files, as "reference" and "comparison".',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'identify / loudness: several files to measure in one call. loudness additionally reports the spread between them, which is how inconsistent takes become visible.',
      },
      noiseDb: {
        type: 'number',
        description: 'speech_map: level below which audio counts as silence, in dB. Default -40.',
      },
      minSeconds: {
        type: 'number',
        description: 'speech_map: shortest silence worth reporting, in seconds. Default 0.25.',
      },
      clipThreshold: {
        type: 'number',
        description: 'levels: amplitude counting as clipped, 0..1. Default 0.999.',
      },
      minClipSamples: {
        type: 'number',
        description: 'levels: shortest run of clipped samples worth listing. Default 3; shorter runs still count in the total.',
      },
      maxSeconds: {
        type: 'number',
        description:
          'levels / sync: analyse at most this many seconds. Default 600 for levels, which means clipping after the tenth minute goes unseen.',
      },
      timeline: {
        type: 'boolean',
        description:
          'levels / loudness: include the level-over-time series. levels defaults to true (set false to skip a long series); loudness defaults to false.',
      },
      repair: {
        type: 'boolean',
        description:
          'integrity: also write a repaired copy of a file whose MPEG frame chain has narrow gaps. The original is never modified; wide damage is refused rather than guessed at.',
      },
      repairPath: {
        type: 'string',
        description: 'integrity: where to write the repaired copy. Required when repair is true.',
      },
      reference: {
        type: 'string',
        description: 'sync: the file that is taken as correct, for example the assembled voice track.',
      },
      comparison: {
        type: 'string',
        description: 'sync: the file to compare against the reference, for example an exported mixdown or the camera audio.',
      },
      maxLagSeconds: {
        type: 'number',
        description:
          'sync: search this far either side of zero. Default 5, which implicitly requires about ten seconds of genuinely common material even though the guard only demands two.',
      },
      windows: {
        type: 'number',
        description: 'sync: how many windows to measure across the file; more than one turns the offsets into a drift estimate. Default 5.',
      },
      mainsHz: {
        type: 'number',
        enum: [50, 60],
        description:
          'noise: the mains frequency to look for. Default 50. Both the 50Hz and 60Hz families are always measured, so this only labels the request.',
      },
      fftSize: {
        type: 'number',
        description: 'noise: FFT size for the spectrum, a power of two. Default 8192.',
      },
      windowSeconds: {
        type: 'number',
        description:
          'noise: length of the analysis window. Default 30; smaller windows follow a changing floor better. The value echoed back in defaults is 60 and is wrong — trust the measured windowSeconds.',
      },
      start: {
        type: 'number',
        description: 'audio_events: analyse only from this second onwards.',
      },
      duration: {
        type: 'number',
        description:
          'audio_events: analyse only this many seconds, starting at "start" — it is how much to read, NOT the length of the file. This is the only action that reads it: identify / speech_map / loudness / levels / integrity / noise always read the whole file (levels has its own maxSeconds). Omit it to analyse everything; use start + duration to walk a long file in pieces.',
      },
      topK: {
        type: 'number',
        description: 'audio_events: how many labels to keep per segment. Default 3.',
      },
      minScore: {
        type: 'number',
        description: 'audio_events: score below which a label is dropped entirely. Default 0.1.',
      },
      silenceRms: {
        type: 'number',
        description:
          'audio_events: segments quieter than this root-mean-square level are reported as silent instead of classified. Default 0.002.',
      },
      includeSegments: {
        type: 'boolean',
        description:
          'audio_events: include the per-segment labels in the result. Default true; set false for just the grouped label-to-timestamps map and a segment count.',
      },
      cwd: SHARED.cwd,
    },
    handlers: actions,
  })
}

/**
 * Build the `audio_setup` tool.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createSetupTool(actions) {
  return defineFamilyTool({
    name: AUDIO_SETUP_TOOL_NAME,
    actions: SETUP_ACTIONS,
    extraProperties: {
      force: {
        type: 'boolean',
        description:
          'install: re-fetch even when a verified copy exists; the only way out of a half-unpacked vendor/audio tree, which otherwise makes every later install skip itself.',
      },
      archive: {
        type: 'string',
        description:
          'install: use a local model file instead of downloading it — the YAMNet .onnx, or a directory holding the model and its class map. Use it when the host serving the weights is slow or blocked: the file arrives by whatever means and its pinned SHA-256 is still checked. Resolved against the process working directory, not against "cwd".',
      },
    },
    handlers: actions,
  })
}
