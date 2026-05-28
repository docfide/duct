import type { TableData } from '../types.js'

const TABLE_LINE_LENGTH_MIN = 40
const TABLE_DELIMITER_THRESHOLD = 0.6

export function detectTables(text: string): TableData[] {
  const lines = text.split('\n')
  const tables: TableData[] = []
  let inTable = false
  let tableLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length < TABLE_LINE_LENGTH_MIN) {
      if (inTable) {
        const table = parseTableLines(tableLines)
        if (table) tables.push(table)
        tableLines = []
        inTable = false
      }
      continue
    }

    const colonCount = (trimmed.match(/:/g) || []).length
    const pipeCount = (trimmed.match(/\|/g) || []).length
    const spaceBlocks = countSpaceBlocks(trimmed)
    const delimiterRatio = pipeCount > 0
      ? pipeCount / (trimmed.length / 15)
      : spaceBlocks / (trimmed.length / 20)

    if (pipeCount >= 2 || delimiterRatio > TABLE_DELIMITER_THRESHOLD) {
      tableLines.push(line)
      inTable = true
    } else if (inTable) {
      const table = parseTableLines(tableLines)
      if (table) tables.push(table)
      tableLines = []
      inTable = false
    }
  }

  if (inTable) {
    const table = parseTableLines(tableLines)
    if (table) tables.push(table)
  }

  return tables
}

function countSpaceBlocks(s: string): number {
  let count = 0
  let inSpace = false
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') {
      if (!inSpace) { count++; inSpace = true }
    } else {
      inSpace = false
    }
  }
  return count
}

function parseTableLines(lines: string[]): TableData | null {
  const valid = lines.filter(l => l.trim().length > 0)
  if (valid.length < 3) return null

  const pipeLines = valid.filter(l => l.includes('|'))
  if (pipeLines.length >= 2) {
    return parsePipeTable(pipeLines)
  }

  return parseWhitespaceTable(valid)
}

function parsePipeTable(lines: string[]): TableData {
  const dataLines = lines.filter(l => l.includes('|') && !/^[\s|:-]+$/.test(l))
  if (dataLines.length === 0) return { headers: [], rows: [] }

  const parseRow = (line: string): string[] =>
    line.split('|').map(c => c.trim()).filter(c => c.length > 0)

  const headers = parseRow(dataLines[0])
  const rows = dataLines.slice(1).map(parseRow)
  return { headers, rows }
}

function parseWhitespaceTable(lines: string[]): TableData | null {
  const tokenCounts = lines.map(l => l.trim().split(/\s{2,}/).length)
  const median = tokenCounts.sort((a, b) => a - b)[Math.floor(tokenCounts.length / 2)]
  if (median < 2) return null

  const parseRow = (line: string): string[] =>
    line.trim().split(/\s{2,}/).map(c => c.trim()).filter(c => c.length > 0)

  const headers = parseRow(lines[0])
  const rows = lines.slice(1).map(parseRow).filter(r => r.length >= median - 1)
  return { headers, rows }
}

export function tableToMarkdown(table: TableData): string {
  if (table.headers.length === 0 && table.rows.length === 0) return ''

  const header = '| ' + table.headers.join(' | ') + ' |'
  const separator = '| ' + table.headers.map(() => '---').join(' | ') + ' |'
  const rows = table.rows.map(r => '| ' + r.join(' | ') + ' |')
  return [header, separator, ...rows].join('\n')
}

export function extractTablesFromContent(content: string): string {
  const tables = detectTables(content)
  if (tables.length === 0) return content
  const tableMd = tables.map(tableToMarkdown).filter(Boolean).join('\n\n')
  return content + '\n\n<!-- extracted tables -->\n\n' + tableMd
}
