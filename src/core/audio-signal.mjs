/**
 * Pure signal arithmetic over decoded PCM.
 *
 * Everything here is a function of the samples and nothing else: no ffmpeg, no clock, no
 * randomness. That is what lets every audio measurement in this plugin claim to be
 * reproducible — the numbers are computed here, not inferred from a filter's prose.
 *
 * The samples are always float32 in the range -1..1 at a known sample rate, which is what
 * `-f f32le` produces; {@link decodePcm} in `audio-measure.mjs` is the only thing that
 * makes them.
 *
 * Two conventions are fixed and relied upon by the callers:
 *
 * 1. **Levels are amplitude ratios, reported in dBFS.** `dbFromAmplitude(1) === 0`, so a
 *    full-scale tone is 0 dBFS and digital silence is `-Infinity`. Never dBFS "RMS
 *    referenced to something else" — that is `loudness`, measured by EBU R128 elsewhere.
 * 2. **A "clip" is a run of samples at or above a threshold, not a count.** A single
 *    full-scale sample is not audible clipping; 200 of them in a row are. Both are
 *    reported so the caller can decide.
 *
 * @module dsh-video-audio/core/audio-signal
 */

/** Amplitude ratio to dBFS. Zero and non-finite amplitudes become -Infinity, never NaN. */
export function dbFromAmplitude(amplitude) {
  const value = Math.abs(Number(amplitude))
  if (!Number.isFinite(value) || value <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(value)
}

/** dBFS back to an amplitude ratio. */
export function amplitudeFromDb(db) {
  const value = Number(db)
  if (!Number.isFinite(value)) return 0
  return 10 ** (value / 20)
}

/**
 * Read a little-endian float32 stream as a plain array of numbers.
 *
 * A `Float32Array` view would be faster but is tied to the buffer's byte alignment, and
 * the buffers here come from partial reads. Copying once is cheap next to the decode.
 *
 * @param {Buffer} buffer - raw `f32le` bytes.
 * @returns {Float32Array} one sample per element.
 */
export function float32FromBuffer(buffer) {
  const count = Math.floor(buffer.length / 4)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) samples[index] = buffer.readFloatLE(index * 4)
  return samples
}

/**
 * Sum a multi-channel interleaved stream down to one channel by taking the loudest
 * channel per frame.
 *
 * Averaging is the usual choice and the wrong one here: two channels that are out of
 * phase cancel, so a peak or a clip present in the material would vanish from the
 * measurement. Taking the maximum keeps every event visible and is what a peak meter does.
 *
 * @param {Float32Array} samples - interleaved samples.
 * @param {number} channels - channel count, at least 1.
 * @returns {Float32Array} mono frames.
 */
export function loudestChannel(samples, channels) {
  if (channels <= 1) return samples
  const frames = Math.floor(samples.length / channels)
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let best = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const value = samples[frame * channels + channel]
      if (Math.abs(value) > Math.abs(best)) best = value
    }
    mono[frame] = best
  }
  return mono
}

/** Largest absolute sample. */
export function peakOf(samples) {
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index])
    if (value > peak) peak = value
  }
  return peak
}

/** Root mean square. Digital silence is exactly 0. */
export function rmsOf(samples) {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

/** Mean sample value. A non-zero result is a DC offset, which wastes headroom. */
export function dcOffsetOf(samples) {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) sum += samples[index]
  return sum / samples.length
}

/** Peak-to-RMS ratio in dB. A sine is 3.01 dB, a full-scale square wave 0 dB. */
export function crestFactorDb(samples) {
  const peak = peakOf(samples)
  const rms = rmsOf(samples)
  if (rms <= 0) return Number.POSITIVE_INFINITY
  return dbFromAmplitude(peak / rms)
}

/**
 * Find runs of samples at or above a threshold.
 *
 * Short runs are counted separately rather than dropped: one full-scale sample is a
 * different fact from a hundred, and hiding either would be a judgement this module is
 * not entitled to make.
 *
 * @param {Float32Array} samples - mono frames.
 * @param {object} [options] - the search.
 * @param {number} [options.threshold] - amplitude that counts as clipped; default 0.999.
 * @param {number} [options.minRunSamples] - runs shorter than this are summarised, not listed.
 * @param {number} [options.maxRuns] - cap on listed runs; the count is always exact.
 * @param {number} [options.sampleRate] - when given, runs also carry seconds.
 * @param {number} [options.offsetSeconds] - added to every reported time (windowed scans).
 * @returns {{runs: object[], totalHighSamples: number, listedRuns: number, truncated: boolean}|object}
 *   runs with their start sample, length, peak and time; plus the exact totals.
 */
export function clipRuns(samples, options = {}) {
  const threshold = options.threshold ?? 0.999
  const minRunSamples = options.minRunSamples ?? 1
  const maxRuns = options.maxRuns ?? 200
  const sampleRate = options.sampleRate ?? 0
  const offsetSeconds = options.offsetSeconds ?? 0

  const runs = []
  let totalHighSamples = 0
  let listedRuns = 0
  let truncated = false
  let start = -1
  let peak = 0

  const close = (end) => {
    if (start < 0) return
    const length = end - start
    totalHighSamples += length
    if (length >= minRunSamples) {
      listedRuns += 1
      if (runs.length < maxRuns) {
        runs.push({
          startSample: start,
          samples: length,
          peak: Number(peak.toFixed(6)),
          at: sampleRate > 0 ? Number((offsetSeconds + start / sampleRate).toFixed(6)) : null,
          seconds: sampleRate > 0 ? Number((length / sampleRate).toFixed(6)) : null,
        })
      } else {
        truncated = true
      }
    }
    start = -1
    peak = 0
  }

  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) >= threshold) {
      if (start < 0) start = index
      const value = Math.abs(samples[index])
      if (value > peak) peak = value
    } else {
      close(index)
    }
  }
  close(samples.length)

  return { runs, totalHighSamples, listedRuns, truncated }
}

/**
 * In-place iterative radix-2 FFT.
 *
 * Written out rather than pulled from a dependency because the plugin ships as one ESM
 * package with no runtime dependencies, and because a fixed implementation is one less
 * thing that can change under a measurement.
 *
 * @param {Float64Array} real - real parts; length must be a power of two.
 * @param {Float64Array} imaginary - imaginary parts, same length.
 * @returns {void} the arrays are transformed in place.
 */
export function fftInPlace(real, imaginary) {
  const size = real.length
  if (size !== imaginary.length || (size & (size - 1)) !== 0) {
    throw new Error('fftInPlace: length must be a power of two')
  }

  for (let index = 1, reverse = 0; index < size; index += 1) {
    let bit = size >> 1
    for (; reverse & bit; bit >>= 1) reverse ^= bit
    reverse ^= bit
    if (index < reverse) {
      const temporaryReal = real[index]
      real[index] = real[reverse]
      real[reverse] = temporaryReal
      const temporaryImaginary = imaginary[index]
      imaginary[index] = imaginary[reverse]
      imaginary[reverse] = temporaryImaginary
    }
  }

  for (let width = 2; width <= size; width <<= 1) {
    const angle = (-2 * Math.PI) / width
    const baseReal = Math.cos(angle)
    const baseImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += width) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      for (let offset = 0; offset < width / 2; offset += 1) {
        const even = start + offset
        const odd = even + width / 2
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextReal = twiddleReal * baseReal - twiddleImaginary * baseImaginary
        twiddleImaginary = twiddleReal * baseImaginary + twiddleImaginary * baseReal
        twiddleReal = nextReal
      }
    }
  }
}

/**
 * Magnitude spectrum of one Hann-windowed block.
 *
 * The magnitudes are scaled so that a full-scale sine whose frequency lands on a bin
 * centre reads 1.0 (0 dBFS); a sine between bins reads a few percent low, which is the
 * scalloping loss every FFT-based meter has and is why {@link goertzelDb} exists for
 * exact single-frequency questions.
 *
 * @param {Float32Array} samples - mono frames.
 * @param {object} [options] - the analysis.
 * @param {number} [options.size] - FFT size, a power of two; default 8192.
 * @param {number} [options.offset] - first sample of the block; default 0.
 * @returns {{magnitudes: Float64Array, size: number, binHz: number, windowSum: number}}
 *   magnitude per bin, `size / 2` meaningful bins.
 */
export function spectrumOf(samples, options = {}) {
  const size = options.size ?? 8192
  const offset = options.offset ?? 0
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  let windowSum = 0
  for (let index = 0; index < size; index += 1) {
    const sample = offset + index < samples.length ? samples[offset + index] : 0
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1))
    real[index] = sample * window
    windowSum += window
  }
  fftInPlace(real, imaginary)
  const magnitudes = new Float64Array(size / 2)
  for (let bin = 0; bin < size / 2; bin += 1) {
    const magnitude = Math.hypot(real[bin], imaginary[bin])
    // Two-sided to one-sided, and undo the window's coherent gain.
    magnitudes[bin] = (magnitude * (bin === 0 ? 1 : 2)) / windowSum
  }
  return { magnitudes, size, binHz: 0, windowSum }
}

/**
 * Exact amplitude at one frequency, by Goertzel.
 *
 * The FFT answers "roughly how loud is everything"; this answers "how loud is 50 Hz",
 * which is the actual question when looking for mains hum, and it answers it without
 * needing the frequency to land on a bin.
 *
 * @param {Float32Array} samples - mono frames.
 * @param {number} sampleRate - samples per second.
 * @param {number} frequency - the tone to measure, in Hz.
 * @returns {number} amplitude ratio at that frequency (0..~1 for a clean tone).
 */
export function goertzelAmplitude(samples, sampleRate, frequency) {
  if (samples.length === 0 || sampleRate <= 0) return 0
  const omega = (2 * Math.PI * frequency) / sampleRate
  const coefficient = 2 * Math.cos(omega)
  let previous = 0
  let beforePrevious = 0
  // A whole number of cycles keeps the estimate unbiased; a rectangular window over a
  // non-integer number of periods leaks, which is reported rather than corrected.
  const usable = Math.max(1, Math.floor((samples.length * frequency) / sampleRate) * (sampleRate / frequency))
  const count = Math.min(samples.length, Math.floor(usable))
  for (let index = 0; index < count; index += 1) {
    const current = samples[index] + coefficient * previous - beforePrevious
    beforePrevious = previous
    previous = current
  }
  const power = previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious
  return (2 * Math.sqrt(Math.max(0, power))) / count
}

/** Amplitude at one frequency, in dBFS. */
export function goertzelDb(samples, sampleRate, frequency) {
  return dbFromAmplitude(goertzelAmplitude(samples, sampleRate, frequency))
}

/**
 * The highest frequency still carrying signal, in Hz.
 *
 * Measured as the last bin whose magnitude is within `dropDb` of the loudest bin below
 * `ceilingHz`. This is the number that separates a 48 kbps MP3 from a 96 kbps one: the
 * codec does not make the top octave quiet, it removes it.
 *
 * @param {Float64Array} magnitudes - from {@link spectrumOf}.
 * @param {number} sampleRate - samples per second.
 * @param {object} [options] - the search.
 * @param {number} [options.dropDb] - how far below the loudest bin still counts; default 20.
 * @param {number} [options.ceilingHz] - ignore everything above this; defaults to 0.45 Nyquist.
 * @param {number} [options.noiseFloorDb] - magnitudes below this never count as signal.
 * @returns {{bandwidthHz: number, referenceDb: number, searchedToHz: number}} the result.
 */
export function bandwidthOf(magnitudes, sampleRate, options = {}) {
  const size = magnitudes.length * 2
  const binHz = sampleRate / size
  const nyquist = sampleRate / 2
  const ceilingHz = Math.min(options.ceilingHz ?? nyquist * 0.9, nyquist)
  const dropDb = options.dropDb ?? 20
  const floorDb = options.noiseFloorDb ?? -120
  const lastBin = Math.max(2, Math.floor(ceilingHz / binHz))

  let referenceDb = Number.NEGATIVE_INFINITY
  for (let bin = 2; bin <= lastBin; bin += 1) {
    const db = dbFromAmplitude(magnitudes[bin])
    if (db > referenceDb) referenceDb = db
  }
  if (!Number.isFinite(referenceDb)) return { bandwidthHz: 0, referenceDb: Number.NEGATIVE_INFINITY, searchedToHz: lastBin * binHz }

  const limitDb = Math.max(floorDb, referenceDb - dropDb)
  let bandwidthHz = 0
  for (let bin = lastBin; bin >= 2; bin -= 1) {
    if (dbFromAmplitude(magnitudes[bin]) >= limitDb) {
      bandwidthHz = bin * binHz
      break
    }
  }
  return {
    bandwidthHz: Number(bandwidthHz.toFixed(1)),
    referenceDb: Number(referenceDb.toFixed(2)),
    searchedToHz: Number((lastBin * binHz).toFixed(1)),
  }
}

/**
 * Slopes of magnitude against frequency, in dB per octave.
 *
 * Split into bands because one number would average a rumble away against a hiss: the
 * caller gets the tilt below 200 Hz, through the speech band, and above 4 kHz, and can see
 * that, say, the top band falls at -12 dB/octave, which is a codec, not a room.
 *
 * @param {Float64Array} magnitudes - from {@link spectrumOf}.
 * @param {number} sampleRate - samples per second.
 * @param {Array<{name: string, fromHz: number, toHz: number}>} bands - the bands to fit.
 * @returns {Array<{name: string, fromHz: number, toHz: number, dbPerOctave: number|null, bins: number}>}
 */
export function tiltOf(magnitudes, sampleRate, bands) {
  const size = magnitudes.length * 2
  const binHz = sampleRate / size
  return bands.map((band) => {
    const points = []
    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      const frequency = bin * binHz
      if (frequency < band.fromHz || frequency > band.toHz) continue
      const db = dbFromAmplitude(magnitudes[bin])
      if (!Number.isFinite(db) || db < -140) continue
      points.push([Math.log2(frequency), db])
    }
    if (points.length < 4) return { ...band, dbPerOctave: null, bins: points.length }
    const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length
    const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length
    let numerator = 0
    let denominator = 0
    for (const [x, y] of points) {
      numerator += (x - meanX) * (y - meanY)
      denominator += (x - meanX) ** 2
    }
    const slope = denominator === 0 ? null : numerator / denominator
    return { ...band, dbPerOctave: slope === null ? null : Number(slope.toFixed(2)), bins: points.length }
  })
}

/**
 * Local maxima that stand above the surrounding spectrum.
 *
 * A tone is a peak with quiet neighbours; broadband noise has no such structure. Each
 * peak is compared against the median magnitude of its neighbourhood, so a general rise in
 * level does not manufacture peaks.
 *
 * @param {Float64Array} magnitudes - from {@link spectrumOf}.
 * @param {number} sampleRate - samples per second.
 * @param {object} [options] - the search.
 * @param {number} [options.count] - how many peaks to return; default 8.
 * @param {number} [options.prominenceDb] - required excess over the local median; default 6.
 * @param {number} [options.fromHz] - lowest frequency of interest; default 20.
 * @param {number} [options.toHz] - highest; default 0.45 Nyquist.
 * @param {number} [options.neighbourhoodBins] - half-width of the local median; default 32.
 * @returns {Array<{frequencyHz: number, db: number, prominenceDb: number}>} the peaks.
 */
export function tonalPeaks(magnitudes, sampleRate, options = {}) {
  const size = magnitudes.length * 2
  const binHz = sampleRate / size
  const nyquist = sampleRate / 2
  const fromHz = options.fromHz ?? 20
  const toHz = Math.min(options.toHz ?? nyquist * 0.9, nyquist)
  const count = options.count ?? 8
  const prominenceDb = options.prominenceDb ?? 6
  const neighbourhood = options.neighbourhoodBins ?? 32

  const firstBin = Math.max(1, Math.ceil(fromHz / binHz))
  const lastBin = Math.min(magnitudes.length - 2, Math.floor(toHz / binHz))
  const found = []
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const db = dbFromAmplitude(magnitudes[bin])
    if (db <= dbFromAmplitude(magnitudes[bin - 1]) || db < dbFromAmplitude(magnitudes[bin + 1])) continue
    const window = []
    for (let other = Math.max(1, bin - neighbourhood); other <= Math.min(lastBin, bin + neighbourhood); other += 1) {
      // Amplitudes, not decibels: the median has to be taken before the conversion, or the
      // conversion is applied twice and every peak disappears.
      if (other !== bin) window.push(magnitudes[other])
    }
    if (window.length < 8) continue
    window.sort((a, b) => a - b)
    const median = window[Math.floor(window.length / 2)]
    const excess = db - dbFromAmplitude(median)
    if (excess >= prominenceDb) {
      found.push({ frequencyHz: Number((bin * binHz).toFixed(2)), db: Number(db.toFixed(2)), prominenceDb: Number(excess.toFixed(2)) })
    }
  }
  found.sort((a, b) => b.prominenceDb - a.prominenceDb)
  return found.slice(0, count)
}

/** Amplitude envelope: the level of each fixed-size block, in dBFS. */
export function envelopeDb(samples, sampleRate, windowSeconds) {
  const windowSamples = Math.max(1, Math.round(windowSeconds * sampleRate))
  const envelope = []
  for (let start = 0; start < samples.length; start += windowSamples) {
    const block = samples.subarray(start, Math.min(samples.length, start + windowSamples))
    envelope.push({ at: Number((start / sampleRate).toFixed(6)), db: Number(dbFromAmplitude(rmsOf(block)).toFixed(2)) })
  }
  return envelope
}

/**
 * Coarse lag between two signals, from their amplitude envelopes.
 *
 * Two recordings of the same words differ sample by sample — different codecs, different
 * noise — so correlating the waveforms finds nothing. The envelope of speech, on the other
 * hand, is nearly identical, and correlating it at 100 Hz finds the shift in one pass.
 *
 * @param {Float32Array} reference - mono frames at `sampleRate`.
 * @param {Float32Array} target - mono frames at the same rate.
 * @param {number} sampleRate - samples per second of both signals.
 * @param {object} [options] - the search.
 * @param {number} [options.envelopeRate] - envelope samples per second; default 100.
 * @param {number} [options.maxLagSeconds] - search this far either way; default 5.
 * @returns {{lagSeconds: number, correlation: number, envelopeRate: number}|null} the best lag.
 */
export function envelopeLag(reference, target, sampleRate, options = {}) {
  const envelopeRate = options.envelopeRate ?? 100
  const maxLagSeconds = options.maxLagSeconds ?? 5
  const step = Math.max(1, Math.round(sampleRate / envelopeRate))
  const compress = (samples) => {
    const frames = Math.floor(samples.length / step)
    const envelope = new Float64Array(frames)
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0
      for (let index = 0; index < step; index += 1) {
        const value = samples[frame * step + index]
        sum += value * value
      }
      envelope[frame] = Math.sqrt(sum / step)
    }
    return envelope
  }

  const a = compress(reference)
  const b = compress(target)
  const maxLag = Math.round(maxLagSeconds * envelopeRate)
  const length = Math.min(a.length, b.length)
  if (length < maxLag * 2 + 8) return null

  // Every candidate lag is scored over the part of the two envelopes that actually overlaps.
  //
  // Scoring a fixed leading span instead — the obvious version, and the one this replaced — is
  // dominated by how much of the span the lag puts into alignment: a lag that aligns three of four
  // bursts, with the remainder of the span compared against material that does not belong to it,
  // can outscore the true lag that aligns all four. On material with a repeating structure that
  // means the true offset is never even considered, because the refinement only searches around
  // the coarse answer. Restricting each comparison to its own overlap and subtracting that
  // overlap's own mean removes the bias.
  const mean = (values, from, to) => {
    let sum = 0
    for (let index = from; index < to; index += 1) sum += values[index]
    return sum / Math.max(1, to - from)
  }

  let bestLag = 0
  let bestScore = Number.NEGATIVE_INFINITY
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    // Positive lag compares a[i + lag] with b[i]: it aligns the target against a later part of the
    // reference, which is what "the target is late" means.
    const from = lag < 0 ? -lag : 0
    const to = lag > 0 ? length - lag : length
    const overlap = to - from
    if (overlap < 4) continue

    const meanA = mean(a, from, to)
    const meanB = mean(b, from - lag, to - lag)
    let sum = 0
    let energyA = 0
    let energyB = 0
    for (let index = from; index < to; index += 1) {
      const left = a[index] - meanA
      const right = b[index - lag] - meanB
      sum += left * right
      energyA += left * left
      energyB += right * right
    }
    const denominator = Math.sqrt(energyA * energyB)
    const score = denominator === 0 ? 0 : sum / denominator
    // Ties go to the smaller shift. A periodic envelope correlates equally well at every multiple
    // of its period, and the honest answer for it is the shift nearest zero: that is the alignment
    // a caller can act on, and the one this function can actually justify. Scanning from the most
    // negative lag is what makes an explicit tie-break necessary rather than incidental.
    const tied = score > 0 && Math.abs(score - bestScore) <= 1e-6
    if (score > bestScore + 1e-6 || (tied && Math.abs(lag) < Math.abs(bestLag))) {
      if (score > bestScore) bestScore = score
      bestLag = lag
    }
  }
  if (bestScore === Number.NEGATIVE_INFINITY) return null
  return {
    lagSeconds: Number((bestLag / envelopeRate).toFixed(4)),
    correlation: Number(bestScore.toFixed(4)),
    envelopeRate,
  }
}

/**
 * Refine a coarse lag by scanning whole samples around it.
 *
 * @param {Float32Array} reference - mono frames.
 * @param {Float32Array} target - mono frames at the same rate.
 * @param {number} coarseLagSeconds - starting point from {@link envelopeLag}.
 * @param {number} sampleRate - samples per second.
 * @param {number} [searchSeconds] - how far either side of the coarse lag to look; default 0.05.
 * @returns {{lagSeconds: number, correlation: number}} the refined lag; positive means the
 *   target is late relative to the reference.
 */
export function refineLag(reference, target, coarseLagSeconds, sampleRate, searchSeconds = 0.05) {
  const center = Math.round(coarseLagSeconds * sampleRate)
  const radius = Math.max(1, Math.round(searchSeconds * sampleRate))
  const length = Math.min(reference.length, target.length)
  let bestLag = center
  let bestScore = Number.NEGATIVE_INFINITY
  for (let lag = center - radius; lag <= center + radius; lag += 1) {
    const start = Math.max(0, -lag)
    const end = Math.min(length, length - lag)
    if (end - start < sampleRate * 0.1) continue
    let sum = 0
    let energyA = 0
    let energyB = 0
    for (let index = start; index < end; index += 1) {
      const left = reference[index]
      const right = target[index + lag]
      sum += left * right
      energyA += left * left
      energyB += right * right
    }
    const denominator = Math.sqrt(energyA * energyB)
    const score = denominator === 0 ? 0 : sum / denominator
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  return { lagSeconds: Number((bestLag / sampleRate).toFixed(6)), correlation: Number(bestScore.toFixed(4)) }
}

/**
 * Least-squares fit of y against x, for reading drift out of several lag measurements.
 *
 * @param {number[]} xs - abscissae, for example measurement times in seconds.
 * @param {number[]} ys - ordinates, for example lags in seconds.
 * @returns {{slope: number, intercept: number, samples: number}|null} the fit, or null.
 */
export function linearFit(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  if (denominator === 0) return null
  const slope = numerator / denominator
  return { slope, intercept: meanY - slope * meanX, samples: xs.length }
}
