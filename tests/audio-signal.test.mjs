/**
 * The signal arithmetic, on signals whose answer is known in advance.
 *
 * Every number this plugin reports about a file is computed by these functions, so each is
 * checked against an input whose true value can be written down: a full-scale sine has an RMS
 * of 1/sqrt(2) and a crest factor of 3.01 dB, a 750 Hz tone lands on bin 128 of an 8192-point
 * transform at 48 kHz, and a signal shifted by 137 samples is shifted by 137 samples.
 *
 * The two failure modes these tests exist to catch are the ones that look right: a spectrogram
 * scaled so every level is off by a constant, and a correlation that finds a plausible peak one
 * envelope step away from the true one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  amplitudeFromDb,
  bandwidthOf,
  clipRuns,
  crestFactorDb,
  dbFromAmplitude,
  dcOffsetOf,
  envelopeLag,
  envelopeDb,
  fftInPlace,
  float32FromBuffer,
  goertzelDb,
  linearFit,
  loudestChannel,
  peakOf,
  refineLag,
  rmsOf,
  spectrumOf,
  tiltOf,
  tonalPeaks,
} from '../src/core/audio-signal.mjs'

/** A full-scale sine at `frequency`, `seconds` long. */
function sine(frequency, seconds, sampleRate = 48_000, amplitude = 1) {
  const count = Math.round(seconds * sampleRate)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate)
  }
  return samples
}

test('levels convert both ways, and silence is minus infinity rather than NaN', () => {
  assert.equal(dbFromAmplitude(1), 0)
  assert.equal(dbFromAmplitude(0), Number.NEGATIVE_INFINITY)
  assert.equal(dbFromAmplitude(Number.NaN), Number.NEGATIVE_INFINITY)
  assert.ok(Math.abs(dbFromAmplitude(0.5) + 6.0206) < 1e-3)
  assert.ok(Math.abs(amplitudeFromDb(-6.0206) - 0.5) < 1e-3)
  assert.equal(amplitudeFromDb(Number.NaN), 0)
})

test('a full-scale sine has RMS 1/sqrt(2) and a crest factor of 3.01 dB', () => {
  const samples = sine(1000, 0.5)
  assert.ok(Math.abs(peakOf(samples) - 1) < 1e-3)
  assert.ok(Math.abs(rmsOf(samples) - Math.SQRT1_2) < 1e-3)
  assert.ok(Math.abs(crestFactorDb(samples) - 3.0103) < 0.02)
  assert.ok(Math.abs(dcOffsetOf(samples)) < 1e-3)
})

test('a signal with a DC offset reports it, and digital silence reports zero RMS', () => {
  const samples = new Float32Array(1000).fill(0.25)
  assert.ok(Math.abs(dcOffsetOf(samples) - 0.25) < 1e-6)
  assert.equal(rmsOf(new Float32Array(0)), 0)
  assert.equal(crestFactorDb(new Float32Array(0)), Number.POSITIVE_INFINITY)
})

test('clip runs are found with their exact position and length', () => {
  const samples = new Float32Array(1000)
  samples[100] = 1
  samples[101] = 1
  samples[500] = 0.5
  samples[700] = 1
  const found = clipRuns(samples, { threshold: 0.999, minRunSamples: 2, sampleRate: 1000 })
  // The lone sample at 700 counts in the total but is not listed: one sample is not a clip.
  assert.equal(found.totalHighSamples, 3)
  assert.equal(found.listedRuns, 1)
  assert.equal(found.runs.length, 1)
  assert.deepEqual(found.runs[0], { startSample: 100, samples: 2, peak: 1, at: 0.1, seconds: 0.002 })
  assert.equal(found.truncated, false)
})

test('clip listing stops at maxRuns but the totals stay exact', () => {
  const samples = new Float32Array(1000)
  for (let index = 100; index < 200; index += 1) samples[index] = 1
  for (let index = 400; index < 500; index += 1) samples[index] = 1
  for (let index = 700; index < 800; index += 1) samples[index] = 1
  const found = clipRuns(samples, { maxRuns: 2, minRunSamples: 1 })
  assert.equal(found.totalHighSamples, 300)
  assert.equal(found.listedRuns, 3)
  assert.equal(found.runs.length, 2)
  assert.equal(found.truncated, true)
})

test('loudestChannel keeps a peak that averaging would cancel', () => {
  // Two channels in antiphase: the mean is exactly zero at every frame.
  const interleaved = new Float32Array([0.9, -0.9, 0.9, -0.9])
  const mono = loudestChannel(interleaved, 2)
  assert.equal(mono.length, 2)
  assert.ok(Math.abs(mono[0] - 0.9) < 1e-6)
  assert.equal(loudestChannel(interleaved, 1), interleaved)
})

test('float32FromBuffer reads little-endian floats and ignores a partial trailing sample', () => {
  const whole = Buffer.alloc(12)
  whole.writeFloatLE(0.5, 0)
  whole.writeFloatLE(-0.5, 4)
  whole.writeFloatLE(1, 8)
  const samples = float32FromBuffer(whole)
  assert.equal(samples.length, 3)
  assert.ok(Math.abs(samples[0] - 0.5) < 1e-7)
  assert.ok(Math.abs(samples[1] + 0.5) < 1e-7)
  assert.equal(samples[2], 1)

  // A stream cut mid-sample must not throw or invent a value.
  const partial = float32FromBuffer(whole.subarray(0, 10))
  assert.equal(partial.length, 2)
})

test('fftInPlace refuses a length that is not a power of two', () => {
  assert.throws(() => fftInPlace(new Float64Array(3), new Float64Array(3)), /power of two/)
})

test('a tone that lands on a bin reads 0 dBFS, and the bin is the right frequency', () => {
  // 8192 points at 48 kHz: bin spacing is 5.859375 Hz, so 750 Hz is exactly bin 128.
  const samples = sine(750, 0.5)
  const spectrum = spectrumOf(samples, { size: 8192 })
  const binHz = 48_000 / 8192
  let peakBin = 0
  for (let bin = 1; bin < spectrum.magnitudes.length; bin += 1) {
    if (spectrum.magnitudes[bin] > spectrum.magnitudes[peakBin]) peakBin = bin
  }
  assert.equal(peakBin, 128)
  assert.ok(Math.abs(binHz * peakBin - 750) < 1e-6)
  const db = dbFromAmplitude(spectrum.magnitudes[peakBin])
  assert.ok(Math.abs(db) < 0.1, `expected about 0 dBFS, got ${db}`)
})

test('goertzel reads one frequency exactly, on and off the tone', () => {
  // Two seconds is a whole number of 50 Hz cycles, so the estimate is unbiased.
  const samples = sine(50, 2, 8000, 0.5)
  const onTone = goertzelDb(samples, 8000, 50)
  assert.ok(Math.abs(onTone + 6.0206) < 0.05, `expected -6.02 dBFS, got ${onTone}`)
  const offTone = goertzelDb(samples, 8000, 70)
  assert.ok(offTone < -40, `expected the off-tone bin to be far down, got ${offTone}`)
})

test('bandwidthOf reports where the spectrum stops carrying signal', () => {
  const size = 8192
  const magnitudes = new Float64Array(size / 2)
  const binHz = 48_000 / size
  for (let bin = 2; bin < magnitudes.length; bin += 1) {
    magnitudes[bin] = bin * binHz <= 4000 ? 0.5 : 1e-5
  }
  const measured = bandwidthOf(magnitudes, 48_000, { dropDb: 20 })
  assert.ok(Math.abs(measured.bandwidthHz - 4000) <= binHz * 2, `got ${measured.bandwidthHz}`)
  assert.ok(Math.abs(measured.referenceDb + 6.0206) < 0.1)
})

test('tiltOf recovers the slope of a synthetic 1/f spectrum', () => {
  const size = 8192
  const magnitudes = new Float64Array(size / 2)
  const binHz = 48_000 / size
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    // Amplitude proportional to 1/f, which is -6 dB per octave of magnitude.
    magnitudes[bin] = 0.5 * (100 / (bin * binHz))
  }
  const [band] = tiltOf(magnitudes, 48_000, [{ name: 'band', fromHz: 200, toHz: 4000 }])
  assert.ok(Math.abs(band.dbPerOctave + 6) < 0.2, `expected about -6 dB/octave, got ${band.dbPerOctave}`)
  assert.ok(band.bins > 100)
})

/** A deterministic low-level dither, so a test never depends on the platform's RNG. */
function dither(index) {
  const value = Math.sin(index * 12.9898) * 43758.5453
  return (value - Math.floor(value) - 0.5) * 0.001
}

test('tonalPeaks finds the tones and not the broadband floor', () => {
  const samples = new Float32Array(48_000 * 2)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] =
      0.3 * Math.sin((2 * Math.PI * 750 * index) / 48_000) +
      0.2 * Math.sin((2 * Math.PI * 3000 * index) / 48_000) +
      dither(index)
  }
  const spectrum = spectrumOf(samples, { size: 8192 })
  const peaks = tonalPeaks(spectrum.magnitudes, 48_000, { count: 4, prominenceDb: 10 })
  const frequencies = peaks.map((peak) => Math.round(peak.frequencyHz))
  assert.ok(frequencies.includes(750), `expected 750 Hz among ${frequencies}`)
  assert.ok(frequencies.includes(3000), `expected 3000 Hz among ${frequencies}`)
})

test('envelope of a known signal reports the level of each second', () => {
  const samples = new Float32Array(48_000 * 2)
  for (let index = 48_000; index < samples.length; index += 1) samples[index] = 0.5
  const envelope = envelopeDb(samples, 48_000, 1)
  assert.equal(envelope.length, 2)
  assert.equal(envelope[0].db, Number.NEGATIVE_INFINITY)
  assert.ok(Math.abs(envelope[1].db + 6.0206) < 0.01)
})

test('a shifted signal is found at the shift the envelope can see', () => {
  const sampleRate = 8000
  const seconds = 10
  const source = new Float32Array(sampleRate * seconds)
  for (let index = 0; index < source.length; index += 1) {
    // Speech-like: a slow envelope over a carrier, so the envelope correlation has structure.
    const envelope = Math.sin((2 * Math.PI * index) / sampleRate / 0.4) > 0 ? 1 : 0
    source[index] = envelope * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
  }
  // Shifted by exactly one envelope step: at 100 Hz envelopes that is 80 samples, 0.01 s.
  const shifted = new Float32Array(source.length)
  shifted.set(source.subarray(0, source.length - 80), 80)

  const coarse = envelopeLag(source, shifted, sampleRate, { envelopeRate: 100, maxLagSeconds: 1 })
  assert.ok(coarse !== null)
  assert.ok(Math.abs(coarse.lagSeconds - 0.01) <= 0.01, `expected about 0.01s, got ${coarse.lagSeconds}`)

  const refined = refineLag(source, shifted, coarse.lagSeconds, sampleRate, 0.05)
  assert.equal(refined.lagSeconds, 0.01, 'the refinement should land on the true 80-sample shift')
})

test('refineLag recovers a shift that no envelope can resolve', () => {
  const sampleRate = 8000
  const source = new Float32Array(sampleRate * 2)
  for (let index = 0; index < source.length; index += 1) {
    source[index] = Math.sin((2 * Math.PI * 300 * index) / sampleRate) + dither(index) * 200
  }
  const shifted = new Float32Array(source.length)
  shifted.set(source.subarray(0, source.length - 137), 137)
  const refined = refineLag(source, shifted, 0.017, sampleRate, 0.01)
  assert.equal(Number((refined.lagSeconds * sampleRate).toFixed(0)), 137)
  assert.ok(refined.correlation > 0.9)
})

test('linearFit recovers a slope and refuses an unusable input', () => {
  const fit = linearFit([0, 1, 2, 3], [1, 3, 5, 7])
  assert.ok(Math.abs(fit.slope - 2) < 1e-9)
  assert.ok(Math.abs(fit.intercept - 1) < 1e-9)
  assert.equal(linearFit([0], [1]), null)
  assert.equal(linearFit([0, 0, 0], [1, 2, 3]), null)
})
