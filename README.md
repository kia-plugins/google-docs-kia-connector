# Google Docs connector for KIAgent

Indexes your Google Drive into your local KIAgent digital memory: native
Google Docs become markdown documents, and the files around them (PDFs,
Office files, text, images) are extracted or OCR'd by the platform — all
kept in sync automatically.

## Install

Install **Google Docs** from the KIAgent marketplace (Settings → Extensions →
Marketplace → Google Docs → Install). KIAgent will ask for the two grants this
connector needs before it activates:

- `net` — to talk to `www.googleapis.com`;
- `query` — to check what is already indexed, so unchanged files are never
  re-downloaded.

## Connect your Drive

1. Add a Google Docs account. A Google sign-in window opens — the OAuth flow
   is owned entirely by the platform. The connector requests the read-only
   scope `https://www.googleapis.com/auth/drive.readonly` and never sees your
   Google password; tokens live in KIAgent's encrypted vault and are
   refreshed by the platform.
2. Optionally paste a Google Drive **folder URL or ID** when prompted to index
   only that folder. Leave the field blank to index all of **My Drive**.
3. The account shows up under your Google account's email address and
   backfills from there, then checks for changes every 15 minutes.

You can connect multiple Google accounts side by side.

## What gets indexed

- **Native Google Docs** — exported as Markdown (with a plain-text fallback);
  deep links back to the original document.
- **Binary files the platform can extract** — PDF, Word (.docx), Excel
  (.xlsx), CSV/HTML/plain-text and other `text/*` files are downloaded (up to
  25 MiB) and converted locally by the engine; images (PNG/JPEG/…) go through
  the local OCR / vision pipeline.
- **Everything else** (Sheets/Slides/Forms native types, unknown binaries,
  oversized files) — indexed as metadata-only entries: title, folder path,
  link, timestamps.
- **Folder paths** — every document records a human-readable `display_path`
  from your chosen root.
- Files deleted, trashed, or moved out of the indexed folder are archived
  from the local index. Shortcuts are resolved to their targets.

Unchanged files are skipped by content hash (Drive's `headRevisionId` /
`md5Checksum`), so re-syncs are cheap.

## Privacy

- Read-only Drive scope; nothing is ever written to your Drive.
- All content stays on your machine — extraction and OCR run locally in
  KIAgent; this extension ships no Google client credentials and stores no
  tokens itself.
- Only the folder you choose (or My Drive) is read.

## Limitations

- **Shared Drives are not indexed** (My Drive and folders under it only).
- Sheets and Slides are indexed as metadata only — content export is
  deferred.
- Renaming or moving a folder does not re-render the recorded `display_path`
  of documents already indexed beneath it; paths refresh when the documents
  themselves next change (or after a full re-walk).
- Binary downloads are capped at 25 MiB; larger files are indexed as
  metadata only.
