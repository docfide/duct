// Minimal types for word-extractor (the package ships none).
declare module 'word-extractor' {
  interface TextOptions { filterUnicode?: boolean }
  interface WordDocument {
    getBody(options?: TextOptions): string
    getFootnotes(options?: TextOptions): string
    getEndnotes(options?: TextOptions): string
    getHeaders(options?: TextOptions & { includeFooters?: boolean }): string
    getFooters(options?: TextOptions): string
    getAnnotations(options?: TextOptions): string
    getTextboxes(options?: TextOptions & { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>
  }
}
