// The single list of file types Duct can read. Everything else (the indexer, the server's upload filter,
// the web UI's file picker, the desktop dialogs and the island's drop zone) derives from it, so adding a
// format means adding it here and writing its extractor in src/extract/.
import { basename, extname } from 'node:path'
import type { DocumentFormat } from './types.js'

export type FormatKind = 'document' | 'spreadsheet' | 'presentation' | 'ebook' | 'email' | 'text' | 'code' | 'image' | 'archive'

export interface FileFormat {
  format: DocumentFormat
  extensions: string[]
  /** Shown to people, e.g. "Word 97–2003". */
  label: string
  kind: FormatKind
  /** What a chunk's `page` means for this format, e.g. "slide 4" or "sheet 2". Defaults to "p.". */
  pageLabel?: string
}

export const FORMATS: FileFormat[] = [
  { format: 'pdf', extensions: ['.pdf'], label: 'PDF', kind: 'document' },
  { format: 'docx', extensions: ['.docx', '.docm', '.dotx', '.dotm'], label: 'Word', kind: 'document' },
  { format: 'doc', extensions: ['.doc', '.dot'], label: 'Word 97–2003', kind: 'document' },
  { format: 'odt', extensions: ['.odt', '.ott'], label: 'OpenDocument Text', kind: 'document' },
  { format: 'rtf', extensions: ['.rtf'], label: 'Rich Text', kind: 'document' },
  { format: 'pages', extensions: ['.pages'], label: 'Apple Pages', kind: 'document' },
  { format: 'md', extensions: ['.md', '.markdown', '.mdx'], label: 'Markdown', kind: 'document' },
  { format: 'html', extensions: ['.html', '.htm', '.xhtml'], label: 'HTML', kind: 'document' },
  { format: 'epub', extensions: ['.epub'], label: 'EPUB', kind: 'ebook', pageLabel: 'ch.' },
  { format: 'xlsx', extensions: ['.xlsx', '.xlsm', '.xls', '.xlsb'], label: 'Excel', kind: 'spreadsheet', pageLabel: 'sheet' },
  { format: 'ods', extensions: ['.ods', '.ots'], label: 'OpenDocument Spreadsheet', kind: 'spreadsheet', pageLabel: 'sheet' },
  { format: 'numbers', extensions: ['.numbers'], label: 'Apple Numbers', kind: 'spreadsheet' },
  { format: 'pptx', extensions: ['.pptx', '.pptm', '.ppsx', '.potx'], label: 'PowerPoint', kind: 'presentation', pageLabel: 'slide' },
  { format: 'odp', extensions: ['.odp', '.otp'], label: 'OpenDocument Presentation', kind: 'presentation', pageLabel: 'slide' },
  { format: 'key', extensions: ['.key'], label: 'Apple Keynote', kind: 'presentation', pageLabel: 'slide' },
  { format: 'eml', extensions: ['.eml'], label: 'Email', kind: 'email' },
  { format: 'msg', extensions: ['.msg'], label: 'Outlook email', kind: 'email' },
  {
    format: 'txt',
    // .env is deliberately absent: it usually holds secrets.
    extensions: ['.txt', '.text', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.log', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.tex', '.bib', '.rst', '.adoc', '.asciidoc', '.org', '.srt', '.vtt', '.nfo'],
    label: 'Text',
    kind: 'text',
  },
  {
    format: 'code',
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp',
      '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.r', '.m', '.scala', '.lua', '.pl', '.dart', '.vue', '.svelte', '.css',
      '.scss', '.less', '.gradle', '.tf', '.proto', '.graphql'],
    label: 'Source code',
    kind: 'code',
  },
  { format: 'svg', extensions: ['.svg'], label: 'SVG', kind: 'image' },
  { format: 'image', extensions: ['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp', '.heic', '.heif', '.avif'], label: 'Image (OCR)', kind: 'image' },
  { format: 'zip', extensions: ['.zip'], label: 'ZIP archive', kind: 'archive' },
]

const BY_EXTENSION = new Map(FORMATS.flatMap(f => f.extensions.map(ext => [ext, f] as const)))

export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(BY_EXTENSION.keys())
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(FORMATS.find(f => f.format === 'image')!.extensions)

/** Apple iWork documents can be folders ("packages") on disk rather than single files. */
export const PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.pages', '.numbers', '.key'])

/** Folders never worth indexing: dependencies, version control, caches, build output and the Trash. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vscode', 'target', '.Trash', '.Trashes', '$RECYCLE.BIN', '.duct-uploads',
])

export function formatForPath(path: string): FileFormat | undefined {
  return BY_EXTENSION.get(extname(path).toLowerCase())
}

/** Supported extension, and not a temporary or hidden file (Office lock files "~$…", ".DS_Store", "._…"). */
export function isSupportedFile(path: string): boolean {
  const name = basename(path)
  if (name.startsWith('.') || name.startsWith('~$')) return false
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Whether a folder should be skipped while walking a directory tree (hidden folders included). */
export function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name)
}

/** "slide", "sheet", "ch." or "p." for a document format. */
export function pageLabel(format: DocumentFormat): string {
  return FORMATS.find(f => f.format === format)?.pageLabel ?? 'p.'
}

/** For <input type="file" accept="…">. */
export const ACCEPT_ATTRIBUTE = [...SUPPORTED_EXTENSIONS].join(',')

/** Short human list, e.g. for the drop zone: "PDF, Word, Excel, PowerPoint, …". */
export const SUPPORTED_SUMMARY = 'PDF, Word, Excel, PowerPoint, OpenDocument, Apple iWork, RTF, EPUB, email, Markdown, HTML, text, code, images and ZIP'

/** Electron open-dialog filters (extensions without dots). */
export function dialogFilters(): { name: string; extensions: string[] }[] {
  const noDot = (exts: Iterable<string>) => [...exts].map(e => e.slice(1))
  const documents = FORMATS.filter(f => f.kind !== 'image' && f.kind !== 'code').flatMap(f => f.extensions)
  return [
    { name: 'All supported files', extensions: noDot(SUPPORTED_EXTENSIONS) },
    { name: 'Documents', extensions: noDot(documents) },
    { name: 'Images', extensions: noDot(FORMATS.filter(f => f.kind === 'image').flatMap(f => f.extensions)) },
  ]
}
