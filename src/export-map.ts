/**
 * v2 port of v1 export-map.ts (v1 repo `git show
 * main:src/main/connectors/google-docs/export-map.ts`).
 *
 * Route shape is v1's; two v2 deltas:
 *
 *  1. Native Google Docs export as `text/markdown` (Drive exports Docs to
 *     Markdown natively) instead of v1's `text/html` + converter pipeline —
 *     the exported text IS the document markdown. `text/plain` is the
 *     fallback when the markdown export fails non-retryably.
 *
 *  2. The convertible set is bound to what the v2 ENGINE actually extracts
 *     from binary documents emitted with `markdown: null` (verified in
 *     kiagent-core, branch greenfield):
 *      - deterministic converters — kiagent-core
 *        src/main/core/engine/convert.ts:43-84: application/pdf, docx
 *        (…wordprocessingml.document), xlsx (…spreadsheetml.sheet), and any
 *        `text/*` (which subsumes v1's text/plain, text/markdown, text/html,
 *        text/csv);
 *      - the two-pass vision pipeline — kiagent-core
 *        src/main/workers/vision/classify.ts:48-63 marks `type: 'file'` docs
 *        with pdf/image content as OCR/VLM candidates and the vision worker
 *        pulls bytes back through this source's `fetchBytes`
 *        (src/main/workers/vision/vision-worker.ts:44) — so `image/*` is
 *        convertible here too (v1 routed images unsupported).
 *
 * v1's exact-match set (text/plain, text/markdown, text/html, application/pdf,
 * docx, xlsx, text/csv) is a strict subset of this one, so nothing v1 indexed
 * is dropped. NEVER download bytes for a non-convertible mime.
 */

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export const EXPORT_MIME = 'text/markdown';
export const EXPORT_FALLBACK_MIME = 'text/plain';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Binary mimes the v2 engine can turn into text — see module doc for the
 *  file:line evidence behind each entry. */
export function isConvertibleMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf' ||
    mimeType === DOCX_MIME ||
    mimeType === XLSX_MIME
  );
}

export type Route =
  | { kind: 'native' }
  | { kind: 'binary' }
  | { kind: 'unsupported' };

export function chooseRoute(mimeType: string): Route {
  if (mimeType === GOOGLE_DOC_MIME) return { kind: 'native' };
  // Other Google-native types (spreadsheet, presentation, form, …) have no
  // bytes to download — metadata-only rows. Sheets/Slides export stays
  // deferred (v1 parity).
  if (mimeType.startsWith('application/vnd.google-apps.'))
    return { kind: 'unsupported' };
  if (isConvertibleMime(mimeType)) return { kind: 'binary' };
  return { kind: 'unsupported' };
}
