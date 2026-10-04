/**
 * Audio event detection: the parts that run without the model.
 *
 * The class table's alignment is the single most dangerous piece of this feature: the CSV's
 * first line is a header, so class N is data row N. Getting that off by one shifts every label
 * by one position and still produces confident, plausible-looking output — the kind of bug
 * that survives casual inspection. It is pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  YAMNET_CLASS_MAP,
  YAMNET_HOP,
  YAMNET_SAMPLE_RATE,
  YAMNET_WINDOW,
  AudioEventError,
  audioEventState,
  audioPaths,
  decodeWav,
  groupEvents,
  readClassMap,
  rms,
  topLabels,
  windowsOf,
} from '../src/core/audio-events.mjs'

/** Build a minimal 16-bit mono PCM WAV around the given samples. */
function wav(samples, sampleRate = 16_000, { channels = 1, bits = 16 } = {}) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(clamped * 32_767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28)
  header.writeUInt16LE((channels * bits) / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('the AudioSet class table has 521 names and class N is data row N', (context) => {
  if (!audioEventState().available) {
    context.skip('YAMNet 未安装：运行 audio_setup {action:"install"} 后这条会跑。')
    return
  }
  // Resolved at run time, not from the exported constant: the constant names the install target,
  // and a machine whose model lives in a sibling checkout would otherwise read a missing file.
  const names = readClassMap(audioPaths().classMap)
  assert.equal(names.length, 521)

  // These four are the anchors: they are what a pure 440 Hz / 1 kHz tone actually scored
  // highest on, measured against the vendored model. If the alignment ever shifts by one,
  // these names move and the check fails.
  assert.equal(names[0], 'Speech')
  assert.equal(names[382], 'Alarm')
  assert.equal(names[383], 'Telephone')
  assert.equal(names[387], 'Dial tone')
  assert.equal(names[388], 'Busy signal')
  assert.equal(names[495], 'Sine wave')
  assert.equal(names[520], 'Field recording')
})

test('a class table without the expected header is refused rather than misread', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-audio-'))
  try {
    const path = join(directory, 'bad.csv')
    writeFileSync(path, 'nonsense,columns\n0,a,Something\n')
    assert.throws(() => readClassMap(path), AudioEventError)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('decodeWav reads back what it wrote, in the range the model expects', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const decoded = decodeWav(wav(samples))
  assert.equal(decoded.sampleRate, YAMNET_SAMPLE_RATE)
  assert.equal(decoded.samples.length, samples.length)
  assert.ok(Math.abs(decoded.samples[1] - 0.5) < 1e-4)
  assert.ok(Math.abs(decoded.samples[3] - 1) < 1e-4)
  assert.ok(Math.abs(decoded.samples[4] + 1) < 1e-4)
  assert.equal(decoded.durationSec, 5 / YAMNET_SAMPLE_RATE)
})

test('decodeWav refuses anything but 16-bit mono PCM instead of coercing it', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav at all, definitely not')), AudioEventError)
  // Stereo is the case a naive reader would silently average or take the wrong stride on.
  assert.throws(() => decodeWav(wav(new Float32Array(8), 16_000, { channels: 2 })), AudioEventError)
  assert.throws(() => decodeWav(wav(new Float32Array(8), 16_000, { bits: 8 })), AudioEventError)
})

test('windowsOf cuts 0.96s windows on a 0.48s hop', () => {
  assert.equal(YAMNET_WINDOW / YAMNET_SAMPLE_RATE, 0.96)
  assert.equal(YAMNET_HOP / YAMNET_SAMPLE_RATE, 0.48)

  const samples = new Float32Array(YAMNET_SAMPLE_RATE * 3)
  const windows = windowsOf(samples, YAMNET_SAMPLE_RATE)
  // 3s of audio holds windows whose start is at least 0.96s from the end: starts at 0, 0.48,
  // 0.96, 1.44 and 1.92. A start of 2.4 would need 3.36s of audio, so there are five.
  assert.equal(windows.length, 5)
  assert.deepEqual(
    windows.map((w) => w.at),
    [0, 0.48, 0.96, 1.44, 1.92],
  )
  assert.equal(windows[0].samples.length, YAMNET_WINDOW)
})

test('windowsOf refuses a sample rate the model was not trained on', () => {
  assert.throws(() => windowsOf(new Float32Array(1000), 44_100), AudioEventError)
})

test('windowsOf reports the level of each window so silence can be skipped', () => {
  const samples = new Float32Array(YAMNET_SAMPLE_RATE * 2)
  // Second half carries a full-scale square wave.
  for (let i = YAMNET_SAMPLE_RATE; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? 1 : -1
  const windows = windowsOf(samples, YAMNET_SAMPLE_RATE)
  assert.ok(windows[0].rms < 1e-6, 'the first window is digital silence')
  assert.ok(windows.at(-1).rms > 0.9, 'the last window is a full-scale square wave')
  assert.equal(rms(new Float32Array(0)), 0)
})

test('topLabels averages the rows of a multi-window score matrix', () => {
  // Two rows, three classes: class 1 wins on the average even though class 2 wins one row.
  const dims = [2, 3]
  const data = new Float32Array([0.1, 0.9, 0.2, 0.1, 0.7, 0.8])
  const names = ['a', 'b', 'c', 'd']
  const verdict = topLabels(data, dims, names, { topK: 3, minScore: 0 })
  assert.equal(verdict.labels[0].label, 'b')
  assert.ok(Math.abs(verdict.labels[0].score - 0.8) < 1e-6)
  assert.equal(verdict.peak.label, 'b')
})

test('topLabels drops labels below minScore but still reports the peak', () => {
  const dims = [1, 3]
  const data = new Float32Array([0.9, 0.05, 0.01])
  const verdict = topLabels(data, dims, ['loud', 'quiet', 'quieter'], { topK: 3, minScore: 0.1 })
  assert.deepEqual(verdict.labels.map((l) => l.label), ['loud'])
  assert.equal(verdict.peak.label, 'loud')
})

test('groupEvents turns per-segment verdicts into label to timestamps', () => {
  const events = groupEvents([
    { at: 0, labels: [{ label: 'Music', score: 0.9 }] },
    { at: 0.48, labels: [{ label: 'Music', score: 0.8 }, { label: 'Speech', score: 0.3 }] },
    { at: 0.96, labels: [] },
  ])
  assert.deepEqual(events.Music, [0, 0.48])
  assert.deepEqual(events.Speech, [0.48])
})
