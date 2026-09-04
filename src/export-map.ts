/**
 * v2 port of v1 export-map.ts (v1 repo `git show
 * main:src/main/connectors/google-docs/export-map.ts`).
 *
 * Route shape is v1's; three v2 deltas:
 *
 *  1. Native Google Docs export as `text/markdown` (Drive exports Docs to
 *     Markdown natively) instead of v1's `text/html` + converter pipeline —
 *     the exported text IS the document markdown. `text/plain` is the
 *     fallback when the markdown export fails non-retryably.
 *
 *  2. Binary routing is delegated to the connector SDK's canonical
 *     `decideFileIndexing` policy (profile `'cloud-drive'`) instead of a
 *     connector-local `isConvertibleMime` allowlist. That policy is the
 *     single source of truth shared with every other cloud/local source in
 *     kiagent-core — see `@kiagent/connector-sdk`'s `file-indexability`
 *     module doc for the full branch-by-branch rationale. Under
 *     `'cloud-drive'` it ignores archives (any size), all audio/video
 *     (`reason: 'cloud-media'`, regardless of size), and anything outside
 *     the PDF/Office/text/image allowlist, and caps converter/PDF binaries
 *     at `MAX_CLOUD_BINARY_BYTES` (25 MiB) and images at
 *     `MAX_CLOUD_IMAGE_BYTES` (20 MiB) — both inclusive at the boundary.
 *     NEVER download bytes for a route whose `kind` is `'ignore'`.
 *
 *  3. Google-native precedence stays first and outside the SDK policy: the
 *     policy only ever sees binary `file` mime types, never
 *     `application/vnd.google-apps.*` — those routes are decided here.
 */
import { decideFileIndexing, type FileIgnoreReason } from '@kiagent/connector-sdk';

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export const EXPORT_MIME = 'text/markdown';
export const EXPORT_FALLBACK_MIME = 'text/plain';

export type DriveRoute =
  | { kind: 'native' }
  | { kind: 'binary'; pipeline: 'converter' | 'vision' }
  | { kind: 'ignore'; reason: FileIgnoreReason };

/**
 * Routes one Drive file (already shortcut-resolved) by mime/filename/size.
 * Google-native precedence stays first and outside the SDK policy — Docs
 * export as markdown, every other `application/vnd.google-apps.*` type
 * (Sheets, Slides, Forms, …) has no bytes to download and is ignored as
 * `'unsupported'`. Everything else is a binary `file` row, decided by the
 * SDK's canonical `decideFileIndexing` under the `'cloud-drive'` profile.
 */
export function chooseRoute(
  mimeType: string,
  filename: string,
  sizeBytes?: number,
): DriveRoute {
  if (mimeType === GOOGLE_DOC_MIME) return { kind: 'native' };
  if (mimeType.startsWith('application/vnd.google-apps.'))
    return { kind: 'ignore', reason: 'unsupported' };
  const d = decideFileIndexing({
    profile: 'cloud-drive',
    filename,
    mime: mimeType,
    sizeBytes,
  });
  return d.kind === 'ignore'
    ? d
    : { kind: 'binary', pipeline: d.pipeline === 'vision' ? 'vision' : 'converter' };
}
