import crypto from 'node:crypto'
import type { Chunk, DocumentFormat } from '../types.js'

function id(): string {
  return crypto.randomUUID()
}

export function chunkSlidingWindow(
  text: string,
  documentPath: string,
  format: DocumentFormat,
  size: number,
  overlap: number,
): Chunk[] {
  if (size <= 0 || text.length === 0) return []
  const chunks: Chunk[] = []
  let start = 0
  let index = 0
  while (start < text.length) {
    const end = Math.min(start + size, text.length)
    if (end <= start) break
    chunks.push({
      id: id(),
      documentPath,
      documentFormat: format,
      content: text.slice(start, end).trim(),
      index: index++,
      metadata: {},
    })
    start += size - overlap
  }
  return chunks
}

function flushChunk(
  chunks: Chunk[],
  lines: string[],
  heading: string,
  format: DocumentFormat,
  documentPath: string,
): void {
  const text = lines.join('\n').trim()
  if (!text) return
  chunks.push({
    id: id(),
    documentPath,
    documentFormat: format,
    content: text,
    index: chunks.length,
    heading: heading || undefined,
    metadata: {},
  })
}

export function chunkByHeading(
  content: string,
  documentPath: string,
  format: DocumentFormat,
): Chunk[] {
  if (format === 'md') {
    return chunkMarkdownByHeading(content, documentPath)
  }
  const lines = content.split('\n')
  const chunks: Chunk[] = []
  let currentHeading = ''
  let currentLines: string[] = []
  let inFrontMatter = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '---') {
      inFrontMatter = !inFrontMatter
      currentLines.push(line)
      continue
    }
    if (inFrontMatter) {
      currentLines.push(line)
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    const capsMatch =
      trimmed.length > 2 &&
      trimmed.length < 120 &&
      trimmed === trimmed.toUpperCase() &&
      /[A-Z][A-Z\s]{2,}/.test(trimmed)
    const numberedMatch = trimmed.match(/^(\d+(?:\.\d+)*)\s+[A-Z]/)

    if (headingMatch) {
      flushChunk(chunks, currentLines, currentHeading, format, documentPath)
      currentHeading = headingMatch[2]
      currentLines = [line]
    } else if (capsMatch && currentLines.length > 2) {
      flushChunk(chunks, currentLines, currentHeading, format, documentPath)
      currentHeading = trimmed
      currentLines = [line]
    } else if (numberedMatch && currentLines.length > 2) {
      flushChunk(chunks, currentLines, currentHeading, format, documentPath)
      currentHeading = trimmed
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flushChunk(chunks, currentLines, currentHeading, format, documentPath)
  return chunks
}

function chunkMarkdownByHeading(content: string, documentPath: string): Chunk[] {
  const lines = content.split('\n')
  const chunks: Chunk[] = []
  let currentHeading = ''
  let currentLines: string[] = []
  let inFrontMatter = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '---' && currentLines.length === 0) {
      inFrontMatter = !inFrontMatter
      currentLines.push(line)
      continue
    }
    if (inFrontMatter) {
      currentLines.push(line)
      if (trimmed === '---') inFrontMatter = false
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      flushChunk(chunks, currentLines, currentHeading, 'md', documentPath)
      currentHeading = headingMatch[2]
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flushChunk(chunks, currentLines, currentHeading, 'md', documentPath)
  return chunks
}

export function chunk(
  text: string,
  documentPath: string,
  format: DocumentFormat,
  strategy: 'sliding-window' | 'by-heading' = 'sliding-window',
  size = 1500,
  overlap = 200,
): Chunk[] {
  if (!text || !text.trim()) return []
  if (strategy === 'by-heading') {
    return chunkByHeading(text, documentPath, format)
  }
  return chunkSlidingWindow(text, documentPath, format, size, overlap)
}
