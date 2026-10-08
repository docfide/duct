import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { hashBytes, type Duct } from './index.js'
import type { IndexResult } from './types.js'

/** The default folder where uploaded and added files are kept: ~/Duct Library. */
export function defaultLibraryDir(): string {
  return join(homedir(), 'Duct Library')
}

export interface LibraryResult extends IndexResult {
  file: string
  /** Where the copy was stored in the library. */
  path?: string
  /** Set when identical bytes were already indexed; nothing was copied. */
  duplicateOf?: string
}

/** Strips directories and characters that are unsafe in file names, keeping the extension. */
export function safeFileName(name: string): string {
  const ext = extname(name).toLowerCase()
  const stem = basename(name, extname(name))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180)
  return (stem || 'document') + ext
}

function uniquePath(dir: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext)
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`)
  return candidate
}

/**
 * Keeps a copy of a file in the library and indexes the copy. Identical content that is already
 * indexed (anywhere) is reported as a duplicate instead of being stored twice.
 */
export async function addToLibrary(
  duct: Duct,
  libraryDir: string,
  sourcePath: string,
  options: { originalName?: string; metadata?: Record<string, unknown>; move?: boolean } = {},
): Promise<LibraryResult> {
  const originalName = options.originalName ?? basename(sourcePath)
  const hash = hashBytes(readFileSync(sourcePath))
  const existing = duct.findDocumentByHash(hash)
  if (existing) {
    if (options.move) unlinkSync(sourcePath)
    return { file: originalName, documents: 0, chunks: 0, time: 0, duplicateOf: existing.displayName ?? existing.path }
  }

  mkdirSync(libraryDir, { recursive: true })
  const target = uniquePath(libraryDir, safeFileName(originalName))
  if (options.move) renameSync(sourcePath, target)
  else copyFileSync(sourcePath, target)

  const result = await duct.index(target, options.metadata, { source: 'library', displayName: originalName })
  return { file: originalName, path: target, ...result }
}
