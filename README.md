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
2. Pick the folders to index in KIAgent's folder picker. Two tabs — **My
   Drive** and **Shared with me** — let you browse the folder tree lazily and
   select **multiple folders** (selecting a folder covers its whole subtree,
   so a selected folder's descendants can't be selected again). Each row
   shows a recursive file count as an orientation aid: the count walks at
   most 20 Drive listing pages and stops at 50,000 files, showing "N+" when
   that budget is hit (a lower bound, and shortcuts are counted without
   resolving their targets). To index everything, just pick **My Drive**
   itself. Every folder row offers an expand arrow even when the folder has
   no subfolders — probing every row for children would cost one API call
   each, so an expand may simply come up empty.
3. The account shows up under your Google account's email address and
   backfills from there, then checks for changes every 15 minutes.

You can connect multiple Google accounts side by side.

### Tracked-roots config

The picker writes the account config as

```json
{ "roots": [ { "rootFolderId": "<drive folder id>", "rootName": "<name>" } ] }
```

with one entry per selected folder (`"root"` is Drive's alias for My Drive).
An account with no root config at all means all of My Drive. Duplicate root
ids are ignored (first entry wins). If one tracked root lies inside another,
the overlapping subtree is indexed once — under whichever root reaches it
first.

## What gets indexed

- **Native Google Docs** — exported as Markdown (with a plain-text fallback);
  deep links back to the original document.
- **Supported binary files** — PDF, Word (.docx), Excel (.xlsx), CSV/HTML/
  plain-text and other `text/*` files are downloaded (up to 25 MiB) and
  converted locally by the engine; images (PNG/JPEG/…) are downloaded (up to
  20 MiB) and go through the local OCR / vision pipeline.
- **Everything else is ignored before any download** — audio and video (any
  size), archives (.zip, .7z, .rar, and the rest, any size), unknown/
  unsupported binaries, files over the size caps above, and unsupported
  Google-native types (Sheets, Slides, Forms, …). None of these produce a
  document, a download, or any local row — a shortcut to one of them is
  ignored too, once its target type is resolved.
- **Folder paths** — every document records a human-readable `display_path`
  from the tracked root it was found under (and that root's id as
  `root_folder_id`).
- Files deleted, trashed, moved out of every indexed folder, or newly
  ignored by this policy are archived from the local index. Shortcuts are
  resolved to their targets.

Unchanged files are skipped by content hash (Drive's `headRevisionId` /
`md5Checksum`), so re-syncs are cheap.

## Privacy

- Read-only Drive scope; nothing is ever written to your Drive.
- All content stays on your machine — extraction and OCR run locally in
  KIAgent; this extension ships no Google client credentials and stores no
  tokens itself.
- Only the folders you choose (or My Drive) are read.

## Limitations

- **Shared Drives (Team Drives) are not indexed** — My Drive and
  shared-with-me folders only.
- Sheets and Slides are not indexed at all — content export is deferred, and
  they carry no bytes worth a metadata-only row either.
- Renaming or moving a folder does not re-render the recorded `display_path`
  of documents already indexed beneath it; paths refresh when the documents
  themselves next change (or after a full re-walk).
- Binary/PDF/Office downloads are capped at 25 MiB and images at 20 MiB;
  larger files are ignored, not indexed as metadata only.
