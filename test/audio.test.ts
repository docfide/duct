import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { categorize } from '../src/ledger.js'
import { clock, decodeAudio, ffmpegPath, probeAudio, setTranscriber, transcriptPages } from '../src/speech.js'

const dir = mkdtempSync(join(tmpdir(), 'duct-audio-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => setTranscriber(null))

/** A WAV of `seconds` of a quiet tone: real audio for ffmpeg to read; the words come from the stand-in model. */
function wav(path: string, seconds: number): string {
  const rate = 16000, n = rate * seconds
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 2000), 44 + i * 2)
  writeFileSync(path, buf)
  return path
}

describe('transcripts', () => {
  it('are a page per minute, each line with its time', () => {
    expect(clock(5)).toBe('0:05')
    expect(clock(125)).toBe('2:05')
    expect(clock(3725)).toBe('1:02:05')
    expect(transcriptPages([
      { start: 1, end: 4, text: 'Hi Ada, this is Chidi.' },
      { start: 50, end: 58, text: 'The rent is due on Friday.' },
      { start: 130, end: 140, text: 'Send the tenancy agreement.' },
    ])).toEqual(['[0:01] Hi Ada, this is Chidi.\n[0:50] The rent is due on Friday.', '', '[2:10] Send the tenancy agreement.'])
  })

  it('come from audio ffmpeg decodes to 16 kHz mono', async () => {
    const path = wav(join(dir, 'tone.wav'), 2)
    expect(await ffmpegPath()).toBeTruthy()
    expect((await probeAudio(path)).durationSec).toBeCloseTo(2, 1)
    const samples = await decodeAudio(path)
    expect(samples.length).toBeGreaterThan(31000)
    expect(samples.length).toBeLessThan(33000)
  })
})

describe('searching inside audio', () => {
  it('is off until turned on, then finds what was said, at its minute', async () => {
    const folder = join(dir, 'notes')
    mkdirSync(folder, { recursive: true })
    wav(join(folder, 'Voice note from Chidi.wav'), 3)
    let calls = 0
    setTranscriber(async samples => {
      calls++
      expect(samples.length).toBeGreaterThan(40000)
      return [{ start: 0.5, end: 2, text: 'Hi Ada, the pioneer status certificate arrived.' }, { start: 75, end: 80, text: 'The tax holiday starts in March.' }]
    })
    const duct = new Duct({ embed: false })
    await duct.index(folder)
    expect(calls).toBe(0)                                  // audio is off by default
    expect(await duct.search('pioneer')).toHaveLength(0)

    duct.setFeatures({ formats: { audio: true } })
    await duct.index(folder)
    expect(calls).toBe(1)
    const [hit] = await duct.search('tax holiday')
    expect(hit!.chunk.documentFormat).toBe('audio')
    expect(hit!.chunk.page).toBe(2)                       // 1:15 is in the second minute
    expect(hit!.chunk.content).toContain('[1:15] The tax holiday starts in March.')
    await duct.index(folder)
    expect(calls).toBe(1)                                  // unchanged recordings aren't transcribed again
  })

  it('leaves songs alone', async () => {
    const tone = wav(join(dir, 'tone2.wav'), 1)
    const song = join(dir, 'song.mp3')
    execFileSync(await ffmpegPath(), ['-y', '-v', 'error', '-i', tone, '-metadata', 'artist=Burna Boy', '-metadata', 'album=Twice as Tall', song])
    expect((await probeAudio(song)).music).toBe(true)
    let calls = 0
    setTranscriber(async () => { calls++; return [] })
    const duct = new Duct({ embed: false, features: { formats: { audio: true } } as never })
    await duct.index(song)
    expect(calls).toBe(0)
    expect(duct.getDocuments()).toHaveLength(0)
  })

  it('shows the speech model download in the privacy ledger', () => {
    expect(categorize('huggingface.co')).toBe('models')
    expect(categorize('cdn-lfs.huggingface.co')).toBe('models')
    expect(categorize('cas-bridge.xethub.hf.co')).toBe('models')
  })
})
