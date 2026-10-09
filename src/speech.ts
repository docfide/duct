// Speech to text on this computer, for searching inside audio: voice notes, recorded calls and meetings, interviews.
//
// Audio is decoded with ffmpeg (the ffmpeg-static binary that ships with Duct) to 16 kHz mono and transcribed by
// Whisper running locally through transformers.js and ONNX Runtime. Nothing is uploaded. The model (Whisper base,
// about 77 MB) is downloaded once, the first time a recording is transcribed, into Duct's data folder; the privacy
// ledger shows that download. Audio search is a file family that's off until someone turns it on.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface SpeechSegment {
  /** Seconds from the start. */
  start: number
  end: number
  text: string
}

export interface AudioInfo {
  durationSec: number
  /** A song rather than speech: tagged with both an artist and an album. */
  music: boolean
  title?: string
}

export const SPEECH_MODEL = 'onnx-community/whisper-base'
/** Recordings longer than this aren't transcribed: hours of audio would hold the indexer for a long time. */
export const MAX_AUDIO_SECONDS = 3 * 60 * 60

/** The ffmpeg binary: ffmpeg-static's, moved out of the app archive in the desktop app; DUCT_FFMPEG overrides. */
export async function ffmpegPath(): Promise<string> {
  if (process.env['DUCT_FFMPEG']) return process.env['DUCT_FFMPEG']
  const mod = await import('ffmpeg-static') as unknown as { default: string | null }
  const path = mod.default?.replace(`app.asar${pathSep()}`, `app.asar.unpacked${pathSep()}`)
  if (!path || !existsSync(path)) throw new Error('The audio decoder (ffmpeg) is missing from this installation')
  return path
}
const pathSep = () => (process.platform === 'win32' ? '\\' : '/')

function run(file: string, args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 * 1024, windowsHide: true, timeout: 30 * 60_000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout as Buffer, stderr: (stderr as Buffer).toString('utf8'), code: err ? ((err as { code?: number }).code ?? 1) : 0 })
    })
  })
}

/** Duration and tags, read from ffmpeg's description of the file. */
export async function probeAudio(path: string): Promise<AudioInfo> {
  const { stderr } = await run(await ffmpegPath(), ['-hide_banner', '-i', path])
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!d || !/Stream #\d+:\d+.*Audio:/.test(stderr)) throw new Error('No audio found in this file')
  const tag = (name: string) => new RegExp(`^\\s+${name}\\s*:\\s*(.+)$`, 'mi').exec(stderr)?.[1]?.trim()
  const artist = tag('artist') ?? tag('album_artist')
  const album = tag('album')
  return { durationSec: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]), music: !!(artist && album), title: tag('title') }
}

/** The recording as 16 kHz mono samples, which is what Whisper takes. */
export async function decodeAudio(path: string): Promise<Float32Array> {
  const { stdout, code, stderr } = await run(await ffmpegPath(), ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
  if (code !== 0 || !stdout.length) throw new Error(`Couldn't read the audio: ${stderr.split('\n')[0] || 'unknown format'}`)
  const copy = new Uint8Array(stdout.byteLength)
  copy.set(stdout)
  return new Float32Array(copy.buffer)
}

export type Transcriber = (audio: Float32Array) => Promise<SpeechSegment[]>

let transcriber: Promise<Transcriber> | null = null
let transcriberFor = ''
let override: Transcriber | null = null

/** Tests replace the model with a function. */
export function setTranscriber(fn: Transcriber | null): void { override = fn; transcriber = null }

/** Whisper, loaded once per models folder (downloading it the first time). */
function loadTranscriber(modelsDir: string): Promise<Transcriber> {
  if (override) return Promise.resolve(override)
  if (transcriber && transcriberFor === modelsDir) return transcriber
  transcriberFor = modelsDir
  transcriber = (async () => {
    if (process.platform === 'darwin' && process.arch === 'x64') throw new SpeechUnavailableError('Searching inside audio needs a Mac with Apple silicon, Windows or Linux.')
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = modelsDir
    env.allowLocalModels = false
    const asr = await pipeline('automatic-speech-recognition', SPEECH_MODEL, { dtype: 'q8' }) as unknown as (
      audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }>
    return async (audio: Float32Array) => {
      const out = await asr(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 })
      const chunks = out.chunks?.length ? out.chunks : [{ timestamp: [0, audio.length / 16000] as [number, number], text: out.text }]
      return chunks.map(c => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? c.timestamp[0] ?? 0, text: c.text.trim() })).filter(c => c.text)
    }
  })()
  transcriber.catch(() => { transcriber = null })   // try again next time (offline, say)
  return transcriber
}

export class SpeechUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SpeechUnavailableError' }
}

// One recording at a time: transcription uses every core it can get.
let queue: Promise<unknown> = Promise.resolve()

/** What's said in the recording, with timestamps. */
export function transcribe(path: string, modelsDir: string): Promise<SpeechSegment[]> {
  const job = queue.then(async () => (await loadTranscriber(modelsDir))(await decodeAudio(path)))
  queue = job.catch(() => {})
  return job
}

/** "2:05", or "1:02:05" past an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0')
}

/**
 * The transcript a page per minute, each line starting with its time ("[2:05] …"), so search results point to the
 * minute and the viewer can play from the line.
 */
export function transcriptPages(segments: SpeechSegment[]): string[] {
  const pages: string[][] = []
  for (const seg of segments) {
    const minute = Math.floor(seg.start / 60)
    while (pages.length <= minute) pages.push([])
    pages[minute]!.push(`[${clock(seg.start)}] ${seg.text}`)
  }
  return pages.map(lines => lines.join('\n'))
}
