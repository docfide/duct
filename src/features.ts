import { FORMATS, formatForPath } from './formats.js'
import type { FormatKind } from './formats.js'
import type { DocumentFormat } from './types.js'

/**
 * Features that can be switched off one by one, by the person using Duct or by an admin of a shared server.
 * Everything is on by default. Off means off everywhere: the library refuses, the server answers 403 and the
 * UI hides the control.
 */
export interface Features {
  /** Ask questions and get answers written by an AI model (Labs). */
  ask: boolean
  /** Search by meaning with an embedding model. Off: no passages are sent to an embedding provider. */
  semanticSearch: boolean
  /** Pull structured fields out of documents with an AI model. */
  schemaExtraction: boolean
  /** Match file names as well as document text. */
  fileNameSearch: boolean
  /** Add web pages by URL. */
  webPages: boolean
  /** Add files through the app or the API (they are copied into the Library). */
  uploads: boolean
  /** Watch folders and keep them indexed. */
  watchedFolders: boolean
  /** Read one scanned document with OCR on request. */
  ocrOnDemand: boolean
  /** Export search results as CSV or JSON. */
  export: boolean
  /** Compare versions of a document. */
  diff: boolean
  /** The developer API (/v1): collections, API keys and indexing your own text by id. */
  developerApi: boolean
  /** The deadlines radar: expiry, due and renewal dates read from documents, on this computer. */
  deadlines: boolean
  /** Public links to notebooks on a server with sign-in: anyone with the link can read the notebook. */
  publicLinks: boolean
  /** File types Duct reads, by family. Off: those files are skipped when indexing and hidden from search. */
  formats: Record<FormatKind, boolean>
}

export type FeatureName = Exclude<keyof Features, 'formats'>

export const FORMAT_KINDS: FormatKind[] = ['document', 'spreadsheet', 'presentation', 'ebook', 'email', 'text', 'code', 'image', 'audio', 'archive']

export const FEATURE_NAMES: FeatureName[] = [
  'ask', 'semanticSearch', 'schemaExtraction', 'fileNameSearch', 'webPages', 'uploads', 'watchedFolders', 'ocrOnDemand', 'export', 'diff', 'developerApi', 'deadlines', 'publicLinks',
]

/** Labels for settings screens and error messages. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  ask: 'Ask',
  semanticSearch: 'Search by meaning',
  schemaExtraction: 'Field extraction',
  fileNameSearch: 'File name search',
  webPages: 'Web pages',
  uploads: 'Adding files',
  watchedFolders: 'Watched folders',
  ocrOnDemand: 'OCR on request',
  export: 'Export',
  diff: 'Version comparison',
  developerApi: 'Developer API',
  deadlines: 'Deadlines radar',
  publicLinks: 'Public notebook links',
}

export function defaultFeatures(): Features {
  return {
    ...Object.fromEntries(FEATURE_NAMES.map(n => [n, true])) as Record<FeatureName, boolean>,
    // Audio is off until someone turns it on: transcribing downloads a speech model, and music folders aren't speech.
    formats: Object.fromEntries(FORMAT_KINDS.map(k => [k, k !== 'audio'])) as Record<FormatKind, boolean>,
  }
}

export type FeaturesPatch = Partial<Record<FeatureName, boolean>> & { formats?: Partial<Record<FormatKind, boolean>> }

/** Applies a patch, keeping only known names with boolean values. Throws on anything else. */
export function mergeFeatures(base: Features, patch: unknown): Features {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('Features must be an object')
  const next: Features = { ...base, formats: { ...base.formats } }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === 'formats') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('"formats" must be an object')
      for (const [kind, on] of Object.entries(value as Record<string, unknown>)) {
        if (!FORMAT_KINDS.includes(kind as FormatKind)) throw new Error(`Unknown file family: ${kind}`)
        if (typeof on !== 'boolean') throw new Error(`"formats.${kind}" must be true or false`)
        next.formats[kind as FormatKind] = on
      }
    } else {
      if (!FEATURE_NAMES.includes(key as FeatureName)) throw new Error(`Unknown feature: ${key}`)
      if (typeof value !== 'boolean') throw new Error(`"${key}" must be true or false`)
      next[key as FeatureName] = value
    }
  }
  return next
}

/** Thrown when a switched-off feature is used. The server turns it into a 403. */
export class FeatureDisabledError extends Error {
  constructor(readonly feature: FeatureName | `formats.${FormatKind}`) {
    const label = feature.startsWith('formats.') ? `Reading ${feature.slice(8)} files` : FEATURE_LABELS[feature as FeatureName]
    super(`${label} is turned off in Settings.`)
    this.name = 'FeatureDisabledError'
  }
}

/** Formats whose family is switched on, or undefined when every family is on. */
export function enabledFormats(features: Features): DocumentFormat[] | undefined {
  if (FORMAT_KINDS.every(k => features.formats[k])) return undefined
  // Web pages aren't a file family: the webPages switch stops new ones, existing ones stay searchable.
  return [...FORMATS.filter(f => features.formats[f.kind]).map(f => f.format), 'url']
}

/** Whether a file of this path may be indexed. Paths of unknown type are left to the extractor. */
export function formatAllowed(features: Features, path: string): boolean {
  const f = formatForPath(path)
  return !f || features.formats[f.kind]
}
