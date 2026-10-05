/**
 * Every `audio_*` tool and action this plugin exposes, documented once.
 *
 * **This file is the single source of prose about the tool surface.** The resident JSON Schema and
 * the on-demand `audio_guide` are both derived from it, so a description that says one thing in a
 * schema and another in the guide is impossible rather than merely unlikely. That matters here more
 * than usual, because almost every result of this plugin is a number somebody will act on.
 *
 * Five rules shape what is written below:
 *
 * 1. **The resident schema carries only what choosing needs** — what the action produces, what it
 *    requires, the mistake it prevents, when it is the right call. Everything long is one
 *    `audio_guide` call away.
 * 2. **A measurement never changes the file.** Everything that reads is separated from everything
 *    that writes, and the writing actions say what they wrote and re-measure it.
 * 3. **No verdicts.** The words "good", "too loud" and "clean enough" do not appear in a result.
 *    Thresholds are arguments and are echoed back, so a surprising number is traceable to the
 *    parameter that produced it.
 * 4. **Non-determinism is named.** `record` captures a room, and `audio_events` runs a model; every
 *    other action is the same input for the same output.
 * 5. **A capability this plugin does not have must say so.** Where a neighbouring plugin does the
 *    job better — transcription, loudness normalisation, the film mix — the entry names it instead
 *    of implying this one covers it.
 *
 * Field contract per action:
 *   summary   one line, what it produces or answers (shown in the schema)
 *   use       when to reach for it (shown in the schema)
 *   avoid     the mistake it prevents, or the better alternative (shown when short)
 *   required  argument names the caller must supply beyond `action`
 *   returns   the shape and meaning of the result
 *   cost      time / network / model / install requirement, from the code
 *   gotchas   things that silently produce a wrong-looking result
 *   example   a minimal, runnable argument object
 *   seeAlso   actions normally chained with it
 *
 * @module dsh-video-audio/tools/registry
 */

/**
 * The tool surface, in the order it is presented.
 * @type {string[]}
 */
export const TOOL_ORDER = ['audio_build', 'audio_measure', 'audio_setup', 'audio_guide']

/**
 * Tool and action documentation.
 * @type {Record<string, {purpose: string, use: string[], avoid: string[], needs: string[], next: string[], actions: Record<string, object>}>}
 */
export const REGISTRY = {
  audio_build: {
    purpose:
      'Produce and repair audio with every parameter stated: a deterministic test signal, a timeline assembled to the sample, an explicit restore chain that is re-measured after it runs, and a fixed-length capture from a named device.',
    use: [
      'to build a reference signal or a soundtrack whose exact parameters are known rather than assumed',
      'to place clips on a timeline without millisecond guessing, and to prove where they landed',
      'to clean a take with a chain you chose and see what it changed',
    ],
    avoid: [
      'nothing here judges how anything sounds: the verdicts live in audio_measure',
      'record is the only non-deterministic action in this family, and the room is why',
    ],
    needs: ['ffmpeg', 'a capture device for record (list them with audio_measure {action:"devices"})'],
    next: ['audio_measure to measure what came out', 'video_plan to put the result in the film'],
    actions: {
      tone: {
        summary:
          'write a test signal — sine, linear sweep, digital silence, white/pink/brown noise — at a stated duration, sample rate, channel count and level; the noise seed is fixed, so the same request produces the same bytes.',
        use: 'for a reference tone, a silent bed, a measuring signal, or a known-good input to test the rest of the chain.',
        avoid: 'do not use it as music: it is a signal, not a soundtrack.',
        required: ['durationSeconds'],
        returns: '{ path, durationSeconds, sampleRate, channels, levelDbfs, verified{...} } — the written file is read back and its sample count compared.',
        cost: 'instant: one ffmpeg synthesis, no decode of anything else.',
        gotchas: [
          'durationSeconds is the one mandatory argument and it is not inferable: the action refuses without it.',
          'Noise is only reproducible with a fixed seed; the default seed is 1, and changing it changes the bytes.',
          'levelDbfs is applied inside the generator so the stated level is the level that lands, which is what makes it usable as a reference.',
        ],
        example: { action: 'tone', kind: 'sine', durationSeconds: 10, frequencyHz: 1000, levelDbfs: -3 },
        seeAlso: ['assemble', 'audio_measure'],
      },
      assemble: {
        summary:
          'place audio clips on one timeline at sample-exact offsets and report the file it wrote, checked by decoding; overlap is either refused or summed, never silently tolerated.',
        use: 'whenever several takes have to become one track: narration plus bed, or a stitched voice track.',
        avoid: 'do not concatenate files or mix with millisecond delays by hand: this is the sample-exact route, and it verifies itself.',
        required: ['clips'],
        returns: '{ path, placements[], verification{ exact, measured[] }, manifestPath }',
        cost: 'one build pass plus one decode pass for verification: seconds for minutes of audio.',
        gotchas: [
          'overlap defaults to "reject" and names the overlapping pairs; "sum" mixes them, which is almost always two people talking at once.',
          'Do not combine overlap:"sum" with an explicit method:"concat": the clips then land at the previous clip\'s end instead of the requested at, and the verification can still say the result is exact.',
          'Overlap detection only compares neighbours after sorting, so a clip nested inside two others can go unreported.',
          'Without outPath it writes and OVERWRITES <cwd>/audio/timeline.wav every time.',
        ],
        example: { action: 'assemble', clips: [{ source: 'vo.mp3', at: 0 }, { source: 'bed.wav', at: 2, until: 8 }], totalSeconds: 20 },
        seeAlso: ['tone', 'audio_measure'],
      },
      restore: {
        summary:
          'apply an explicit chain — denoise, dehum, notch, gate, highpass, lowpass — with every parameter stated, then measure the written file and report what actually changed.',
        use: 'when a take has a known defect: hiss, mains hum, rumble, or a noise floor that has to come down before mixing.',
        avoid: 'it makes no decisions: if you do not know which defect you have, measure first with noise and levels.',
        required: ['target (source is accepted as an alias)'],
        returns: '{ path, chain[], before{...}, after{...}, change{...} } — the same measurements on both sides of the chain.',
        cost: 'one filter pass plus two measurement passes.',
        gotchas: [
          'There is no gain or loudness step here: normalising is video_render {action:"finalize"} or an explicit filter in the chain.',
          'The documented arnndn/model method does not exist in the code; RESTORE_METHODS is the list above.',
          'measure:false skips the before/after numbers, which removes the only evidence the chain helped.',
        ],
        example: {
          action: 'restore',
          target: 'take.wav',
          steps: [{ method: 'dehum', mainsHz: 50, harmonics: 4 }, { method: 'highpass', frequencyHz: 80 }],
          outPath: 'take-clean.wav',
        },
        seeAlso: ['noise', 'levels', 'identify'],
      },
      record: {
        summary:
          'record a fixed number of seconds from one named device and measure the take — length error, level, noise floor, hum.',
        use: 'when audio has to come from a real microphone, and a measured take is wanted rather than a raw file.',
        avoid: 'do not record more than you need: this runs in real time and the process is killed at seconds+20.',
        required: ['device', 'seconds'],
        returns: '{ path, seconds, measured{ durationErrorSeconds, peakDbfs, dcOffset, noiseFloorDbfs, mainsHz } }',
        cost: 'real time: sixty seconds of audio costs sixty seconds of wall clock, plus the measurement passes.',
        gotchas: [
          'This is the family\'s one non-deterministic action: the room decides what arrives.',
          'The device name must be exactly what devices lists; a near miss is a different device or nothing.',
          'Samples dropped under load are a real failure mode: raise rtBufferMb when the take measures short.',
        ],
        example: { action: 'record', device: 'Microphone (USB Audio)', seconds: 30, outPath: 'take.wav' },
        seeAlso: ['devices', 'noise', 'loudness'],
      },
    },
  },

  audio_measure: {
    purpose:
      'Answer the questions that come before and after a mix, with numbers and no verdicts: is this file all there, what is its noise floor made of, where exactly is the speech, how loud is it, how far apart are two takes of the same performance, and what does the soundtrack sound like.',
    use: [
      'before restoring anything: every restore method needs to know which defect is actually present',
      'before the final mix, and after it, to prove the levels and the loudness are where they were meant to be',
      'to find the speech inside a long recording, and to line up two recordings of the same material',
      'to find the music, the applause or the silence in a soundtrack, which is how a cut is placed on the beat',
    ],
    avoid: [
      'it produces measurements, never judgements: reading them is the caller\'s job',
      'loudness and levels are different questions: EBU R128 loudness units versus raw sample-domain amplitude',
    ],
    needs: [
      'ffmpeg; no network, no API key',
      'the YAMNet model only for audio_events, which is optional: audio_status says whether it is installed and audio_setup {action:"install"} fetches it',
    ],
    next: ['audio_build {action:"restore"} to act on a measured defect', 'video_render {action:"finalize"} for the film mix'],
    actions: {
      identify: {
        summary:
          'what a file claims versus what it delivers — container, codec, declared duration against decoded sample count, decode errors, effective bandwidth and spectral tilt.',
        use: 'as the first look at any file whose provenance is uncertain, and to catch a truncated or mislabelled take.',
        avoid: 'it is not a loudness or level judgement: that is loudness and levels.',
        required: ['target (paths also accepted for several files)'],
        returns: '{ container, codec, declaredSeconds, decodedSeconds, decodeErrors, bandwidthHz, tilt[] }',
        cost: 'one decode pass plus a probe: seconds to tens of seconds.',
        gotchas: [
          'The declared-against-decoded duration gap is the reason to run it: a file that plays fine can still be short.',
          'Its spectrum comes from the first 60s at min(48000, 2×source rate), which is NOT comparable with noise, whose spectrum uses a fixed 48kHz analysis of the quietest window.',
        ],
        example: { action: 'identify', target: 'take.wav' },
        seeAlso: ['integrity', 'noise'],
      },
      speech_map: {
        summary:
          'where speech is and where silence is, from a stated threshold and minimum silence length; returns both lists, the speech ratio and the longest pause.',
        use: 'to cut a long recording into takes, or to find where a narration actually starts.',
        avoid: 'it is a threshold on level, not speech recognition: room tone moves every boundary.',
        required: ['target'],
        returns: '{ speech[{start,end}], silence[{start,end}], speechRatio, longestGap, thresholds{ noiseDb, minSeconds } }',
        cost: 'one decode pass with a silence detector.',
        gotchas: [
          'noiseDb defaults to -40dB and minSeconds to 0.25s; both are echoed back, so a surprising map is usually a threshold problem rather than a bad file.',
          'Breaths and room tone inside a sentence can split one take into two.',
        ],
        example: { action: 'speech_map', target: 'interview.wav', noiseDb: -38, minSeconds: 0.4 },
        seeAlso: ['levels', 'video_narrate'],
      },
      loudness: {
        summary:
          'EBU R128 integrated loudness, loudness range and true peak, plus ffmpeg\'s per-channel statistics; with several paths it also reports the spread between them.',
        use: 'before delivery, and whenever several takes have to sit at the same level.',
        avoid: 'do not read it as clipping detection: that is levels, in the sample domain.',
        required: ['target (paths for several files)'],
        returns: '{ integratedLufs, loudnessRangeLu, truePeakDbtp, perChannel[], spreadLu?, median?, outliers[]? }',
        cost: 'one decode pass per file.',
        gotchas: [
          'True peak is measured on the decoded signal and can exceed 0dBTP on lossy material even when the file "looks" fine.',
          'The spread across several files is how inconsistent takes become visible; a single file cannot show it.',
          'damagedFiles lists the inputs whose frames are damaged: their loudness is computed on a timeline with holes in it and is not comparable with a healthy file.',
        ],
        example: { action: 'loudness', paths: ['vo-take1.wav', 'vo-take2.wav', 'vo-take3.wav'] },
        seeAlso: ['levels', 'video_render'],
      },
      levels: {
        summary:
          'sample-domain facts: peak, RMS, crest factor, DC offset, exact clipping runs with timestamps, and a per-second level timeline.',
        use: 'to find clipping, a DC offset, or a level that drifts across a take.',
        avoid: 'it does not normalise or judge: it reports what the samples are.',
        required: ['target'],
        returns: '{ peakDbfs, rmsDbfs, crestFactor, dcOffset, clipping{ threshold, totalHighSamples, runs[], truncated }, timeline[]? }',
        cost: 'decodes at the file\'s own sample rate, capped at 600s by default; the timeline series is long, which is why it can be switched off.',
        gotchas: [
          'maxSeconds defaults to 600: anything longer is measured only up to that point, which can hide clipping late in a long file.',
          'minClipSamples only controls which runs are listed; totalHighSamples is exact either way.',
          'It deliberately does not resample, because resampling changes peaks.',
        ],
        example: { action: 'levels', target: 'mix.wav', clipThreshold: 0.999, timeline: false },
        seeAlso: ['loudness', 'noise', 'audio_build'],
      },
      integrity: {
        summary:
          'whether the file is all there — walks the MPEG frame chain and reports every break with the bytes in it, compares declared against decoded duration, counts decoder errors, and on request writes a repaired copy without touching the original.',
        use: 'when a take sounds like it skips, or before re-recording something that may only be damaged.',
        avoid: 'it is not a general file check: it looks at the frame chain, so it is meaningful for MPEG-family audio.',
        required: ['target'],
        returns: '{ intact, declaredSeconds, decodedSeconds, decodeErrors, gaps[{ atSeconds, bytesHex, estimatedLostFrames }], gapHistogram, repairedPath? }',
        cost: 'one pass to walk the chain, plus a decode pass; the repair copy is written only when asked.',
        gotchas: [
          'repair:true writes to repairPath, or beside the source as <name>.repaired.mp3 when repairPath is omitted; the original file is never modified, and wide damage is refused rather than guessed at.',
          'A small gap count can still be audible, and a large gap count with intact decoding may not be: read the timestamps.',
        ],
        example: { action: 'integrity', target: 'take.mp3', repair: true, repairPath: 'take-repaired.mp3' },
        seeAlso: ['identify', 'sync'],
      },
      sync: {
        summary:
          'the offset between two recordings of the same audio, and the drift across them, by envelope correlation then sample refinement.',
        use: 'to line up a separately recorded take with the camera audio, or to prove an export did not shift.',
        avoid: 'it needs genuinely common material: two different performances have no offset to find.',
        required: ['reference', 'comparison'],
        returns: '{ offsetSeconds (positive = comparison is later), correlation, driftPpm, windows[] }',
        cost: 'two decode passes plus the correlation; the internal analysis rate is fixed at 8kHz, so top-level sampleRate is ignored.',
        gotchas: [
          'The real requirement is around 10s of common material with the default maxLagSeconds of 5, even though the guard only demands 2s: shorter material fails with a "too short or no common structure" error.',
          'A correlation below about 0.3 means the offset should not be trusted.',
          'It measures drift as well as offset, so a long take with a clock difference keeps moving after alignment.',
        ],
        example: { action: 'sync', reference: 'camera.wav', comparison: 'recorder.wav', maxLagSeconds: 5, windows: 5 },
        seeAlso: ['identify', 'assemble'],
      },
      noise: {
        summary:
          'what the noise floor is made of — broadband floor, the 50Hz and 60Hz hum families with each harmonic, spectral tilt per band, and the strongest tonal peaks.',
        use: 'before restore: this is how you find out whether the defect is hum, hiss, rumble or a single tone.',
        avoid: 'do not pass mainsHz expecting the measurement to change: it is reported, not used.',
        required: ['target'],
        returns: '{ broadbandDbfs, hum{ 50: [...], 60: [...] }, tilt[], tonalPeaks[], windowSeconds, defaults{...} }',
        cost: 'one decode pass plus a Goertzel and FFT analysis of the quietest window.',
        gotchas: [
          'mainsHz is echoed back and does not affect what is measured: both mains families are always reported.',
          'The echoed defaults.windowSeconds is 60 while the real default is 30; trust the measured windowSeconds.',
          'Its fixed 48kHz analysis of the quietest window is not comparable with identify\'s spectrum.',
        ],
        example: { action: 'noise', target: 'take.wav', fftSize: 8192, windowSeconds: 30 },
        seeAlso: ['levels', 'restore'],
      },
      devices: {
        summary: 'list the capture devices DirectShow reports, with the exact names to pass to record.',
        use: 'before the first record, and whenever a device name is rejected.',
        avoid: 'an empty list is a valid answer, not a failure: it means no capture device is present or DirectShow is unavailable.',
        required: [],
        returns: '{ devices[{ name, alternative }], backend }',
        cost: 'instant: one enumeration by ffmpeg.',
        gotchas: ['Pass the name verbatim to record; the alternative field is the stable identifier for machines where the friendly name changes.'],
        example: { action: 'devices' },
        seeAlso: ['audio_build'],
      },
      audio_events: {
        summary:
          'classify the soundtrack into AudioSet\'s 521 acoustic classes and return timestamped segments — where the music is, where the applause is, where it is silent.',
        use: 'to find the moments a cut can land on, or to prove a stretch really is silence rather than a quiet recording. This answers "what does it sound like", which transcription cannot.',
        avoid: 'it is not transcription: for words use video_narrate {action:"transcribe"}. A label is a model\'s opinion of a window, not a fact about the edit.',
        required: ['target'],
        returns: '{ durationSec, segments[{ at, endAt, rms, silent, labels[{ label, score }] }], events{ label: [times] }, soundtrack{ windows, classified, silent }, notes[] }',
        cost: 'one decode plus one YAMNet inference per 0.48s hop — roughly 70-80ms per window on CPU, so a three-minute file takes a couple of minutes. Requires the model: audio_status says whether it is installed.',
        gotchas: [
          'The model labels every window above silenceRms; a window quieter than that is reported silent and gets no label at all, which is the honest answer for a pause.',
          'A label appearing once at a low score is noise. The score and the run length are both in the result for that reason.',
          'Classification is per 0.96s window with a 0.48s hop: an event shorter than the window is smeared across two segments.',
        ],
        example: { action: 'audio_events', target: 'out/final.mp4', topK: 3, minScore: 0.1 },
        seeAlso: ['audio_status', 'speech_map'],
      },
      audio_status: {
        summary: 'report whether the audio event model is installed, how many classes it has and how much space it takes, without analysing anything.',
        use: 'before audio_events, and whenever a classification is refused because the model is missing.',
        avoid: 'it reads the disk and runs no inference, so it is safe to call at any time; it is not a health check of ffmpeg — that is audio_setup {action:"status"}.',
        required: [],
        returns: '{ available, kind, classes, missing[], model, runtime, vendorDir, vendorSource, reason, installWith }',
        cost: 'instant: file existence and sizes only.',
        gotchas: [
          '`available: false` with a `reason` naming the missing files is the normal state on a fresh machine, not an error.',
          'vendorSource names which directory answered: `vendor` is this plugin\'s own, `sibling` is a video-factory checkout left over from when the runtime lived there.',
        ],
        example: { action: 'audio_status' },
        seeAlso: ['audio_events', 'audio_setup'],
      },
    },
  },

  audio_setup: {
    purpose:
      'Change what is on disk, explicitly: install the YAMNet model and the shared ONNX runtime that audio_events and the matting model both use, remove them again, or report exactly what is present. Nothing here measures anything.',
    use: [
      'once per machine, before the first audio_events call',
      'to see what is installed without starting anything',
      'to reclaim the 28MB when classification is not needed',
    ],
    avoid: [
      'do not install "just in case": ffmpeg is a few hundred megabytes and this is 28MB',
      'status is the read-only action: it never downloads and never deletes',
    ],
    needs: ['network access for install (unless a sibling plugin already has a verified copy)'],
    next: ['audio_measure {action:"audio_events"} once installed', 'video_setup {action:"install_matte"} for matting, which reuses this runtime'],
    actions: {
      status: {
        summary: 'report whether the model and runtime are present and verified, where they were read from, and what an install would do.',
        use: 'as the first call when a classification was refused, and to check a machine before planning around audio_events.',
        avoid: 'it changes nothing: installing is install, removing is remove.',
        required: [],
        returns: '{ available, missing[], classes, fileCount, totalBytes, modelBytes, runtimeBytes, vendorDir, vendorSource, manifest, verify, model, runtime }',
        cost: 'instant: file existence, sizes and hashes.',
        gotchas: [
          '`verify.mismatched` non-empty means a file on disk is not the file the manifest recorded: reinstall with force rather than trusting an inference result.',
          'vendorSource `sibling` means the files are being read out of a video-factory checkout; install copies them here instead of downloading.',
        ],
        example: { action: 'status' },
        seeAlso: ['install', 'audio_measure'],
      },
      install: {
        summary:
          'fetch and verify the YAMNet model and the shared ONNX runtime into the shared plugin home (~/.dsh-plugins/models/yamnet and ~/.dsh-plugins/lib/onnxruntime-web), or copy a verified legacy vendor/audio tree in without downloading.',
        use: 'once, before the first audio_events call.',
        avoid: 'it is 28MB over the network: check status first, and do not pass force unless verification actually failed.',
        required: [],
        returns: '{ installed, skipped, adopted?, from?, model[], runtime[], verify{ checked, mismatched[], missing[] }, state }',
        cost: 'a few minutes and about 28MB, or seconds and no network when a legacy copy is adopted. The model is pinned by per-file SHA-256 and the runtime by each npm tarball\'s published sha512.',
        gotchas: [
          'A second call is a no-op: the skip test requires the files to be present AND to match the manifest, so a half-unpacked tree does not look installed.',
          'The runtime installed here is shared with the matting model in video-factory: install_matte reads the same lib/onnxruntime-web directory, which is why removing it can disable matting too.',
          'Adoption copies from a legacy tree; it never moves or deletes anything there.',
        ],
        example: { action: 'install' },
        seeAlso: ['status', 'remove'],
      },
      remove: {
        summary: 'delete this plugin\'s vendored model and runtime tree.',
        use: 'when audio event detection is no longer needed and the 28MB should go back.',
        avoid: 'it does not touch a sibling plugin\'s copy, so audio_events may keep working after this returns removed:true.',
        required: [],
        returns: '{ removed, directory, stillVisibleFrom }',
        cost: 'instant.',
        gotchas: [
          '`stillVisibleFrom` non-null means detection still works from another directory that this plugin will not delete. Read it before believing the feature is gone.',
          'Removing this runtime also removes it from video-factory matting when video-factory was reading it from here.',
        ],
        example: { action: 'remove' },
        seeAlso: ['status', 'install'],
      },
    },
  },

  audio_guide: {
    purpose:
      'Read this plugin\'s own reference on demand instead of paying for it every turn: the tool and action index, one action in full with its parameters and pitfalls, the rules that decide what a measurement is worth, and the measured costs.',
    use: [
      'before a first call to an action whose arguments are not obvious',
      'when a number looks wrong and the question is what produced it',
      'when deciding between loudness and levels, or between repairing and re-recording',
    ],
    avoid: [
      'it answers nothing about the audio itself: it is a manual, not a measurement',
      'reading all of it costs context: ask for one tool or one action when that is what you need',
    ],
    needs: ['nothing: pure computation, no ffmpeg, no model, no disk'],
    next: ['the action it described'],
    actions: {
      overview: {
        summary: 'the whole surface in one page: every tool, every action, the shared rules, the measured costs and the defaults.',
        use: 'once at the start of an audio job, to see what exists rather than guessing from tool names.',
        avoid: 'it is the longest answer here; when you already know the action, ask for that action.',
        required: [],
        returns: '{ tools[], actions[] (flattened, with `requires`), rules[], measured{}, limits[] }',
        cost: 'one page of text.',
        gotchas: ['The index is generated from the same registry the schemas are, so it cannot describe a plugin that does not exist.'],
        example: { action: 'overview' },
        seeAlso: ['tool', 'rules'],
      },
      tool: {
        summary: 'one tool in full: its purpose, when to use it and when not to, its prerequisites, its next step, and every action it owns.',
        use: 'when starting to use a tool you have not used before.',
        avoid: 'do not read all four to find one action: use the `action` reference instead.',
        required: ['tool'],
        returns: 'the registry entry for that tool.',
        cost: 'a page.',
        gotchas: ['An unknown tool name lists the valid ones rather than failing silently.'],
        example: { action: 'tool', tool: 'audio_measure' },
        seeAlso: ['action', 'overview'],
      },
      action: {
        summary: 'one action in full: parameters with their meanings and defaults, the return shape, the cost, the pitfalls and a runnable example.',
        use: 'before calling an action whose arguments or return shape matter.',
        avoid: 'the action name goes in `actionName`, not in `action` — `action` selects this reference action.',
        required: ['actionName'],
        returns: 'the registry entry for that action, with its tool named.',
        cost: 'a third of a page.',
        gotchas: ['When an action name exists in two tools, name the tool as well or the call is refused with both candidates.'],
        example: { action: 'action', tool: 'audio_build', actionName: 'assemble' },
        seeAlso: ['tool', 'overview'],
      },
      rules: {
        summary: 'the rules that decide what a measurement is worth: determinism, what a number means, the known environment traps, and where the neighbouring plugins take over.',
        use: 'before acting on a result, and whenever a number is about to become a decision.',
        avoid: 'these are consequences of the implementation, not taste: none of them says what sounds good.',
        required: [],
        returns: '{ rules[{ id, rule, why }], traps[{ id, trap, consequence }], boundaries[] }',
        cost: 'one page.',
        gotchas: ['The traps are the failures that produce a plausible wrong number rather than an error; they are worth reading once.'],
        example: { action: 'rules' },
        seeAlso: ['overview'],
      },
    },
  },
}

/**
 * Look up one tool's registry entry.
 * @param {string} tool - tool name.
 * @returns {object|undefined} the entry, or undefined when the tool is not registered in this file.
 */
export function lookupTool(tool) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, tool) ? REGISTRY[tool] : undefined
}

/**
 * Look up one action's registry entry.
 * @param {string} tool - tool name.
 * @param {string} action - action name.
 * @returns {object|undefined} the entry, or undefined when either name is unknown.
 */
export function lookupAction(tool, action) {
  const entry = lookupTool(tool)
  if (entry === undefined) return undefined
  return Object.prototype.hasOwnProperty.call(entry.actions, action) ? entry.actions[action] : undefined
}
