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
  AuthChannel,
  Batch,
  Credentials,
  Document,
  DocumentInput,
  ExternalRef,
  FolderCount,
  FolderNode,
  HostFor,
  Query,
  Session,
  Source,
} from './kiagent-contracts';
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
  isConvertibleMime,
} from './export-map';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
/** v1 had NO cap (whole file into a Buffer — v1 gap #6); v2 binds one. */
export const MAX_BINARY_BYTES = 25 * 1024 * 1024;
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
  files?: { id: string; mimeType: string }[];
  nextPageToken?: string;
}

function countListUrl(folderId: string, pageToken?: string): string {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `'${escapeDriveId(folderId)}' in parents and trashed = false`);
  url.searchParams.set('fields', 'files(id,mimeType),nextPageToken');
  url.searchParams.set('pageSize', '1000');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

/**
 * Budgeted recursive BFS file count behind the picker's per-row "N files".
 * Each files.list PAGE spends one request of the budget; non-folders count
 * (shortcuts too — an estimate, targets are not resolved), folders enqueue.
 * Exiting with work remaining (budget spent or CAP reached, including a
 * dangling nextPageToken) → `capped: true`, count is a lower bound. Any Drive
 * error resolves `null` (uncounted row) — a count must never kill the picker.
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
          } else if (++counted >= COUNT_CAP) {
            return { count: counted, capped: true };
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    return { count: counted, capped: false };
  } catch {
    return null;
  }
}

/** Normalize account config to the tracked roots. Accepts the v2.1.0
 *  multi-root shape (`roots: [{ rootFolderId, rootName }]`), the legacy
 *  v2.0.0 single-root fields (`rootFolderId`/`rootName`), or nothing (all of
 *  My Drive). Per-entry name fallback: 'My Drive' for the 'root' alias, the
 *  id otherwise. Deduped by rootFolderId — first entry wins. */
export function rootsConfig(session: Session): RootConfig[] {
  const cfg = session.account.config as {
    roots?: unknown;
    rootFolderId?: unknown;
    rootName?: unknown;
  };
  const nameFor = (id: string, name: unknown): string => {
    if (typeof name === 'string' && name) return name;
    return id === 'root' ? 'My Drive' : id;
  };

  const parsed: RootConfig[] = [];
  if (Array.isArray(cfg.roots)) {
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
    // Legacy v2.0.0 single-root config; no config at all → My Drive.
    const id =
      typeof cfg.rootFolderId === 'string' && cfg.rootFolderId ? cfg.rootFolderId : 'root';
    parsed.push({ rootFolderId: id, rootName: nameFor(id, cfg.rootName) });
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
  // A 'failed' row (both exports exhausted — possibly just a quota storm)
  // must be retried on the next walk/tick: never pin it behind an unchanged
  // revision id. 'too-large'/'unsupported' rows still skip — re-fetching
  // changes nothing for those.
  if (meta.extraction_status === 'failed') return false;
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
 * Route one listed/changed file into a DriveItem (or null to skip it).
 * Shortcuts resolve to their target once (shortcut-of-shortcut: warn +
 * skip), keeping the SHORTCUT's parents so the doc sits in the indexed
 * subtree (v1 ingest.ts parity). May do I/O (export/download/target fetch) —
 * toDocument stays pure.
 */
async function buildItem(
  raw: DriveFile,
  segments: string[],
  root: RootConfig,
  deps: ItemDeps,
): Promise<DriveItem | null> {
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
  const route = chooseRoute(file.mimeType);

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
        return metadataOnly(file, 'gdocs.doc', 'failed', displayPath, root.rootFolderId);
      }
    }
    return {
      file,
      docType: 'gdocs.doc',
      markdown,
      extractionStatus: 'ok',
      displayPath,
      rootFolderId: root.rootFolderId,
    };
  }

  if (route.kind === 'binary') {
    if (await hashSkip(deps, file.id, 'file', 'md5_checksum', file.md5Checksum)) {
      return null;
    }
    if (Number(file.size ?? 0) > MAX_BINARY_BYTES) {
      return metadataOnly(file, 'file', 'too-large', displayPath, root.rootFolderId);
    }
    const bytes = await deps.client.request<Uint8Array>(mediaUrl(file.id), {
      responseType: 'bytes',
    });
    // Post-download cap: Drive binaries virtually always carry `size`, but
    // the cap is the guarantee — an unknown-size file must not slip past it.
    if (bytes.byteLength > MAX_BINARY_BYTES) {
      return metadataOnly(file, 'file', 'too-large', displayPath, root.rootFolderId);
    }
    return {
      file,
      docType: 'file',
      markdown: null,
      bytes,
      extractionStatus: 'ok',
      displayPath,
      rootFolderId: root.rootFolderId,
    };
  }

  return metadataOnly(file, 'file', 'unsupported', displayPath, root.rootFolderId);
}

/**
 * BFS backfill across ALL configured roots (v1 backfill.ts walkFolder). One
 * batch per files.list page; the cursor stays `{ page_token, backfill_done:
 * false }` the whole walk — a crash at any boundary redoes the walk, which
 * is SAFE (idempotent upserts) and cheap (hash-skip). Ends with a final
 * `live` flip batch.
 */
async function* backfill(
  client: DriveClient,
  session: Session,
  query: Query,
  cursor: DriveCursor | null,
  roots: RootConfig[],
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

  while (queue.length > 0) {
    if (session.signal.aborted) return;
    const head = queue.shift()!;
    const page = await client.request<FileListPage>(
      listUrl(head.folderId, head.pageToken),
    );

    const items: DriveItem[] = [];
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
        const item = await buildItem(f, head.segments, head.root, deps);
        if (item) items.push(item);
      } catch (e) {
        // One unreadable file must not abort the walk (v1 backfill parity).
        if (isAuthError(e)) throw e;
        session.log('warn', `google-docs backfill: file ${f.id} skipped: ${errText(e)}`);
      }
    }

    yield {
      phase: 'backfill',
      items,
      cursor: { page_token: pageToken, backfill_done: false },
    };

    if (page.nextPageToken) {
      queue.unshift({ ...head, pageToken: page.nextPageToken });
    }
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

    const items: DriveItem[] = [];
    const deletions: ExternalRef[] = [];
    for (const c of byId.values()) {
      if (session.signal.aborted) return;
      try {
        if (c.removed || c.file?.trashed) {
          deletions.push(...(await existingRefs(query, session, c.fileId)));
          index.delete(c.fileId);
          continue;
        }
        if (!c.file) continue;
        if (c.file.mimeType === GOOGLE_FOLDER_MIME) {
          // Track the move/rename for later ancestor walks. Descendants'
          // display_path is NOT re-rendered (v1 parity — see README).
          index.set(c.file.id, { name: c.file.name, parents: c.file.parents ?? [] });
          continue;
        }
        const scope = await resolveScope(c.file, rootIds, index, client);
        if (!scope.inScope) {
          // Moved out of every indexed subtree: archive whatever exists locally.
          deletions.push(...(await existingRefs(query, session, c.fileId)));
          continue;
        }
        const item = await buildItem(
          c.file,
          scope.segments,
          byRootId.get(scope.rootId!)!,
          deps,
        );
        if (item) items.push(item);
      } catch (e) {
        // Per-file guard — the v1-bug-3 fix: one bad file never aborts the
        // tick. Auth errors propagate.
        if (isAuthError(e)) throw e;
        session.log('warn', `google-docs delta: file ${c.fileId} skipped: ${errText(e)}`);
      }
    }

    const next = page.nextPageToken ?? page.newStartPageToken ?? pageToken;
    yield {
      phase: 'live',
      items,
      deletions,
      cursor: { page_token: next, backfill_done: true },
    };

    if (!page.nextPageToken) return;
    pageToken = page.nextPageToken;
  }
}

export function createGoogleDocsSource(
  host: HostFor<'net' | 'query'>,
  // Test seam only: DriveClient's sleep/random are injectable so retry tests
  // never actually wait; production callers omit this.
  clock?: Pick<DriveClientDeps, 'sleep' | 'random'>,
): Source<DriveCursor, DriveItem> {
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

      // The platform's shared folder-picker: lazy tree over the connect-time
      // client, multi-select with covering roots. A user cancel rejects —
      // let that propagate out of connect().
      const picked = await auth.pickFolders({
        modes: [
          { key: 'my-drive', label: 'My Drive' },
          { key: 'shared', label: 'Shared with me' },
        ],
        multiSelect: true,
        roots: async (mode) =>
          mode === 'my-drive'
            ? [{ id: 'root', name: 'My Drive', hasChildren: true }]
            : listSharedRoots(client),
        children: (id) => listChildFolders(client, id),
        count: (id) => countFilesUnder(client, id),
      });
      if (picked.length === 0) throw new Error('google-docs: no folders selected');
      return {
        identifier: about.user.emailAddress,
        config: { roots: picked.map((n) => ({ rootFolderId: n.id, rootName: n.name })) },
      };
    },

    async *pull(session: Session, cursor: DriveCursor | null) {
      const client = clientFor(session);
      const roots = rootsConfig(session);
      if (!cursor || !cursor.backfill_done) {
        yield* backfill(client, session, host.query, cursor, roots);
      } else {
        yield* delta(client, session, host.query, cursor, roots);
      }
    },

    toDocument(item: DriveItem): DocumentInput {
      const f = item.file;
      return {
        externalId: f.id,
        type: item.docType,
        title: f.name,
        markdown: item.markdown,
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
     *  document. */
    async fetchBytes(session: Session, doc: Document): Promise<Uint8Array | null> {
      if (doc.type === 'gdocs.doc') return null;
      const meta = doc.metadata as Record<string, unknown>;
      const fileId = meta.drive_file_id;
      if (typeof fileId !== 'string' || !fileId) return null;
      const mime = typeof meta.mime_type === 'string' ? meta.mime_type : '';
      if (!isConvertibleMime(mime)) return null;
      const size = Number(meta.size_bytes ?? 0);
      if (Number.isFinite(size) && size > MAX_BINARY_BYTES) return null;
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
     * else → 'file'; shortcuts → the TARGET id, matching ingest). ANY listing
     * failure THROWS — the engine treats a thrown reconcile as a partial
     * listing and skips the deletion diff; yielding a partial live-set would
     * mass-archive documents.
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
              refs.push({
                externalId: details.targetId,
                type: details.targetMimeType === GOOGLE_DOC_MIME ? 'gdocs.doc' : 'file',
              });
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
