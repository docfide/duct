# Supported formats

Duct reads these formats. The list lives in one place, `src/formats.ts`. The indexer, the server's upload filter, the web UI, the desktop dialogs and the island all use it.

| Kind | Extensions | Notes |
|---|---|---|
| PDF | .pdf | Results show the page. Scanned PDFs are flagged for OCR, or read with OCR when it's on |
| Word | .docx .docm .dotx .dotm, .doc .dot | Legacy .doc includes text boxes, footnotes, endnotes and comments. Misnamed files (a .doc that is really .docx or RTF, and the reverse) are detected |
| OpenDocument | .odt .ott, .ods .ots, .odp .otp | Slides and sheets are pages |
| Rich Text | .rtf | Unicode and Windows code pages, including Chinese, Japanese, Korean and Cyrillic |
| Apple iWork | .pages .numbers .key | Modern files are read from their `.iwa` archives. iWork '09 files use their preview PDF; otherwise the thumbnail is OCR'd when OCR is on. Package folders are supported. A `.key` file that isn't a Keynote deck (e.g. a TLS private key) is skipped |
| Spreadsheets | .xlsx .xlsm .xls .xlsb, .ods | One page per sheet ("sheet 2") |
| Presentations | .pptx .pptm .ppsx .potx, .odp, .key | One page per slide, with speaker notes |
| E-books | .epub | One page per chapter ("ch. 3"). DRM-protected books are reported as unreadable |
| Audio | .mp3 .m4a .wav .ogg .oga .opus .flac .aac .amr .wma .aiff .aif .caf .3gp | Off until turned on (Settings › Features › Audio and voice notes). What's said is transcribed on this computer with Whisper (base, about 77 MB, downloaded once the first time; the privacy ledger lists it under On-device models). The transcript is a page per minute, each line with its time; results say "at 2:00" and open the recording there. Files tagged with an artist and an album are taken as songs and skipped; recordings over 3 hours aren't transcribed. Not available on Intel Macs |
| Email | .eml, .msg (Outlook) | Subject, sender, recipients, date and body are searchable. Supported attachments are indexed under "Attachment: name" |
| Web and Markdown | .html .htm .xhtml, .md .markdown .mdx | |
| Text | .txt .text .csv .tsv .json .jsonl .ndjson .log .xml .yaml .yml .toml .ini .cfg .conf .tex .bib .rst .adoc .asciidoc .org .nfo .srt .vtt | UTF-8, UTF-16 and Windows-1252 are detected. Subtitles keep only the spoken lines |
| Source code | .js .ts .py .go .rs .java .swift .c .cpp .cs .php .rb .sh .sql .css … | |
| Images | .png .jpg .jpeg .tif .tiff .bmp .gif .webp .avif .heic .heif, .svg | Read with OCR when it's on. HEIC uses macOS's `sips`, or the optional `heic-decode` package elsewhere. SVG text labels are read without OCR |
| Archives | .zip | Supported files inside are indexed under their path in the archive. Up to 500 files and 300 MB, nested up to two levels |

Duct skips `.env` files (they usually hold secrets), hidden files, Office lock files (`~$…`), and folders such as `node_modules`, `.git`, caches and the Trash.
