import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { ExtractedDocument, DocumentFormat, Extractor } from '../types.js'

export function detectFormat(path: string): DocumentFormat {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.pdf':
      return 'pdf'
    case '.docx':
      return 'docx'
    case '.md':
    case '.markdown':
      return 'md'
    case '.html':
    case '.htm':
      return 'html'
    case '.txt':
      return 'txt'
    default:
      return 'txt'
  }
}

async function extractPdf(path: string): Promise<ExtractedDocument> {
  const pdfParse = (await import('pdf-parse')).default
  const buffer = readFileSync(path)
  const data = await pdfParse(buffer)
  return {
    path,
    format: 'pdf',
    content: data.text,
    metadata: {
      pages: data.numpages,
      title: data.info?.Title || null,
      author: data.info?.Author || null,
      size: buffer.length,
    },
  }
}

async function extractDocx(path: string): Promise<ExtractedDocument> {
  const mammoth = await import('mammoth')
  const buffer = readFileSync(path)
  const result = await mammoth.extractRawText({ buffer })
  return {
    path,
    format: 'docx',
    content: result.value,
    metadata: {
      size: buffer.length,
      warnings: result.messages,
    },
  }
}

async function extractMarkdown(path: string): Promise<ExtractedDocument> {
  const { marked } = await import('marked')
  const content = readFileSync(path, 'utf-8')
  const tokens = marked.lexer(content)
  const headings = []
  const textParts = []
  for (const token of tokens) {
    if (token.type === 'heading') {
      const t = token as { depth: number; text: string }
      headings.push({ level: t.depth, text: t.text })
    } else if (token.type === 'paragraph' || token.type === 'text' || token.type === 'list' || token.type === 'code') {
      const t = token as { text: string }
      textParts.push(t.text)
    }
  }
  return {
    path,
    format: 'md',
    content: content,
    metadata: { headings, size: content.length },
  }
}

async function extractHtml(path: string): Promise<ExtractedDocument> {
  const cheerio = await import('cheerio')
  const content = readFileSync(path, 'utf-8')
  const $ = cheerio.load(content)
  $('script, style, nav, footer, header').remove()
  const text = $('body').text().replace(/\s+/g, ' ').trim()
  return {
    path,
    format: 'html',
    content: text,
    metadata: {
      title: $('title').text() || null,
      size: content.length,
    },
  }
}

async function extractText(path: string): Promise<ExtractedDocument> {
  const content = readFileSync(path, 'utf-8')
  return {
    path,
    format: 'txt',
    content,
    metadata: { size: content.length },
  }
}

const extractors: Record<DocumentFormat, Extractor> = {
  pdf: { extract: extractPdf },
  docx: { extract: extractDocx },
  md: { extract: extractMarkdown },
  html: { extract: extractHtml },
  txt: { extract: extractText },
}

export async function extract(path: string): Promise<ExtractedDocument> {
  const format = detectFormat(path)
  return extractors[format].extract(path)
}
