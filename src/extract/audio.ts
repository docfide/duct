// Audio: what's said in a recording, transcribed on this computer (src/speech.ts), a page per minute.
import { statSync } from 'node:fs'
import { MAX_AUDIO_SECONDS, probeAudio, transcribe, transcriptPages } from '../speech.js'
import type { ExtractedDocument } from '../types.js'
import { UnsupportedFileError } from './common.js'

export async function extractAudio(path: string, modelsDir: string): Promise<ExtractedDocument> {
  const info = await probeAudio(path).catch(() => { throw new UnsupportedFileError('No audio found in this file') })
  // Music libraries aren't what audio search is for: songs carry an artist and an album.
  if (info.music) throw new UnsupportedFileError('A song, not a recording of speech')
  const metadata: Record<string, unknown> = { size: statSync(path).size, durationSec: Math.round(info.durationSec), ...(info.title ? { title: info.title } : {}) }
  if (info.durationSec > MAX_AUDIO_SECONDS) throw new Error(`It’s longer than ${MAX_AUDIO_SECONDS / 3600} hours, so Duct doesn’t transcribe it`)
  const pages = transcriptPages(await transcribe(path, modelsDir))
  return { path, format: 'audio', content: pages.join('\n'), pages, metadata }
}
