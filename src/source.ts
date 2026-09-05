/**
 * Google Docs / Drive v2 source: platform-owned OAuth connect (root folders
 * chosen in the platform's shared folder-picker), BFS backfill with
 * page-aligned batches, a changes.list delta with per-page cursor commits,
 * full-listing reconcile, fetchBytes for the engine's deep-extraction
 * passes, and a pure toDocument.
 *
 * Ported from the v1 connector (`git show
 * main:src/main/connectors/google-docs/<file>.ts`): backfill.ts's walkFolder
 * BFS, delta.ts's changes loop + invalid-token recovery, ingest.ts's routing
 * / shortcut resolution / hash-skip, path-resolver.ts's ancestor walk
 * (first-parent chain against the tracked-root set — v1's tracked_roots
 * multi-root model returns in v2.1.0). Platform pieces (SQLite tables,
 * tracked roots UI, converter pipeline, safeStorage token blobs, scheduler)
 * are replaced by the v2 engine.
 *
 * Deliberate v2 fixes over v1 (see README):
 *  - v1 bug #1 (runFullRescan's cross-account deletion): the full-rescan path
 *    is GONE — an invalid changes token now yields a recovery cursor
 *    `{ page_token: '', backfill_done: false }` so the next cycle re-walks
 *    (idempotent upserts + hash-skip make that cheap) and reconcile covers
 *    missed deletions.
 *  - v1 bug #3 (delta not per-file fault-tolerant): every per-change ingest
 *    is wrapped — failure logs a warn and skips that file only. Auth errors
 *    always propagate.
 */
import type {
  Account,
  AuthChannel,
  Batch,
  Credentials,
  Document,
  DocumentInput,
  ExternalRef,
  FileIgnoreReason,
  FolderCount,
  FolderNode,
  FolderScopeUpdate,
  FolderSelectionChannel,
  HostFor,
  Query,
  Session,
  Source,
} from '@kiagent/connector-sdk';
import { MAX_CLOUD_BINARY_BYTES, MAX_CLOUD_IMAGE_BYTES } from '@kiagent/connector-sdk';
import {
  DriveApiError,
  DriveClient,
  GoogleDocsAuthError,
  isAuthError,
  type DriveClientDeps,
} from './client';
import {
  chooseRoute,
  EXPORT_FALLBACK_MIME,
  EXPORT_MIME,
  GOOGLE_DOC_MIME,
  GOOGLE_FOLDER_MIME,
  GOOGLE_SHORTCUT_MIME,
  type DriveRoute,
} from './export-map';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
/** Binary/PDF/Office cap — delegated to the SDK's canonical cloud-drive
 *  policy so this connector never drifts from it (v1 had NO cap at all —
 *  whole file into a Buffer, v1 gap #6). Images have their own, smaller
 *  cap (`MAX_CLOUD_IMAGE_BYTES`) applied inside `chooseRoute`. */
export const MAX_BINARY_BYTES = MAX_CLOUD_BINARY_BYTES;

/**
 * Per-batch flush budget. Listing / changes pages are requested at pageSize
 * 1000 and every convertible file in one carries either up to
 * MAX_BINARY_BYTES of downloaded bytes or a native-export markdown string.
 * Holding a whole page's payload at once (then structured-cloning it over
 * IPC in ONE message) can exceed the extension process heap; and because the
 * cursor only advances per page (backfill: never, until the live flip) the
 * same page replays on every retry — a deterministic crash loop that
 * surfaces as "extension process exited". So a page is flushed to the engine
 * in sub-page chunks once accumulated payload or entry count cross these
 * budgets — see `ChunkAccumulator`. Both are soft ceilings checked AFTER an
 * entry is added, so a chunk can overshoot by one file (≤ MAX_BINARY_BYTES).
 */
export const BATCH_BYTE_BUDGET = 32 * 1024 * 1024;
export const BATCH_ITEM_LIMIT = 250;

export interface BatchBudget {
  bytes: number;
  items: number;
}
/** v1 path-resolver's ancestor-walk bound, cycle-safe. */
const MAX_ANCESTOR_HOPS = 64;

// v1 LIST_FIELDS / CHANGES_FIELDS, verbatim (backfill.ts / delta.ts).
const FILE_FIELDS =
  'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,webViewLink,headRevisionId,trashed,shortcutDetails(targetId,targetMimeType)';
const LIST_FIELDS = `files(${FILE_FIELDS}),nextPageToken`;
const CHANGES_FIELDS = `changes(fileId,removed,time,file(${FILE_FIELDS})),newStartPageToken,nextPageToken`;
const SHORTCUT_TARGET_FIELDS =
  'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,webViewLink,headRevisionId,trashed';

export interface DriveCursor {
  page_token: string;
  backfill_done: boolean;
  /** The canonical root ids (config ids, `'root'` alias included) that
   *  produced this cursor, sorted and deduped. OPTIONAL on purpose: core's
   *  v3 migration leaves `Account.cursor` untouched because it is opaque to
   *  core, so a pre-existing cursor arrives without it — and `pull()` treats
   *  absent as a mismatch, i.e. exactly one forced backfill per account. */
  scope_roots?: string[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  webViewLink?: string;
  headRevisionId?: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  trashed?: boolean;
  shortcutDetails?: { targetId: string; targetMimeType: string };
}

export interface DriveItem {
  /** Shortcut-resolved file (target metadata, shortcut's parents). */
  file: DriveFile;
  docType: 'gdocs.doc' | 'file';
  /** Exported text for native docs, '' for metadata-only rows, null for
   *  binary items (the engine converts `binary` bytes). */
  markdown: string | null;
  bytes?: Uint8Array;
  extractionStatus: 'ok' | 'unsupported' | 'too-large' | 'failed';
  displayPath: string;
  rootFolderId: string;
}

/** buildItem's result: a constructed item to stage, or a policy ignore
 *  (never both — an ignored file produces zero items, zero downloads). */
export type BuildResult =
  | { kind: 'item'; item: DriveItem }
  | { kind: 'ignored'; reason: FileIgnoreReason; fileId: string };

interface FileListPage {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface ChangesPage {
  changes?: { fileId: string; removed?: boolean; file?: DriveFile }[];
  newStartPageToken?: string;
  nextPageToken?: string;
}

interface RootConfig {
  rootFolderId: string;
  rootName: string;
}

/** id → { name, parents } — v1's drive_folder_index, in-memory per pull run. */
type FolderIndex = Map<string, { name: string; parents: string[] }>;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Folder-picker callbacks (connect-time UI) ───────────────────────────────
// Invoked lazily by the platform's shared picker while it is open.

/** Picker listing page size — folder-only rows are cheap. */
const PICKER_PAGE_SIZE = 200;
/** Silent cap on one picker listing (a tab's roots / one folder's children). */
const PICKER_MAX_FOLDERS = 1000;
/** countFilesUnder: at most this many files.list PAGES per counted folder. */
const COUNT_BUDGET_REQUESTS = 20;
/** countFilesUnder file cap — matches the local-folder source's 50k cap. */
const COUNT_CAP = 50_000;

/** Drive ids are [A-Za-z0-9_-], so this is defense-in-depth only. */
const escapeDriveId = (id: string): string => id.replace(/'/g, "\\'");

interface PickerListPage {
  files?: { id: string; name: string }[];
  nextPageToken?: string;
}

function pickerListUrl(q: string, pageToken?: string): string {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', q);
  url.searchParams.set('orderBy', 'name');
  url.searchParams.set('fields', 'files(id,name),nextPageToken');
  url.searchParams.set('pageSize', String(PICKER_PAGE_SIZE));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

/** `hasChildren` is ALWAYS true: probing real child existence would cost one
 *  API call per row, so an expand that turns out empty is accepted instead
 *  (see README). Stops silently at PICKER_MAX_FOLDERS. */
async function listFolderNodes(client: DriveClient, q: string): Promise<FolderNode[]> {
  const nodes: FolderNode[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.request<PickerListPage>(pickerListUrl(q, pageToken));
    for (const f of page.files ?? []) {
      nodes.push({ id: f.id, name: f.name, hasChildren: true });
      if (nodes.length >= PICKER_MAX_FOLDERS) return nodes;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return nodes;
}

/** Roots of the picker's "Shared with me" tab. */
export const listSharedRoots = (client: DriveClient): Promise<FolderNode[]> =>
  listFolderNodes(
    client,
    `sharedWithMe = true and mimeType = '${GOOGLE_FOLDER_MIME}' and trashed = false`,
  );

/** Child FOLDERS of one picker row. */
export const listChildFolders = (client: DriveClient, id: string): Promise<FolderNode[]> =>
  listFolderNodes(
    client,
    `'${escapeDriveId(id)}' in parents and mimeType = '${GOOGLE_FOLDER_MIME}' and trashed = false`,
  );

interface CountListPage {
  files?: {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    shortcutDetails?: { targetMimeType: string };
  }[];
  nextPageToken?: string;
}

function countListUrl(folderId: string, pageToken?: string): string {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `'${escapeDriveId(folderId)}' in parents and trashed = false`);
  url.searchParams.set(
    'fields',
    'files(id,mimeType,name,size,shortcutDetails(targetMimeType)),nextPageToken',
  );
  url.searchParams.set('pageSize', '1000');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

/**
 * Whether an 'ignore' route computed for a SHORTCUT target (filename always
 * `''`, since a listing never returns the target's real name — see
 * `chooseRoute` call sites below) can be trusted as a genuine ignore.
 *
 * Two reasons are mime-final and always trustworthy regardless of the
 * (unknown) real filename: 'archive' and 'cloud-media' are decided purely
 * from `mime`/mime-prefix, never from an extension, when the filename is
 * `''`. So is ANY ignore verdict for a Google-native target mime
 * (`application/vnd.google-apps.*`) — `chooseRoute` decides those before
 * ever consulting the SDK's extension-aware branches, and no extension
 * could rescue a native format anyway.
 *
 * A plain 'unsupported' verdict for a non-Google-native mime is NOT
 * trustworthy here: the SDK's extension-rescue branches (e.g. a generic
 * `application/octet-stream` mime paired with a `.pdf` name) could still
 * admit the file once its real name is known — which is exactly what
 * `buildItem`'s shortcut-resolution branch sees, since it fetches the
 * target's full metadata (real name included) before routing. Reconcile
 * and countFilesUnder never see that name, so they must NOT omit/undercount
 * on this ambiguous case: over-admitting costs a spurious listing entry or
 * ref (harmless — a ref with no matching document does nothing), while
 * omitting a ref that ingest actually indexed causes the next reconcile
 * pass to silently archive a live document (reconcile's missing-ref
 * contract reads an omission as an upstream deletion).
 */
function shortcutIgnoreIsDefinite(route: DriveRoute, targetMime: string): boolean {
  if (route.kind !== 'ignore') return false;
  if (targetMime.startsWith('application/vnd.google-apps.')) return true;
  return route.reason === 'archive' || route.reason === 'cloud-media';
}

/**
 * Budgeted recursive BFS file count behind the picker's per-row "N files".
 * Each files.list PAGE spends one request of the budget; folders enqueue,
 * and a non-folder counts only when `chooseRoute` would actually index it —
 * a shortcut is resolved through its `shortcutDetails.targetMimeType` (no
 * target fetch, still an estimate: the target's own name/size are unknown,
 * so a target near a size cap may count optimistically). Exiting with work
 * remaining (budget spent or CAP reached, including a dangling
 * nextPageToken) → `capped: true`, count is a lower bound. Any Drive error
 * resolves `null` (uncounted row) — a count must never kill the picker.
 */
export async function countFilesUnder(
  client: DriveClient,
  id: string,
): Promise<FolderCount | null> {
  try {
    const queue: string[] = [id];
    let counted = 0;
    let requests = 0;
    while (queue.length > 0) {
      const folderId = queue.shift()!;
      let pageToken: string | undefined;
      do {
        // Checked before the fetch: reaching the limit HERE means this
        // folder (or its next page) is still unlisted → the walk is partial.
        if (requests >= COUNT_BUDGET_REQUESTS) return { count: counted, capped: true };
        requests++;
        const page = await client.request<CountListPage>(countListUrl(folderId, pageToken));
        for (const f of page.files ?? []) {
          if (f.mimeType === GOOGLE_FOLDER_MIME) {
            queue.push(f.id);
            continue;
          }
          const isShortcut = f.mimeType === GOOGLE_SHORTCUT_MIME;
          const targetMime = isShortcut ? f.shortcutDetails?.targetMimeType : f.mimeType;
          if (!targetMime) continue; // detail-less shortcut: ingest skips it too
          const size = Number(f.size);
          // A shortcut's own name says nothing about the TARGET's extension
          // (e.g. a shortcut named "song.mp3" pointing at a real PDF) — pass
          // '' so chooseRoute's extension-rescue branch never fires on the
          // wrong (shortcut's) name; only the resolved target mime decides.
          // An 'unsupported' verdict reached that way is ambiguous — see
          // shortcutIgnoreIsDefinite — so a shortcut is only excluded when
          // the ignore is definite; count it (over-admit) otherwise.
          const route = chooseRoute(
            targetMime,
            isShortcut ? '' : f.name,
            Number.isFinite(size) ? size : undefined,
          );
          const ignored = isShortcut
            ? shortcutIgnoreIsDefinite(route, targetMime)
            : route.kind === 'ignore';
          if (ignored) continue;
          if (++counted >= COUNT_CAP) return { count: counted, capped: true };
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    return { count: counted, capped: false };
  } catch {
    return null;
  }
}

/** Normalize account config to the tracked roots. Canonical shape first
 *  (`folderRoots: [{ id, name }]`), then the legacy `roots:
 *  [{ rootFolderId, rootName }]` mirror, then nothing (all of My Drive).
 *  Per-entry name fallback: 'My Drive' for the 'root' alias, the id
 *  otherwise. Deduped by id — first entry wins.
 *
 *  The mirror is core's ONE-TRAIN compatibility write (DECISIONS R1, owner
 *  fixed by A-2): the v3 migration and `applyFolderScope` keep `roots` in
 *  sync with `folderRoots` so a still-installed 2.1.6 — which reads only
 *  `roots` and silently falls through to ALL of My Drive without it — keeps
 *  working. This connector READS it only as a fallback, for an account this
 *  core has not migrated (an older core, or a config written before the
 *  migration ran), and never writes or deletes it.
 *  TODO(folder-scope-train-2): drop the legacy roots fallback. */
export function rootsConfig(session: Session): RootConfig[] {
  const cfg = session.account.config as { folderRoots?: unknown; roots?: unknown };
  const nameFor = (id: string, name: unknown): string => {
    if (typeof name === 'string' && name) return name;
    return id === 'root' ? 'My Drive' : id;
  };

  const parsed: RootConfig[] = [];
  if (Array.isArray(cfg.folderRoots)) {
    for (const raw of cfg.folderRoots) {
      const r = raw as { id?: unknown; name?: unknown } | null;
      if (r && typeof r.id === 'string' && r.id) {
        parsed.push({ rootFolderId: r.id, rootName: nameFor(r.id, r.name) });
      }
    }
  }
  if (parsed.length === 0 && Array.isArray(cfg.roots)) {
    for (const raw of cfg.roots) {
      const r = raw as { rootFolderId?: unknown; rootName?: unknown } | null;
      if (r && typeof r.rootFolderId === 'string' && r.rootFolderId) {
        parsed.push({
          rootFolderId: r.rootFolderId,
          rootName: nameFor(r.rootFolderId, r.rootName),
        });
      }
    }
  }
  if (parsed.length === 0) {
    // No (or empty) config → all of My Drive.
    parsed.push({ rootFolderId: 'root', rootName: 'My Drive' });
  }

  const seen = new Set<string>();
  const deduped: RootConfig[] = [];
  for (const r of parsed) {
    if (seen.has(r.rootFolderId)) continue;
    seen.add(r.rootFolderId);
    deduped.push(r);
  }
  return deduped;
}

/** The canonical root-id set for a cursor: deduped and SORTED, so a cursor
 *  read back by a human is stable. Comparison is still set-wise. */
const scopeRootIds = (roots: RootConfig[]): string[] =>
  [...new Set(roots.map((r) => r.rootFolderId))].sort();

/** Order-independent set equality on root ids — a REORDERED root list must
 *  never force a re-walk. An absent/non-array `a` is a mismatch (see
 *  DriveCursor.scope_roots). */
export function sameRootSet(a: string[] | undefined, b: string[]): boolean {
  if (!Array.isArray(a)) return false;
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of right) if (!left.has(id)) return false;
  return true;
}

/**
 * Stamps the CURRENT root set onto every cursor leaving `pull()`.
 *
 * There are six cursor yield sites — `:703` and `:708` (backfill's
 * `walkCursor`), `:726` (the live flip), `:845` (invalid-token recovery),
 * `:896` (delta's `pageCursor`) and `:906` (the page advance) — and because
 * `pull()` gates the phase on `scope_roots`, a SINGLE un-stamped site is an
 * infinite re-walk: the next tick reads `undefined`, mismatches, and
 * backfills again. Funnelling every yield through one wrapper makes that
 * unmissable, and keeps a future seventh site correct by construction. Do
 * NOT also edit the six literals — one owner only.
 */
async function* withScopeRoots(
  batches: AsyncGenerator<Batch<DriveCursor, DriveItem>>,
  scopeRoots: string[],
): AsyncGenerator<Batch<DriveCursor, DriveItem>> {
  for await (const batch of batches) {
    yield { ...batch, cursor: { ...batch.cursor, scope_roots: scopeRoots } };
  }
}

function listUrl(folderId: string, pageToken?: string): string {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `'${folderId}' in parents and trashed=false`);
  url.searchParams.set('fields', LIST_FIELDS);
  url.searchParams.set('pageSize', '1000');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

function changesUrl(pageToken: string): string {
  const url = new URL(`${DRIVE_API}/changes`);
  url.searchParams.set('pageToken', pageToken);
  url.searchParams.set('includeRemoved', 'true');
  url.searchParams.set('restrictToMyDrive', 'false');
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('fields', CHANGES_FIELDS);
  url.searchParams.set('pageSize', '1000');
  return url.toString();
}

const exportUrl = (fileId: string, mime: string): string =>
  `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(mime)}`;

const mediaUrl = (fileId: string): string => `${DRIVE_API}/files/${fileId}?alt=media`;

const shallowUrl = (fileId: string): string =>
  `${DRIVE_API}/files/${fileId}?fields=id,name,mimeType,parents`;

async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  if (!creds?.accessToken) {
    throw new GoogleDocsAuthError(
      'google-docs: no credentials available — reconnect the account',
    );
  }
  return creds.accessToken;
}

interface ItemDeps {
  client: DriveClient;
  session: Session;
  query: Query;
}

/** Accumulates one page's items/deletions and says when a chunk is due
 *  (see BATCH_BYTE_BUDGET). Deletions are cheap but count against the entry
 *  limit so a mass-delete page is still bounded. */
class ChunkAccumulator {
  items: DriveItem[] = [];
  deletions: ExternalRef[] = [];
  private size = 0;

  constructor(private readonly budget: BatchBudget) {}

  add(item: DriveItem): void {
    this.items.push(item);
    // Markdown is UTF-16 in memory and UTF-8 on the wire — measure bytes,
    // not code units, or non-ASCII documents undercount 2–3×.
    this.size += item.bytes?.byteLength ?? (item.markdown ? Buffer.byteLength(item.markdown, 'utf8') : 0);
  }

  addDeletions(refs: ExternalRef[]): void {
    this.deletions.push(...refs);
  }

  full(): boolean {
    return (
      this.size >= this.budget.bytes || this.items.length + this.deletions.length >= this.budget.items
    );
  }

  /** Hands out the pending chunk and resets. */
  take(): { items: DriveItem[]; deletions: ExternalRef[] } {
    const chunk = { items: this.items, deletions: this.deletions };
    this.items = [];
    this.deletions = [];
    this.size = 0;
    return chunk;
  }
}

/** Query-first content-hash skip: an unchanged, still-live document is never
 *  re-exported / re-downloaded (v1 ingest.ts's metadata-only refresh, minus
 *  the metadata refresh — the v2 engine owns row freshness). An ARCHIVED
 *  match does NOT skip: re-emitting is what un-archives a doc that moved
 *  back into scope. */
async function hashSkip(
  deps: ItemDeps,
  fileId: string,
  type: 'gdocs.doc' | 'file',
  metaKey: 'head_revision_id' | 'md5_checksum',
  value: string | undefined,
): Promise<boolean> {
  if (!value) return false;
  const existing = await deps.query.byExternalId(
    deps.session.account.id,
    fileId,
    type,
  );
  if (!existing || existing.archivedAt) return false;
  const meta = existing.metadata as Record<string, unknown>;
  // Only a clean 'ok' row is ever pinned behind an unchanged hash. A
  // 'failed' row (both exports exhausted — possibly just a quota storm)
  // must be retried on the next walk/tick. 'unsupported'/'too-large' rows
  // are never produced by current routing (an ineligible file is ignored
  // before any row is created) — reaching hashSkip here means the file's
  // route has since flipped positive (e.g. the extension-rescue widening
  // in decideFileIndexing, or a legacy pre-policy row); either way it must
  // be re-fetched, not pinned as if still ineligible.
  if (meta.extraction_status !== 'ok') return false;
  return meta[metaKey] === value;
}

function metadataOnly(
  file: DriveFile,
  docType: 'gdocs.doc' | 'file',
  extractionStatus: 'unsupported' | 'too-large' | 'failed',
  displayPath: string,
  rootFolderId: string,
): DriveItem {
  // EMPTY-STRING markdown: no binary, no conversion enrollment.
  return { file, docType, markdown: '', extractionStatus, displayPath, rootFolderId };
}

/**
 * Route one listed/changed file into a BuildResult (or null: nothing
 * changed, skip silently — shortcut-of-shortcut, a detail-less shortcut, or
 * a hash-skip). Shortcuts resolve to their target once (shortcut-of-
 * shortcut: warn + skip), keeping the SHORTCUT's parents so the doc sits in
 * the indexed subtree (v1 ingest.ts parity). The policy gate
 * (`chooseRoute`) runs FIRST — before hash-skip, before any export/download
 * request — so an ignored file causes zero I/O beyond the shortcut-target
 * lookup already needed to know its real mime. May do I/O (target fetch /
 * export / download) — toDocument stays pure.
 */
async function buildItem(
  raw: DriveFile,
  segments: string[],
  root: RootConfig,
  deps: ItemDeps,
): Promise<BuildResult | null> {
  let file = raw;
  if (file.mimeType === GOOGLE_SHORTCUT_MIME) {
    const details = file.shortcutDetails;
    if (!details) return null;
    if (details.targetMimeType === GOOGLE_SHORTCUT_MIME) {
      deps.session.log('warn', `google-docs: shortcut-of-shortcut skipped: ${file.id}`);
      return null;
    }
    const target = await deps.client.request<DriveFile>(
      `${DRIVE_API}/files/${details.targetId}?fields=${SHORTCUT_TARGET_FIELDS}`,
    );
    file = { ...target, parents: raw.parents };
  }

  const displayPath = [root.rootName, ...segments].join(' / ');
  const size = Number(file.size);
  const route = chooseRoute(file.mimeType, file.name, Number.isFinite(size) ? size : undefined);

  if (route.kind === 'ignore') {
    return { kind: 'ignored', reason: route.reason, fileId: file.id };
  }

  if (route.kind === 'native') {
    if (
      await hashSkip(deps, file.id, 'gdocs.doc', 'head_revision_id', file.headRevisionId)
    ) {
      return null;
    }
    let markdown: string;
    try {
      markdown = await deps.client.request<string>(exportUrl(file.id, EXPORT_MIME), {
        responseType: 'text',
      });
    } catch (e) {
      if (isAuthError(e)) throw e;
      deps.session.log(
        'warn',
        `google-docs: markdown export failed for ${file.id} (${errText(e)}) — trying text/plain`,
      );
      try {
        markdown = await deps.client.request<string>(
          exportUrl(file.id, EXPORT_FALLBACK_MIME),
          { responseType: 'text' },
        );
      } catch (e2) {
        if (isAuthError(e2)) throw e2;
        deps.session.log(
          'warn',
          `google-docs: export failed for ${file.id} (${errText(e2)}) — indexing metadata only`,
        );
        return {
          kind: 'item',
          item: metadataOnly(file, 'gdocs.doc', 'failed', displayPath, root.rootFolderId),
        };
      }
    }
    return {
      kind: 'item',
      item: {
        file,
        docType: 'gdocs.doc',
        markdown,
        extractionStatus: 'ok',
        displayPath,
        rootFolderId: root.rootFolderId,
      },
    };
  }

  // route.kind === 'binary'
  if (await hashSkip(deps, file.id, 'file', 'md5_checksum', file.md5Checksum)) {
    return null;
  }
  const bytes = await deps.client.request<Uint8Array>(mediaUrl(file.id), {
    responseType: 'bytes',
  });
  // Post-download cap: Drive binaries virtually always carry `size`, so the
  // pre-download `chooseRoute` cap above already caught most oversized
  // files — this is the backstop for the rare unknown-size file, re-checked
  // AFTER download per the size-boundary contract (unknown size is admitted
  // provisionally). A breach here is now a genuine policy ignore: the bytes
  // are discarded, never staged as a DriveItem.
  const binaryCap = route.pipeline === 'vision' ? MAX_CLOUD_IMAGE_BYTES : MAX_BINARY_BYTES;
  if (bytes.byteLength > binaryCap) {
    return { kind: 'ignored', reason: 'too-large', fileId: file.id };
  }
  return {
    kind: 'item',
    item: {
      file,
      docType: 'file',
      markdown: null,
      bytes,
      extractionStatus: 'ok',
      displayPath,
      rootFolderId: root.rootFolderId,
    },
  };
}

/**
 * BFS backfill across ALL configured roots (v1 backfill.ts walkFolder). One
 * batch per files.list page — or several, when a page's payload crosses the
 * batch budget; the cursor stays `{ page_token, backfill_done: false }` the
 * whole walk — a crash at any boundary redoes the walk, which is SAFE
 * (idempotent upserts) and cheap (hash-skip). Ends with a final `live` flip
 * batch.
 */
async function* backfill(
  client: DriveClient,
  session: Session,
  query: Query,
  cursor: DriveCursor | null,
  roots: RootConfig[],
  budget: BatchBudget,
): AsyncGenerator<Batch<DriveCursor, DriveItem>> {
  // A non-empty saved page_token predates the interrupted walk — a superset
  // of the changes we might miss — so KEEP it; never recapture mid-backfill.
  let pageToken = cursor?.page_token ?? '';
  if (!pageToken) {
    const r = await client.request<{ startPageToken: string }>(
      `${DRIVE_API}/changes/startPageToken`,
    );
    pageToken = r.startPageToken;
  }

  const deps: ItemDeps = { client, session, query };
  const index: FolderIndex = new Map();
  // BFS queue: folder id + its display-path segments below its root, tagged
  // with the RootConfig that owns the subtree. `walked` is ONE set SHARED
  // across roots: an overlapping subtree (a tracked root nested inside
  // another tracked root, or a folder cycle — the latter impossible under
  // Drive's single-parent model) is listed and ingested exactly once. The
  // FIRST root to reach a folder wins its displayPath/root attribution; a
  // root nested inside another keeps its own subtree because every root is
  // seeded before any listing happens.
  const walked = new Set<string>(roots.map((r) => r.rootFolderId));
  const queue: { folderId: string; segments: string[]; root: RootConfig; pageToken?: string }[] =
    roots.map((r) => ({ folderId: r.rootFolderId, segments: [], root: r }));
  // Ignored files are dropped silently per-file (no deletion — a re-walked
  // policy transition has no local row to archive yet; a genuine leftover
  // from before a policy tightening is caught by the next reconcile). Counts
  // are aggregated across the WHOLE walk and logged once at the end —
  // never per-file, and never with a filename.
  const ignoreCounts: Partial<Record<FileIgnoreReason, number>> = {};

  while (queue.length > 0) {
    if (session.signal.aborted) return;
    const head = queue.shift()!;
    const page = await client.request<FileListPage>(
      listUrl(head.folderId, head.pageToken),
    );

    const walkCursor: DriveCursor = { page_token: pageToken, backfill_done: false };
    const acc = new ChunkAccumulator(budget);
    for (const f of page.files ?? []) {
      if (session.signal.aborted) return;
      if (f.mimeType === GOOGLE_FOLDER_MIME) {
        index.set(f.id, { name: f.name, parents: f.parents ?? [] });
        if (!walked.has(f.id)) {
          walked.add(f.id);
          queue.push({
            folderId: f.id,
            segments: [...head.segments, f.name],
            root: head.root,
          });
        }
        continue;
      }
      try {
        const built = await buildItem(f, head.segments, head.root, deps);
        if (built) {
          if (built.kind === 'item') {
            acc.add(built.item);
          } else {
            ignoreCounts[built.reason] = (ignoreCounts[built.reason] ?? 0) + 1;
          }
        }
      } catch (e) {
        // One unreadable file must not abort the walk (v1 backfill parity).
        if (isAuthError(e)) throw e;
        session.log('warn', `google-docs backfill: file ${f.id} skipped: ${errText(e)}`);
      }
      if (acc.full()) {
        const chunk = acc.take();
        yield { phase: 'backfill', items: chunk.items, deletions: chunk.deletions, cursor: walkCursor };
      }
    }

    const chunk = acc.take();
    yield { phase: 'backfill', items: chunk.items, deletions: chunk.deletions, cursor: walkCursor };

    if (page.nextPageToken) {
      queue.unshift({ ...head, pageToken: page.nextPageToken });
    }
  }

  const ignoreTotal = Object.values(ignoreCounts).reduce((a, b) => a + (b ?? 0), 0);
  if (ignoreTotal > 0) {
    const summary = Object.entries(ignoreCounts)
      .map(([reason, n]) => `${reason}=${n}`)
      .join(', ');
    session.log(
      'info',
      `google-docs backfill: ignored ${ignoreTotal} file(s) by policy (${summary})`,
    );
  }

  yield { phase: 'live', items: [], cursor: { page_token: pageToken, backfill_done: true } };
}

/** Walk ancestors from `file` until the chain reaches ANY tracked root id
 *  (≤64 hops, cycle-safe — v1 path-resolver generalized to a root SET).
 *  Unknown ancestors are fetched shallow on demand and cached in the index.
 *  When in scope, returns the id of the root actually reached plus the
 *  display segments (top-down, root excluded).
 *
 *  Simplified to the FIRST parent chain only — v1's path-resolver BFS'd
 *  every parent chain. Drive migrated multi-parent files to shortcuts in
 *  2020, so the exposure is a rare legacy tail: such a file whose first
 *  listed parent chain exits every root is treated as out of scope (archived
 *  on its next change; the next backfill/reconcile pass under the roots
 *  restores it). */
async function resolveScope(
  file: DriveFile,
  rootIds: Set<string>,
  index: FolderIndex,
  client: DriveClient,
): Promise<{ inScope: boolean; rootId?: string; segments: string[] }> {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current = file.parents?.[0];
  for (let hops = 0; hops < MAX_ANCESTOR_HOPS && current; hops++) {
    if (rootIds.has(current)) {
      return { inScope: true, rootId: current, segments: segments.reverse() };
    }
    if (visited.has(current)) break; // cycle
    visited.add(current);
    let info = index.get(current);
    if (!info) {
      const f = await client.request<{
        id: string;
        name: string;
        mimeType: string;
        parents?: string[];
      }>(shallowUrl(current));
      info = { name: f.name, parents: f.parents ?? [] };
      index.set(current, info);
    }
    segments.push(info.name);
    current = info.parents[0];
  }
  return { inScope: false, segments: [] };
}

/** Shallow folder lookup with the per-call index as its cache — the same
 *  `shallowUrl` + FolderIndex idiom `resolveScope` uses. */
async function folderInfo(
  id: string,
  index: FolderIndex,
  client: DriveClient,
): Promise<{ name: string; parents: string[] }> {
  const hit = index.get(id);
  if (hit) return hit;
  const f = await client.request<{
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
  }>(shallowUrl(id));
  const info = { name: f.name, parents: f.parents ?? [] };
  index.set(id, info);
  return info;
}

/**
 * One save's shared folder-resolution state: the shallow-lookup cache and a
 * memoized `'root'` → real My Drive id. `coveringRoots` and
 * `classifyRemovedRoots` run back to back on the SAME modal, walk the same
 * chains, and would otherwise re-fetch `files/root` and every shared
 * ancestor a second time.
 */
export interface ScopeResolver {
  index: FolderIndex;
  /** The REAL folder id behind the `'root'` alias, fetched at most once. */
  myDriveId(): Promise<string>;
}

export function makeScopeResolver(client: DriveClient): ScopeResolver {
  const index: FolderIndex = new Map();
  let real: string | null = null;
  return {
    index,
    async myDriveId() {
      if (real === null) {
        const r = await client.request<{ id: string }>(`${DRIVE_API}/files/root?fields=id`);
        real = r.id;
      }
      return real;
    },
  };
}

/**
 * Collapse a picked set to a COVERING set: drop any node whose first-parent
 * chain reaches another picked node. Two Drive-specific rules:
 *
 *  - the picker's My Drive tab hands back the literal alias `'root'`, which
 *    is NOT a folder id — every My Drive descendant's chain terminates at
 *    the REAL My Drive id — so the alias is resolved once, exactly as
 *    `delta` does at :816-819, before any walk. Without that, "My Drive +
 *    one of its subfolders" survives as two roots and that subtree is
 *    walked and attributed twice.
 *  - `'root'` is the catch-all (DECISIONS R6): nothing covers My Drive, so
 *    it is never walked, and everything under it collapses INTO it.
 *
 * Failure policy follows the spec's error handling. A SELECTED folder that
 * cannot be read at all is a validation failure the user must see, named.
 * A failure part-way up an ANCESTOR chain keeps the root instead — over-
 * covering costs one re-walked subtree, under-covering archives documents.
 *
 * Cost: N selected roots × up to MAX_ANCESTOR_HOPS shallow GETs, on a modal
 * the user expects to be quick. Shared-with-me roots terminate immediately
 * (no walkable chain into My Drive).
 */
export async function coveringRoots(
  picked: FolderNode[],
  client: DriveClient,
  resolver: ScopeResolver = makeScopeResolver(client),
): Promise<FolderNode[]> {
  const index = resolver.index;
  const realId = new Map<string, string>();
  for (const n of picked) {
    realId.set(n.id, n.id === 'root' ? await resolver.myDriveId() : n.id);
  }
  const selected = new Set(realId.values());

  const kept: FolderNode[] = [];
  const seen = new Set<string>();
  for (const n of picked) {
    const own = realId.get(n.id)!;
    if (seen.has(own)) continue; // the alias and the real id are ONE root
    if (n.id !== 'root') {
      let info: { name: string; parents: string[] };
      try {
        info = await folderInfo(own, index, client);
      } catch (e) {
        if (isAuthError(e)) throw e;
        throw new Error(
          `google-docs: folder "${n.name}" is no longer readable (${errText(e)}) — remove it from the selection or restore access, then save again`,
        );
      }
      let current = info.parents[0];
      const visited = new Set<string>([own]);
      let covered = false;
      for (let hops = 0; hops < MAX_ANCESTOR_HOPS && current; hops++) {
        if (selected.has(current)) {
          covered = true;
          break;
        }
        if (visited.has(current)) break; // cycle
        visited.add(current);
        let ancestor: { name: string; parents: string[] };
        try {
          ancestor = await folderInfo(current, index, client);
        } catch (e) {
          if (isAuthError(e)) throw e;
          break; // unreadable ancestor → keep this root; over-cover is safe
        }
        current = ancestor.parents[0];
      }
      if (covered) continue;
    }
    seen.add(own);
    kept.push(n);
  }
  return kept;
}

/** A removed root's fate: its documents stay in scope under a retained
 *  ancestor (`reattribute`), or they leave scope entirely (`archive`). The
 *  two arrays are DISJOINT by construction — every removed root is pushed to
 *  exactly one of them — which is what `applyFolderScope` throws over
 *  (C-46/D5). */
export interface RemovedRootPlan {
  archive: string[];
  reattribute: Array<{ from: string; to: string }>;
}

/**
 * C-46/D2 + D5. Decide, per REMOVED root, whether a RETAINED root still
 * covers it — a real ancestor walk, never a heuristic.
 *
 * This replaces `scopeRoots.includes('root') ? [] : removed`, whose premise
 * ("My Drive is a genuine ancestor of every removed root's subtree") is
 * false: My Drive and "Shared with me" are MODES of ONE multi-select picker
 * (`manageFolders` below), so a shared-with-me or shared-drive root lives in
 * the same selection and is under no My Drive folder at all. Removing one
 * archived nothing, and `hashSkip` (:476) freezes a live row's
 * `scope_root_id`, so no later walk ever re-stamped or removed it — the
 * documents stayed searchable forever.
 *
 * Ids in and out are CONFIG-FACING (`folderRoots[].id`), the exact strings
 * `scope_root_id` carries: the `'root'` alias is resolved only to walk, and
 * `to` is the retained root's alias, never the resolved My Drive id.
 * `kept` is a COVERING set, so at most one retained root can be an ancestor
 * of any removed root — `to` is never ambiguous.
 *
 * Failure policy, matching OneDrive's `resolveRootLocation`:
 *  - auth error → rethrow; every later call would fail identically.
 *  - 404/410, on the root itself or anywhere up its chain → the folder (or
 *    the chain) is gone, so nothing retained demonstrably covers it →
 *    archive. Archival is the RECOVERABLE direction here: the root set
 *    changed, so this save also forces a re-establish, and an archived row
 *    is re-emitted by the re-walk through hashSkip's archived-row exception
 *    (:476).
 *  - anything else (5xx after the retry ladder, network) → THROW and abort
 *    the save, named. Guessing "covered" leaks documents outside the
 *    selection; guessing "not covered" archives documents the user still
 *    selects. Neither is guessable, so neither is guessed.
 * A cycle or MAX_ANCESTOR_HOPS exhaustion is likewise "no coverage proven"
 * → archive, on the same recoverability argument.
 */
export async function classifyRemovedRoots(
  removed: { id: string; name: string }[],
  kept: FolderNode[],
  client: DriveClient,
  resolver: ScopeResolver,
): Promise<RemovedRootPlan> {
  const plan: RemovedRootPlan = { archive: [], reattribute: [] };
  if (removed.length === 0) return plan;

  // real folder id → the retained root's CONFIG-FACING id.
  const retainedByReal = new Map<string, string>();
  for (const n of kept) {
    retainedByReal.set(n.id === 'root' ? await resolver.myDriveId() : n.id, n.id);
  }

  for (const r of removed) {
    const own = r.id === 'root' ? await resolver.myDriveId() : r.id;

    // The same root under both spellings (an explicit My Drive id stored,
    // the alias retained, or vice versa): pure re-attribution, no walk.
    const self = retainedByReal.get(own);
    if (self !== undefined) {
      if (self !== r.id) plan.reattribute.push({ from: r.id, to: self });
      continue;
    }

    const gone = (e: unknown): boolean =>
      e instanceof DriveApiError && (e.status === 404 || e.status === 410);
    const abort = (e: unknown): Error =>
      new Error(
        `google-docs: could not determine whether folder "${r.name}" is still covered by your selection (${errText(e)}) — nothing was saved; try again`,
      );

    let info: { name: string; parents: string[] };
    try {
      info = await folderInfo(own, resolver.index, client);
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (!gone(e)) throw abort(e);
      plan.archive.push(r.id);
      continue;
    }

    let current = info.parents[0];
    const visited = new Set<string>([own]);
    let to: string | undefined;
    let aborted: unknown;
    for (let hops = 0; hops < MAX_ANCESTOR_HOPS && current; hops++) {
      const hit = retainedByReal.get(current);
      if (hit !== undefined) {
        to = hit;
        break;
      }
      if (visited.has(current)) break; // cycle
      visited.add(current);
      let ancestor: { name: string; parents: string[] };
      try {
        ancestor = await folderInfo(current, resolver.index, client);
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (!gone(e)) {
          aborted = e;
          break;
        }
        break; // chain gone → no coverage proven → archive
      }
      current = ancestor.parents[0];
    }
    if (aborted !== undefined) throw abort(aborted);
    if (to !== undefined) plan.reattribute.push({ from: r.id, to });
    else plan.archive.push(r.id);
  }
  return plan;
}

/** Both-type existence probe for query-first deletions: only refs for types
 *  that actually exist locally are emitted. */
async function existingRefs(
  query: Query,
  session: Session,
  fileId: string,
): Promise<ExternalRef[]> {
  const refs: ExternalRef[] = [];
  for (const type of ['gdocs.doc', 'file'] as const) {
    const existing = await query.byExternalId(session.account.id, fileId, type);
    if (existing) refs.push({ externalId: fileId, type });
  }
  return refs;
}

/**
 * changes.list delta (v1 delta.ts) with v2 improvements: one batch per
 * changes page (page-aligned cursor commits — v1 committed only at the end),
 * per-file fault tolerance (fixes v1 bug #3), and invalid-token recovery via
 * a `{ page_token: '', backfill_done: false }` cursor instead of v1's
 * runFullRescan (whose missing account filter was v1 bug #1).
 */
async function* delta(
  client: DriveClient,
  session: Session,
  query: Query,
  cursor: DriveCursor,
  roots: RootConfig[],
  budget: BatchBudget,
): AsyncGenerator<Batch<DriveCursor, DriveItem>> {
  const deps: ItemDeps = { client, session, query };
  const index: FolderIndex = new Map();

  // Ancestor walks must match REAL folder ids — 'root' is only an API alias,
  // resolved ONCE per run (rootsConfig deduped ids, so at most one 'root'
  // entry exists). A file is in scope iff its chain reaches ANY tracked
  // root; attribution (displayPath/rootFolderId) comes from the root
  // actually reached. First config to claim a resolved id wins — an explicit
  // real My-Drive id alongside the 'root' alias collapses to one entry,
  // mirroring backfill's first-root-wins attribution.
  const byRootId = new Map<string, RootConfig>();
  for (const root of roots) {
    let id = root.rootFolderId;
    if (id === 'root') {
      const r = await client.request<{ id: string }>(`${DRIVE_API}/files/root?fields=id`);
      id = r.id;
    }
    if (!byRootId.has(id)) byRootId.set(id, root);
  }
  const rootIds = new Set(byRootId.keys());

  let pageToken = cursor.page_token;
  for (;;) {
    if (session.signal.aborted) return;
    let page: ChangesPage;
    try {
      page = await client.request<ChangesPage>(changesUrl(pageToken));
    } catch (e) {
      if (isAuthError(e)) throw e;
      // v1 delta.ts's invalid-token check, hardened: v1 regexed
      // /…|400|404/ against the whole `drive <status> <url> <body>` message,
      // but the URL embeds the (typically numeric) pageToken, so a token
      // containing "400" made ANY non-auth failure look invalid. Anchor the
      // status codes on the typed error; keep v1's phrase matches.
      const invalidToken =
        (e instanceof DriveApiError && (e.status === 400 || e.status === 404)) ||
        /page token is invalid|invalid value/i.test(errText(e));
      if (invalidToken) {
        session.log(
          'warn',
          `google-docs delta: changes page token rejected (${errText(e)}) — scheduling a re-walk`,
        );
        yield { phase: 'live', items: [], cursor: { page_token: '', backfill_done: false } };
        return;
      }
      throw e;
    }

    // Dedupe this page's changes by fileId, keeping the LAST occurrence.
    const byId = new Map<string, { fileId: string; removed?: boolean; file?: DriveFile }>();
    for (const c of page.changes ?? []) byId.set(c.fileId, c);

    // Intermediate (budget-flushed) chunks commit under the token that
    // fetched THIS page; only the page's final chunk advances it, so a crash
    // mid-page replays the page rather than skipping its remainder.
    const pageCursor: DriveCursor = { page_token: pageToken, backfill_done: true };
    const acc = new ChunkAccumulator(budget);
    const ingest = async (c: { fileId: string; removed?: boolean; file?: DriveFile }): Promise<void> => {
      if (c.removed || c.file?.trashed) {
        acc.addDeletions(await existingRefs(query, session, c.fileId));
        index.delete(c.fileId);
        return;
      }
      if (!c.file) return;
      if (c.file.mimeType === GOOGLE_FOLDER_MIME) {
        // Track the move/rename for later ancestor walks. Descendants'
        // display_path is NOT re-rendered (v1 parity — see README).
        index.set(c.file.id, { name: c.file.name, parents: c.file.parents ?? [] });
        return;
      }
      const scope = await resolveScope(c.file, rootIds, index, client);
      if (!scope.inScope) {
        // Moved out of every indexed subtree: archive whatever exists locally.
        acc.addDeletions(await existingRefs(query, session, c.fileId));
        return;
      }
      const built = await buildItem(c.file, scope.segments, byRootId.get(scope.rootId!)!, deps);
      if (!built) return; // hash-skip: unchanged, still-live — nothing to do
      if (built.kind === 'item') acc.add(built.item);
      else acc.addDeletions(await existingRefs(query, session, built.fileId));
    };
    for (const c of byId.values()) {
      if (session.signal.aborted) return;
      try {
        await ingest(c);
      } catch (e) {
        // Per-file guard — the v1-bug-3 fix: one bad file never aborts the
        // tick. Auth errors propagate.
        if (isAuthError(e)) throw e;
        session.log('warn', `google-docs delta: file ${c.fileId} skipped: ${errText(e)}`);
      }
      if (acc.full()) {
        const chunk = acc.take();
        yield { phase: 'live', items: chunk.items, deletions: chunk.deletions, cursor: pageCursor };
      }
    }

    const next = page.nextPageToken ?? page.newStartPageToken ?? pageToken;
    const last = acc.take();
    yield {
      phase: 'live',
      items: last.items,
      deletions: last.deletions,
      cursor: { page_token: next, backfill_done: true },
    };

    if (!page.nextPageToken) return;
    pageToken = page.nextPageToken;
  }
}

export interface GoogleDocsTestSeams extends Partial<Pick<DriveClientDeps, 'sleep' | 'random'>> {
  batchByteBudget?: number;
  batchItemLimit?: number;
}

export function createGoogleDocsSource(
  host: HostFor<'net' | 'query'>,
  // Test seam only: DriveClient's sleep/random are injectable so retry tests
  // never actually wait, and the batch budgets shrink so chunking is
  // testable with tiny fixtures; production callers omit this.
  seams?: GoogleDocsTestSeams,
): Source<DriveCursor, DriveItem> {
  const { batchByteBudget, batchItemLimit, ...clock } = seams ?? {};
  const budget: BatchBudget = {
    bytes: batchByteBudget ?? BATCH_BYTE_BUDGET,
    items: batchItemLimit ?? BATCH_ITEM_LIMIT,
  };
  const clientFor = (session: Session): DriveClient =>
    new DriveClient({
      fetch: host.net.fetch,
      getToken: () => requireToken(session),
      ...clock,
    });

  return {
    descriptor: {
      id: 'google-docs',
      name: 'Google Docs',
      documentTypes: ['gdocs.doc', 'file'],
      auth: 'oauth',
      multiAccount: true,
      cadence: { every: '15m' },
      /** Enables the Tracked folders card and accounts:start-manage-folders.
       *  A descriptor with this flag MUST implement manageFolders. */
      folderScope: true,
    },

    async connect(auth: AuthChannel) {
      auth.status('Waiting for Google sign-in…');
      const creds: Credentials = await auth.oauth(DRIVE_SCOPES);
      const accessToken = creds.accessToken;
      if (!accessToken) {
        throw new Error('google-docs: Google sign-in returned no access token');
      }
      const client = new DriveClient({
        fetch: host.net.fetch,
        getToken: async () => accessToken,
        ...clock,
      });

      auth.status('Fetching Drive profile…');
      const about = await client.request<{
        user?: { emailAddress?: string; displayName?: string };
      }>(`${DRIVE_API}/about?fields=user(emailAddress,displayName)`);
      if (!about.user?.emailAddress) {
        throw new Error('google-docs: Drive about response missing user.emailAddress');
      }
      const email = about.user.emailAddress;

      // The platform's shared folder-picker: lazy tree over the connect-time
      // client, multi-select with covering roots. A user cancel rejects —
      // let that propagate out of connect().
      const picked = await auth.pickFolders({
        modes: [
          { key: 'my-drive', label: 'My Drive' },
          { key: 'shared', label: 'Shared with me' },
        ],
        multiSelect: true,
        purpose: 'connect',
        selected: [],
        roots: async (mode) =>
          mode === 'my-drive'
            ? [{ id: 'root', name: 'My Drive', hasChildren: true }]
            : listSharedRoots(client),
        children: (id) => listChildFolders(client, id),
        count: (id) => countFilesUnder(client, id),
      });
      if (picked.length === 0) throw new Error('google-docs: no folders selected');
      // Canonical shape only. Core writes the legacy `roots` mirror where it
      // is needed (DECISIONS R1 + A-2); an account created by THIS artifact
      // implies this artifact is the installed one, so nothing here reads
      // the mirror. Covering-set normalization is deliberately NOT run:
      // the connect picker lists before it selects, so the renderer's own
      // covering logic already collapsed the My Drive tab — running
      // coveringRoots would add N ancestor walks to every first connect and
      // would flip this suite's `calls).toHaveLength(1)` assertion.
      return {
        identifier: email,
        config: { folderRoots: picked.map((n) => ({ id: n.id, name: n.name })) },
      };
    },

    async *pull(session: Session, cursor: DriveCursor | null) {
      const client = clientFor(session);
      const roots = rootsConfig(session);
      const scopeRoots = scopeRootIds(roots);
      // Phase switch. A finished backfill is trusted ONLY while the cursor
      // was produced by the current root set: adding a root after
      // backfill_done otherwise never walks the files that predate the
      // cursor (the gap this feature exists to close). On a mismatch the
      // walk keeps the saved page_token — backfill's own comment says why:
      //   "A non-empty saved page_token predates the interrupted walk — a
      //    superset of the changes we might miss — so KEEP it; never
      //    recapture mid-backfill."   (source.ts:634-635)
      if (!cursor || !cursor.backfill_done || !sameRootSet(cursor.scope_roots, scopeRoots)) {
        yield* withScopeRoots(
          backfill(client, session, host.query, cursor, roots, budget),
          scopeRoots,
        );
      } else {
        yield* withScopeRoots(
          delta(client, session, host.query, cursor, roots, budget),
          scopeRoots,
        );
      }
    },

    /**
     * Edit this account's folder scope with its EXISTING credentials — never
     * an OAuth round trip (the channel deliberately has no `oauth` verb).
     * Persists nothing: core owns the durable transaction.
     */
    async manageFolders(
      session: Session,
      channel: FolderSelectionChannel,
    ): Promise<FolderScopeUpdate<DriveCursor>> {
      const client = clientFor(session);
      const current = rootsConfig(session);
      channel.status('Loading your Drive folders…');
      const picked = await channel.pickFolders({
        modes: [
          { key: 'my-drive', label: 'My Drive' },
          { key: 'shared', label: 'Shared with me' },
        ],
        multiSelect: true,
        purpose: 'manage',
        // Pre-checked AND removable. `hasChildren` is always true here for
        // the same reason `listFolderNodes` sets it: probing would cost one
        // API call per row.
        selected: current.map((r) => ({
          id: r.rootFolderId,
          name: r.rootName,
          hasChildren: true,
        })),
        roots: async (mode) =>
          mode === 'my-drive'
            ? [{ id: 'root', name: 'My Drive', hasChildren: true }]
            : listSharedRoots(client),
        children: (id) => listChildFolders(client, id),
        count: (id) => countFilesUnder(client, id),
      });
      if (picked.length === 0) throw new Error('google-docs: no folders selected');

      channel.status('Checking the selection…');
      const resolver = makeScopeResolver(client);
      const kept = await coveringRoots(picked, client, resolver);
      const folderRoots = kept.map((n) => ({ id: n.id, name: n.name }));
      const scopeRoots = [...new Set(folderRoots.map((r) => r.id))].sort();

      // DECISIONS R8, Drive rule — REWRITTEN by C-46/D2 + D5. Core cannot
      // compute this: it does not know containment, and every live row's
      // scope_root_id is frozen by hashSkip at whatever root claimed it when
      // last emitted (314 rows over 24 distinct historical ids on the real
      // production account).
      //
      // This block used to read `scopeRoots.includes('root') ? [] : removed`
      // — "if the My Drive catch-all is retained it is a genuine ancestor of
      // every removed root's subtree, so archive NOTHING". That premise is
      // FALSE. My Drive and "Shared with me" are `modes` of ONE
      // multiSelect picker (see pickFolders above), not an either/or, so a
      // shared-with-me or shared-drive root sits in the same selection and is
      // under no My Drive folder at all. Removing one archived nothing and
      // left its documents searchable forever, with no root that selects
      // them and no walk that would ever re-stamp or remove them.
      //
      // So every removed root now gets a REAL ancestor walk
      // (classifyRemovedRoots), and lands in exactly one of two arrays:
      //   - covered by a retained root → `reattributeScopeRoots`, C-46/D5's
      //     third verb: core re-stamps scope_root_id from → to in the same
      //     transaction. No archive, no re-download, no searchability gap
      //     and no stale stamp — which is what keeps a WIDENING edit (the
      //     single most likely edit, de-selecting a folder in favour of My
      //     Drive) cheap. This is the Save-path half of R6's 314-of-316 fix.
      //   - not covered (a shared root, or genuinely orphaned) →
      //     `archiveScopeRootIds`, an explicit IN-list; reconcile() remains
      //     the net for anything else.
      // The two are disjoint by construction — applyFolderScope THROWS
      // otherwise. Containment that cannot be DETERMINED aborts the save
      // rather than being guessed; see classifyRemovedRoots' failure policy.
      // The alias is the only way a catch-all can enter folderRoots — the
      // picker's My Drive tab always yields { id: 'root' } — and it is what
      // both arrays carry, since that is the string scope_root_id holds.
      const removed = current
        .filter((r) => !scopeRoots.includes(r.rootFolderId))
        .map((r) => ({ id: r.rootFolderId, name: r.rootName }));
      const { archive: archiveScopeRootIds, reattribute: reattributeScopeRoots } =
        await classifyRemovedRoots(removed, kept, client, resolver);

      // Unrelated config keys ride through untouched (spec §Terminology),
      // and that includes the legacy `roots` mirror: DECISIONS A-2 gives
      // core sole ownership of it — applyFolderScope re-derives it from
      // folderRoots inside the same transaction. This connector neither
      // writes it nor strips it. Stripping it would silently end R1's
      // one-train compatibility window on a still-installed 2.1.6.
      const stored = session.account.config as Record<string, unknown>;

      const prior = (session.account.cursor ?? null) as DriveCursor | null;
      const rewalk = prior !== null && !sameRootSet(prior.scope_roots, scopeRoots);
      const cursor: DriveCursor | null = prior
        ? {
            // The pre-change token is a SUPERSET of the changes the new walk
            // could miss, so it is preserved — backfill's own comment is the
            // guarantee this leans on: "A non-empty saved page_token
            // predates the interrupted walk — a superset of the changes we
            // might miss — so KEEP it; never recapture mid-backfill."
            // (source.ts:634-635)
            page_token: prior.page_token,
            backfill_done: rewalk ? false : prior.backfill_done,
            scope_roots: scopeRoots,
          }
        : null;

      // DECISIONS A-3/R5. NULL-scoped live rows exist on a Drive account
      // only via the migration (Task 2's mass-archive refusal and its
      // unreadable-metadata/config guards deliberately leave rows live with
      // scope_root_id NULL); this connector never EMITS one. Archiving them
      // is repairable ONLY when the same update forces a full re-establish,
      // because contentHash excludes scope and this connector hashSkips —
      // the re-walk un-archives them through hashSkip's archived-row
      // exception (source.ts:476). So the flag rides exactly the branch that
      // sets backfill_done:false with the page_token preserved, and is false
      // whenever the root set is unchanged or there is no cursor to re-walk.
      //
      // ⚠️ C-34 — CORE DECLINES TO ACT ON THIS FLAG IN THIS TRAIN, BY
      // DESIGN. Keep emitting it: it is part of the frozen
      // `FolderScopeUpdate` and it is how a source states intent. But expect
      // NO effect — Task 3 drops `archiveNullScoped` from
      // `applyFolderScope`'s store input type and Task 7 does not forward it
      // (it warns that a source asked and was refused). Do not "fix" the
      // connector when you discover the field is inert, and do not delete the
      // computation: it records intent and is what a later, safe repair path
      // would key on.
      //
      // Why core refuses the pairing this comment argues for: the archive
      // would land BEFORE there is any proof the compensating re-walk
      // actually LISTED the row. An archived row is genuinely re-emitted —
      // hashSkip's `if (!existing || existing.archivedAt) return false;`
      // exception (source.ts:476) is real — but only for rows the walk
      // reaches, and a LIVE NULL-scoped row has no other re-stamp path at
      // all, because core's upsertDocument early-returns on
      // `content_hash === hash && archived_at === null`
      // (write-tx.ts:170-176). So any row the re-walk misses, and every row
      // on an account whose walk never runs (`needsReauth` is a RESTING
      // state — boot.ts:194-202: only the user's explicit Retry or a fresh
      // connect restarts the loop), stays archived for good. OneDrive is
      // worse still: no `reconcile()` exists there at all
      // (onedrive-kia-connector src/source.ts:62). What would have to exist
      // before core could honour the flag is an archive-AFTER-proof
      // predicate shaped like `reconcile`'s (`write-tx.ts:512-538`: `seq <=
      // ?` AND `NOT EXISTS (… reconcile_listing …)`) — plus a listing pass
      // for OneDrive — not a boolean.
      return {
        config: { ...stored, folderRoots },
        cursor,
        archiveScopeRootIds,
        reattributeScopeRoots,
        archiveNullScoped: rewalk,
      };
    },

    /**
     * Re-authenticate THIS account. Never touches config or the cursor —
     * reconnect preserves scope byte-for-byte (spec invariant 2). The
     * identity check is the whole point: without it an OAuth flow that
     * lands on a different Google account would silently repoint an
     * existing corpus. Trimmed and case-insensitive, per the spec; the old
     * heuristic compared with a bare `===`.
     */
    async reauthenticate(account: Account, auth: AuthChannel): Promise<void> {
      auth.status('Waiting for Google sign-in…');
      const creds: Credentials = await auth.oauth(DRIVE_SCOPES);
      const accessToken = creds.accessToken;
      if (!accessToken) {
        throw new Error('google-docs: Google sign-in returned no access token');
      }
      const client = new DriveClient({
        fetch: host.net.fetch,
        getToken: async () => accessToken,
        ...clock,
      });

      auth.status('Verifying the Google account…');
      const about = await client.request<{
        user?: { emailAddress?: string; displayName?: string };
      }>(`${DRIVE_API}/about?fields=user(emailAddress,displayName)`);
      const email = about.user?.emailAddress;
      if (!email) {
        throw new Error('google-docs: Drive about response missing user.emailAddress');
      }
      const fold = (s: string): string => s.trim().toLowerCase();
      if (fold(email) !== fold(account.identifier)) {
        // Names both identities, never a token (spec §Error handling).
        throw new Error(
          `google-docs: signed in as ${email}, but this account is ${account.identifier} — sign in with the original Google account`,
        );
      }
    },

    toDocument(item: DriveItem): DocumentInput {
      const f = item.file;
      return {
        externalId: f.id,
        type: item.docType,
        title: f.name,
        markdown: item.markdown,
        // First-class root attribution (spec §Document root attribution).
        // The CONFIG id verbatim — 'root' alias included — so it equals
        // metadata.root_folder_id below and folderRoots[].id in config;
        // core's applyFolderScope matches archiveScopeRootIds against
        // exactly this column, with an IN-list (R8), never a NOT-IN.
        // Never undefined here: every DriveItem is built under a RootConfig
        // (backfill seeds one per queue entry, delta maps resolveScope's hit
        // back through byRootId), so this connector never EMITS an R5 NULL.
        // NULL rows can still exist on a Drive account from the migration
        // path (Task 2's mass-archive refusal and its unreadable-metadata
        // guards leave rows live with scope_root_id NULL). `manageFolders`
        // below still ASKS for the archiveNullScoped repair on those rows,
        // but core declines to act on it in this train (C-34), so such rows
        // stay live and unattributed rather than being archived. That is the
        // intended outcome: no path in this train archives a document the
        // migration could not attribute.
        scopeRootId: item.rootFolderId,
        ...(item.bytes
          ? { binary: { bytes: item.bytes, mime: f.mimeType, filename: f.name } }
          : {}),
        url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
        metadata: {
          drive_file_id: f.id,
          mime_type: f.mimeType,
          size_bytes: f.size != null ? Number(f.size) : null,
          drive_parents: f.parents ?? [],
          display_path: item.displayPath,
          modified_time: f.modifiedTime ?? null,
          head_revision_id: f.headRevisionId ?? null,
          md5_checksum: f.md5Checksum ?? null,
          extraction_status: item.extractionStatus,
          root_folder_id: item.rootFolderId,
          // Engine vision/classify aliases: kiagent-core's vision pipeline
          // reads metadata.mime / filename / sizeBytes (classify.ts:10-15),
          // not the v1-named keys above. Emitted on 'file' docs so
          // extension-less pdfs/images still classify, the tiny-image guard
          // applies, and undecodable text-poor images don't re-drive the
          // vision worker every cadence.
          ...(item.docType === 'file'
            ? {
                mime: f.mimeType,
                filename: f.name,
                ...(f.size != null ? { sizeBytes: Number(f.size) } : {}),
              }
            : {}),
        },
        createdAt: f.createdTime ?? f.modifiedTime ?? null,
      };
    },

    /** Random-access bytes for the engine's deep-extraction passes (the
     *  vision worker's OCR/VLM two-pass pulls pdf/image bytes back through
     *  here). Native docs return null — their markdown is already in the
     *  document. The `chooseRoute` gate runs BEFORE `clientFor`/any request,
     *  so an ignored doc costs no OAuth/token/network work at all. */
    async fetchBytes(session: Session, doc: Document): Promise<Uint8Array | null> {
      if (doc.type === 'gdocs.doc') return null;
      const meta = doc.metadata as Record<string, unknown>;
      const fileId = meta.drive_file_id;
      if (typeof fileId !== 'string' || !fileId) return null;
      const mime = typeof meta.mime_type === 'string' ? meta.mime_type : '';
      const filename = doc.title ?? '';
      const size = typeof meta.size_bytes === 'number' ? meta.size_bytes : undefined;
      if (chooseRoute(mime, filename, size).kind !== 'binary') return null;
      const client = clientFor(session);
      try {
        return await client.request<Uint8Array>(mediaUrl(fileId), {
          responseType: 'bytes',
        });
      } catch (e) {
        if (e instanceof DriveApiError && (e.status === 404 || e.status === 410)) {
          return null; // gone upstream — reconcile will archive it
        }
        throw e;
      }
    },

    /**
     * Full BFS listing of what exists under ALL configured roots. Refs carry
     * the type the ROUTING would emit (native docs → 'gdocs.doc', everything
     * else → 'file'; shortcuts → the TARGET id, matching ingest). A file (or
     * shortcut target) `chooseRoute` would ignore is OMITTED — the engine
     * diffs this live set against the local corpus, so an omitted ref reads
     * as "gone" and archives any leftover row from before a policy
     * tightening, exactly like a real deletion. ANY listing failure THROWS —
     * the engine treats a thrown reconcile as a partial listing and skips
     * the deletion diff; yielding a partial live-set would mass-archive
     * documents.
     */
    async *reconcile(session: Session): AsyncIterable<ExternalRef[]> {
      const client = clientFor(session);
      const roots = rootsConfig(session);
      // ONE walked set shared across roots — overlapping subtrees listed
      // once, same rationale as backfill's `walked` (cycle guard included).
      const walked = new Set<string>(roots.map((r) => r.rootFolderId));
      const queue: string[] = roots.map((r) => r.rootFolderId);
      while (queue.length > 0) {
        if (session.signal.aborted) return;
        const folderId = queue.shift()!;
        let pageToken: string | undefined;
        do {
          if (session.signal.aborted) return;
          const page = await client.request<FileListPage>(listUrl(folderId, pageToken));
          const refs: ExternalRef[] = [];
          for (const f of page.files ?? []) {
            if (f.mimeType === GOOGLE_FOLDER_MIME) {
              if (!walked.has(f.id)) {
                walked.add(f.id);
                queue.push(f.id);
              }
              continue;
            }
            if (f.mimeType === GOOGLE_SHORTCUT_MIME) {
              const details = f.shortcutDetails;
              // Matches ingest: detail-less and shortcut-of-shortcut skipped.
              if (!details || details.targetMimeType === GOOGLE_SHORTCUT_MIME) continue;
              // No target name/size in this listing — resolved as today
              // (target mime only), then gated the same as an ordinary file.
              // The shortcut's OWN name is never passed here: a shortcut
              // named "song.mp3" pointing at a real PDF must not trip the
              // extension-rescue branch on the wrong file's name. But an
              // 'unsupported' verdict reached that way is ambiguous — see
              // shortcutIgnoreIsDefinite — so only a DEFINITE ignore is
              // omitted here; an ambiguous one is over-admitted (a phantom
              // ref costs nothing; an omitted one gets archived next pass).
              const shortcutRoute = chooseRoute(details.targetMimeType, '');
              if (shortcutIgnoreIsDefinite(shortcutRoute, details.targetMimeType)) continue;
              refs.push({
                externalId: details.targetId,
                type: details.targetMimeType === GOOGLE_DOC_MIME ? 'gdocs.doc' : 'file',
              });
              continue;
            }
            const size = Number(f.size);
            if (
              chooseRoute(f.mimeType, f.name, Number.isFinite(size) ? size : undefined).kind ===
              'ignore'
            ) {
              continue;
            }
            refs.push({
              externalId: f.id,
              type: f.mimeType === GOOGLE_DOC_MIME ? 'gdocs.doc' : 'file',
            });
          }
          yield refs;
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
    },
  };
}
