import { ocrImage } from '../ocr/index.js'
import type { ExtractedDocument } from '../types.js'

export async function extractImage(path: string): Promise<ExtractedDocument> {
  const content = await ocrImage(path)
  return {
    path,
    format: 'image',
    content,
    metadata: { ocr: true, size: content.length },
  }
}
