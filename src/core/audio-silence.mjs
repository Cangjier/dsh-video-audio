/**
 * Reading ffmpeg's `silencedetect` output.
 *
 * This is a one-function module on purpose. The measurement code needs exactly this parse and
 * nothing else from the speech pipeline it used to live beside, and reaching across for it would
 * have dragged transcription — a different capability, with its own host service — into a plugin
 * that only measures sound.
 *
 * @module dsh-video-audio/core/audio-silence
 */

/**
 * Parse ffmpeg's `silencedetect` output into silence intervals.
 *
 * Only the start of each silence is needed as a candidate cut point; the reported end simply
 * bounds how long the pause lasted.
 *
 * @param {string} stderr - ffmpeg's standard error for a silencedetect run.
 * @returns {{start: number, end: number|null}[]} detected silences, in order.
 */
export function parseSilences(stderr) {
  const silences = []
  for (const line of String(stderr).split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start !== null) {
      silences.push({ start: Number(start[1]), end: null })
      continue
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (end !== null && silences.length > 0) {
      silences[silences.length - 1].end = Number(end[1])
    }
  }
  return silences.filter((entry) => entry.start >= 0)
}
