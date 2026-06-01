# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Metadata & Search Docs

### Added
- **Document Metadata**: `duct.index(path, metadata)` attaches arbitrary key-value pairs to documents and their chunks. Metadata persists across save/load cycles.
- **Metadata Filtering**: `duct.search(query, topK, filter)` scopes results by exact metadata match. Exposed via API as `?filter={...}` query param.
- **`duct.getDocument(path)`**: Retrieve a single document's info including metadata.
- **New file formats**: CSV, JSON, LOG, XML, XLSX, PPTX — 21 supported extensions total.
- **Scoring, Ranking & Re-ranking documentation**: Full explanation in `docs/search.md` of BM25 scoring, cosine similarity, RRF fusion, result ordering, and the `SimpleReranker` algorithm with its weights and signals.

### Changed
- `DocumentInfo.metadata` field added to public interface.
- `GET /api/documents?path=` returns a single document.
- `POST /api/index` accepts `metadata` in JSON body and multipart form.
- `docs/library.md` updated with all new method signatures and documented `Reranker`, `LLMProvider`, `EmbeddingProvider`, `VectorStore`, and `Searcher` interfaces.

## [0.1.0] - Initial Release

### Added
- **Core CLI Pipeline**: A unified pipeline to ingest, extract, embed, and search documents.
- **Watch Mode**: `duct.watch()` to continuously monitor directories and auto-ingest file changes.
- **Flow × Lime Dashboard**: A fast, local, offline-first web UI (`duct serve`) for querying documents.
- **Multi-Modal Extractors**: Support for parsing PDF, DOCX, Markdown, and Web URLs.
- **OCR Engine**: Tesseract.js integration for extracting text from images automatically.
- **RAG & Agentic QA**: `duct ask` with integrated Ollama support for offline, local, cited answering.
- **Hybrid Search Engine**: Integrated BM25 + Vector similarity search functionality.
- **Export Capabilities**: API and CLI support for `--json` exports.
