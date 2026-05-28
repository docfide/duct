**PRODUCT HUNT**

**Tagline**
> Turn any folder of documents into a searchable knowledge base — one command, no API keys, no cloud.

**Description**

Every team has documents they can't search. Contracts in PDFs, manuals in Word files, onboarding packets in Markdown — thousands of pages that answer questions nobody can find.

Existing solutions make you choose: pay for cloud infrastructure before you've proven the use case, or spend a week wiring together LangChain, a vector database, and a running model. Neither is right if you just need to search a few hundred files and get answers.

Duct is different. One command indexes your documents and serves a full web UI at localhost. BM25 search works fully offline with no API keys. If you want semantic search, plug in your OpenAI or Gemini key — but you never have to.

It handles PDFs, DOCX, Markdown, HTML, plain text, and images (with automatic OCR). Two chunking strategies. Drag-and-drop uploads. Persistent index across restarts. All in a single Node.js process with no build step.

Built by Tensflare, the team behind Docfide. MIT licensed.

```
npx @docfide/duct serve
```

That's it.

**Maker comment (first comment on launch day)**

Hey Product Hunt 👋

I'm [Name], co-founder of Tensflare. We build Docfide — a multi-agent contract platform — and Duct started as internal tooling.

We kept running into the same problem: we had folders of contracts, vendor agreements, and legal documents that we needed to search quickly during development and testing. Every solution we tried was either too heavy (LangChain + a vector DB + a running model) or too limited (basic grep-style search that missed context).

So we built Duct for ourselves — a document intelligence pipeline that takes a folder, indexes everything, and gives you a clean web UI to search it in minutes. BM25 out of the box so it works offline. Optional embeddings if you want semantic search. One npm command, no configuration files.

A few things that surprised us building it: pdfjs-dist v5 requires a DOMMatrix polyfill in Node.js that doesn't exist natively, images need contrast and deskew preprocessing before OCR produces reliable output, and FileList has no .indexOf() which will catch you once. We documented all of these so you don't have to learn them the hard way.

If you're building something on top of Duct — document pipelines, contract search, internal knowledge bases — we'd love to see it. And if your use case grows into full contract lifecycle management, that's what Docfide is for.

Try it: `npx @docfide/duct serve`

MIT licensed. All feedback welcome here or on GitHub.

---

**HACKER NEWS**

**Title**
> Show HN: Duct – index and search a folder of documents locally, one npm command

**Body**

We built Duct after getting frustrated with the gap between "I have 300 PDFs to search" and the solutions that exist for it.

The options are roughly: pay for embeddings and cloud vector storage before you've proven anything works, wrangle LangChain into doing what you want (it will), or write your own pipeline (we did this three times before deciding to make it reusable).

Duct is a document intelligence pipeline: give it a folder, it extracts text, chunks it, indexes it, and serves a web UI. Single Node.js process, no configuration files, no external dependencies unless you want semantic search.

**What it does:**

- Extracts from PDF (pdfjs-dist v5), DOCX (mammoth), Markdown, HTML, plain text, and images (sharp + tesseract.js for OCR)
- Two chunking strategies: sliding window (default, 1500 chars with 200 char overlap) and by heading (splits on Markdown # structure)
- BM25 search by default — implemented from scratch in ~80 lines of TypeScript, fully offline, no API keys
- Optional semantic search via OpenAI (text-embedding-3-small/large) or Gemini (text-embedding-004) if you set the key
- Web UI served inline from the same Express process — no build step, no CDN dependencies
- `--persist` flag to serialize the index to disk and survive restarts

```bash
npx @docfide/duct serve
```

**A few things we learned building it:**

pdfjs-dist v5 is significantly more reliable than pdf-parse for text extraction quality, but it needs a DOMMatrix polyfill in Node.js. We ship one that tries the npm canvas package first and falls back to a minimal 2D affine implementation. It also rejects Buffer — you must explicitly convert: `new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)`.

For scanned PDFs, we render each page to a canvas and run the same OCR pipeline as images (sharp for preprocessing, tesseract.js for recognition). This is gated behind an `--ocr` flag since it's 10–20x slower than native text extraction.

FileList from drag-and-drop has no `.indexOf()`. Convert with `Array.from()` before iterating.

BM25 works better than we expected for contract and legal document search — better than cosine similarity on short queries like "termination clause" or "governing law" where you want exact term matching rather than semantic proximity. We default to it and let users opt into embeddings.

**Why we built it:**

We're building Docfide (multi-agent CLM platform) at Tensflare. Duct started as our internal document search tool during development. We also recently shipped Condicio — an open schema standard for representing extracted contract intelligence data — and Duct is the natural upstream tool: index raw documents with Duct, output structured data conforming to Condicio.

MIT licensed. GitHub: github.com/docfide/duct. Demo: duct.docfide.com.

Happy to answer questions about the BM25 implementation, the OCR pipeline, or the extraction edge cases. There are a lot of edge cases.

---

A few notes on timing: post the HN Show HN at 8–9am EST on a weekday and stay present all day. The Duct technical story — especially the pdfjs-dist discoveries — is exactly what HN rewards. Product Hunt the same day or the day after, not both on the same day.