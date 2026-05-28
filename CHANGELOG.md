# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
