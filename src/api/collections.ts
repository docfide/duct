import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../index.js'
import type { RuntimeConfig } from '../types.js'

/** Lower-case letters, digits, "-" and "_", starting with a letter or digit; at most 63 characters. */
export const COLLECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

export interface CollectionSettings {
  searchMode?: RuntimeConfig['searchMode']
  ocr?: boolean
}

/**
 * Collections for the developer API: each is its own index (its own SQLite file under
 * <data>/collections/<name>), so one app's or one customer's documents never mix with another's or with
 * the files Duct indexes for people. New collections copy the main index's chunking, search and
 * embedding settings. Without a data directory they live in memory.
 */
export class Collections {
  private open = new Map<string, Duct>()
  private memoryFiles = new Map<string, string>()

  constructor(private parent: Duct, readonly root: string | null = parent.dataDir ? join(parent.dataDir, 'collections') : null) {}

  list(): string[] {
    if (!this.root) return [...this.open.keys()].sort()
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter(e => e.isDirectory() && COLLECTION_NAME.test(e.name) && existsSync(join(this.root!, e.name, 'duct.db')))
      .map(e => e.name)
      .sort()
  }

  has(name: string): boolean {
    return COLLECTION_NAME.test(name) && (this.open.has(name) || (!!this.root && existsSync(join(this.root, name, 'duct.db'))))
  }

  /** The collection's index, opened on first use. Undefined if it doesn't exist. */
  get(name: string): Duct | undefined {
    if (!this.has(name)) return undefined
    return this.open.get(name) ?? this.openIndex(name)
  }

  create(name: string, settings: CollectionSettings = {}): Duct {
    if (!COLLECTION_NAME.test(name)) throw new Error('Collection names use lower-case letters, digits, "-" and "_" (up to 63 characters)')
    if (this.has(name)) throw new Error(`Collection "${name}" already exists`)
    const duct = this.openIndex(name)
    const cfg = this.parent.getConfig()
    duct.configure({
      chunkStrategy: cfg.chunkStrategy, chunkSize: cfg.chunkSize, chunkOverlap: cfg.chunkOverlap,
      searchMode: settings.searchMode ?? cfg.searchMode, searchAlpha: cfg.searchAlpha, rerank: cfg.rerank, ocr: settings.ocr ?? cfg.ocr,
      ...(this.parent.semanticAvailable() && cfg.embedProvider ? { embedProvider: cfg.embedProvider, embedModel: cfg.embedModel, embedBaseUrl: cfg.embedBaseUrl } : {}),
    })
    return duct
  }

  delete(name: string): boolean {
    if (!this.has(name)) return false
    this.open.get(name)?.close()
    this.open.delete(name)
    if (this.root) rmSync(join(this.root, name), { recursive: true, force: true })
    const files = this.memoryFiles.get(name)
    if (files) rmSync(files, { recursive: true, force: true })
    this.memoryFiles.delete(name)
    return true
  }

  /** Where uploaded files for a collection are kept. */
  filesDir(name: string): string {
    if (this.root) return join(this.root, name, 'files')
    let dir = this.memoryFiles.get(name)
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), `duct-collection-${name}-`))
      this.memoryFiles.set(name, dir)
    }
    return dir
  }

  close(): void {
    for (const duct of this.open.values()) duct.close()
    this.open.clear()
    for (const dir of this.memoryFiles.values()) rmSync(dir, { recursive: true, force: true })
    this.memoryFiles.clear()
  }

  private openIndex(name: string): Duct {
    const dir = this.root ? join(this.root, name) : undefined
    if (dir) mkdirSync(dir, { recursive: true })
    const duct = new Duct({
      persistPath: dir,
      // No embedding model in the main index (or search by meaning switched off): none here either.
      ...(this.parent.semanticAvailable() ? {} : { embed: false as const }),
      // API documents come from apps on the network: never fetch private addresses for them.
      blockPrivateUrls: true,
      features: { watchedFolders: false, semanticSearch: this.parent.getFeatures().semanticSearch },
    })
    this.open.set(name, duct)
    return duct
  }
}
