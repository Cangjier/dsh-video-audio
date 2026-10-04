/**
 * The deterministic core, re-exported.
 *
 * Nothing here knows that DSH exists. Every module below is plain ESM over ffmpeg and the file
 * system, which is what lets the whole plugin be unit-tested with `node --test` and reasoned about
 * without a host: same input, same output, except for the one action that captures a room.
 *
 * @module dsh-video-audio/core
 */

export {
  AUDIO_DIR_ENV,
  FFMPEG_ENV,
  FFPROBE_ENV,
  PLUGIN_ROOT,
  audioDirCandidates,
  audioDirCandidatesWithSource,
  findBinary,
  resolveAudioDir,
  resolveBinary,
  resolveCwd,
  setConfiguredAudioDir,
  versionOf,
} from './env.mjs'

export {
  FFmpegError,
  FFmpegNotFound,
  fileExists,
  probeBinaries,
  resetToolCache,
  resolveTool,
  run,
  runProbe,
} from './ffmpeg.mjs'

export { ProbeError, classify, isStill, parseRational, probe, probeMany, rotationOf, streamProblems } from './probe.mjs'

export {
  amplitudeFromDb,
  bandwidthOf,
  clipRuns,
  crestFactorDb,
  dbFromAmplitude,
  dcOffsetOf,
  envelopeDb,
  envelopeLag,
  fftInPlace,
  float32FromBuffer,
  goertzelAmplitude,
  goertzelDb,
  linearFit,
  loudestChannel,
  peakOf,
  refineLag,
  rmsOf,
  spectrumOf,
  tiltOf,
  tonalPeaks,
} from './audio-signal.mjs'

export {
  ANALYSIS_SAMPLE_RATE,
  AudioMeasureError,
  DEFAULT_WINDOW_SECONDS,
  MAX_PCM_BYTES,
  MEASURE_DEFAULTS,
  SPECTRUM_SAMPLE_RATE,
  TILT_BANDS,
  decodePcm,
  describeAudio,
  identifyAudio,
  measureLevels,
  measureLoudness,
  measureNoise,
  measureSilences,
  parseAstats,
  parseEbur128,
  parseFfmpegInput,
  runAstats,
  runAudio,
  scanPcm,
  sniffContainer,
  sniffContainerBytes,
} from './audio-measure.mjs'

export {
  ASSEMBLE_METHODS,
  ASSEMBLE_SAMPLE_TOLERANCE,
  AudioBuildError,
  DEFAULT_NOISE_SEED,
  DEFAULT_TONE_LEVEL_DBFS,
  OVERLAP_POLICIES,
  TONE_KINDS,
  amplitudeOfLevel,
  assembleAudio,
  assembleGraph,
  buildTone,
  layoutOf,
  levelOfAmplitude,
  measureClips,
  planPlacements,
  toneArguments,
} from './audio-build.mjs'

export {
  AudioIntegrityError,
  MAX_AUDIT_BYTES,
  MAX_LEADING_BYTES,
  auditIntegrity,
  findFirstFrame,
  id3TagSize,
  mpegFrameAt,
  repairMpegFrames,
  walkMpegFrames,
} from './audio-integrity.mjs'

export {
  AudioRestoreError,
  MAINS_FREQUENCIES,
  RESTORE_CODECS,
  RESTORE_METHODS,
  restoreAudio,
  restoreChain,
  restoreStep,
} from './audio-restore.mjs'

export {
  AudioRecordError,
  RECORD_DEADLINE_SLACK_SECONDS,
  RECORD_DEFAULTS,
  listCaptureDevices,
  parseDeviceList,
  recordArguments,
  recordAudio,
} from './audio-record.mjs'

export { parseSilences } from './audio-silence.mjs'

export {
  AUDIO_MANIFEST,
  AUDIO_TMP_DIR,
  AUDIO_VENDOR_DIR,
  AudioEventError,
  DEFAULT_MIN_SCORE,
  DEFAULT_SILENCE_RMS,
  DEFAULT_TOP_K,
  MAX_AUDIO_SECONDS,
  ORT_WASM_BINARY,
  ORT_WASM_ENTRY,
  YAMNET_CLASS_MAP,
  YAMNET_HOP,
  YAMNET_MODEL,
  YAMNET_SAMPLE_RATE,
  YAMNET_WINDOW,
  audioEventState,
  audioPaths,
  classifySamples,
  decodeWav,
  detectAudioEvents,
  disposeAudioSession,
  extractAudio,
  groupEvents,
  loadSession,
  readAudioManifest,
  readClassMap,
  rms,
  topLabels,
  windowsOf,
} from './audio-events.mjs'

export {
  AUDIO_MODEL,
  AUDIO_RUNTIME_PACKAGES,
  AUDIO_SCRATCH_DIR,
  adoptSiblingAudio,
  audioInstallState,
  extractRuntimePackage,
  installAudio,
  removeAudio,
  runtimePackageDir,
  sha256File,
  sriOf,
  vendoredAudioFiles,
  verifyInstalledAudio,
  writeAudioManifest,
} from './audio-install.mjs'

export { InstallError, download, httpFetch, installFfmpeg, sha256Of, vendoredState } from './install.mjs'
