/**
 * Google-Docs-specific test harness: a fake Drive world router keyed by
 * endpoint, a Query fake, and Drive file fixtures.
 *
 * The GENERIC plumbing — host-shaped JSON responses, the scripted-fetch
 * skeleton (call log + per-URL counts + custom-first hook), the instant clock,
 * and the Session / AuthChannel fakes — comes from
 * `@kiagent/connector-sdk/testing`; only what knows about Drive lives here.
 * `jsonRes` / `instantClock` / `HostResponse` are re-exported so the suites
 * keep importing everything from this one module.
 *
 * Lives outside src/__tests__ so jest's default testMatch does not treat it
 * as a suite. Never bundled: build.mjs only follows imports from index.ts.
 */
import type {
  AuthChannel,
  Credentials,
  Document,
  FolderNode,
  FolderPickerSpec,
  HostFor,
  Query,
  Session,
} from '@kiagent/connector-sdk';
import type { HostResponse } from '@kiagent/connector-sdk/http';
import {
  fakeAuthChannel,
  fakeSession,
  instantClock,
  jsonRes,
  scriptedFetch,
} from '@kiagent/connector-sdk/testing';
import type { NetFetch } from '../client';
import type { DriveFile } from '../source';

export type { HostResponse };
/** `instantClock` = instant sleep + zero jitter for the source/client seam. */
export { instantClock, jsonRes };

export const textRes = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HostResponse => ({
  status,
  statusText: '',
  headers,
  body: new TextEncoder().encode(body),
});

export const bytesRes = (status: number, body: Uint8Array): HostResponse => ({
  status,
  statusText: '',
  headers: {},
  body,
});

const isHostResponse = (v: unknown): v is HostResponse =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as HostResponse).status === 'number' &&
  (v as HostResponse).body instanceof Uint8Array;

export interface ChangesPageFx {
  changes?: { fileId: string; removed?: boolean; file?: DriveFile }[];
  newStartPageToken?: string;
  nextPageToken?: string;
}

/** The fake upstream Drive. Every field optional; unhandled requests throw
 *  loudly (which the client treats as a network error and retries — tests
 *  run with instant sleep, so a genuinely missing fixture still fails fast). */
export interface DriveWorld {
  startPageToken?: string;
  /** files/root?fields=id — the REAL id behind the 'root' alias. */
  rootId?: string;
  /** folderId → one page (flat array) or explicit pages (array of arrays).
   *  Pagination tokens are synthesized as `<folderId>@<pageIndex>`. Serves
   *  the ingest listing, the picker's children query (folders only), and the
   *  picker's count query. */
  lists?: Record<string, DriveFile[] | DriveFile[][]>;
  /** sharedWithMe folder listing for the picker's Shared-with-me tab; same
   *  page shape as `lists`, tokens synthesized as `shared@<pageIndex>`. */
  sharedRoots?: DriveFile[] | DriveFile[][];
  /** changes.list pages keyed by the requesting pageToken. */
  changes?: Record<string, ChangesPageFx>;
  /** pageTokens that respond 400 "page token is invalid". */
  changesInvalid?: string[];
  /** fileId → markdown-export result (string = 200 text). */
  exportsMd?: Record<string, string | HostResponse>;
  /** fileId → text/plain-export result. */
  exportsPlain?: Record<string, string | HostResponse>;
  /** fileId → alt=media result. */
  media?: Record<string, Uint8Array | HostResponse>;
  /** fileId → metadata GET result (?fields=… — shallow / shortcut target /
   *  connect folder validation). */
  gets?: Record<string, DriveFile | HostResponse>;
  about?: { emailAddress?: string; displayName?: string };
  /** Checked first; return undefined to fall through to the world tables.
   *  `count` is the per-exact-URL call number (0-based). */
  custom?: (url: URL, count: number) => HostResponse | undefined;
}

/** Routes ONE Drive request against the world tables. A missing fixture
 *  throws by design — see DriveWorld. */
function routeDrive(url: URL, world: DriveWorld): HostResponse {
  const p = url.pathname;
  if (p === '/drive/v3/changes/startPageToken') {
    return jsonRes(200, { startPageToken: world.startPageToken ?? 'spt-1' });
  }
  if (p === '/drive/v3/about') {
    return jsonRes(200, {
      user: world.about ?? { emailAddress: 'user@example.com', displayName: 'User' },
    });
  }
  if (p === '/drive/v3/changes') {
    const tok = url.searchParams.get('pageToken') ?? '';
    if (world.changesInvalid?.includes(tok)) {
      return jsonRes(400, {
        error: { code: 400, message: 'Invalid Value — page token is invalid.' },
      });
    }
    const page = world.changes?.[tok];
    if (!page) throw new Error(`fake drive: no changes page for token ${tok}`);
    return jsonRes(200, page);
  }
  if (p === '/drive/v3/files') {
    const q = url.searchParams.get('q') ?? '';
    const tok = url.searchParams.get('pageToken');
    const paginate = (key: string, raw: DriveFile[] | DriveFile[][]) => {
      const pages: DriveFile[][] = Array.isArray(raw[0])
        ? (raw as DriveFile[][])
        : [raw as DriveFile[]];
      const idx = tok ? Number(tok.split('@')[1]) : 0;
      const body: { files?: DriveFile[]; nextPageToken?: string } = {
        files: pages[idx] ?? [],
      };
      if (idx + 1 < pages.length) body.nextPageToken = `${key}@${idx + 1}`;
      return jsonRes(200, body);
    };
    // Picker: shared-with-me folder roots.
    if (q.startsWith('sharedWithMe = true')) {
      return paginate('shared', world.sharedRoots ?? []);
    }
    // Ingest listing (`trashed=false`), picker children (folder-mime
    // clause), and picker count (`trashed = false`) all serve from
    // world.lists; the children query filters to folders.
    const m =
      /^'(.+)' in parents and (?:mimeType = 'application\/vnd\.google-apps\.folder' and )?trashed ?= ?false$/.exec(
        q,
      );
    const folderId = m?.[1] ?? '';
    const raw = world.lists?.[folderId];
    if (raw === undefined) throw new Error(`fake drive: no listing for folder ${folderId}`);
    const res = paginate(folderId, raw);
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
      const body = JSON.parse(new TextDecoder().decode(res.body)) as {
        files?: DriveFile[];
        nextPageToken?: string;
      };
      body.files = (body.files ?? []).filter(
        (f) => f.mimeType === 'application/vnd.google-apps.folder',
      );
      return jsonRes(200, body);
    }
    return res;
  }
  if (p === '/drive/v3/files/root') {
    return jsonRes(200, { id: world.rootId ?? 'MYDRIVE' });
  }
  const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p);
  if (exp) {
    const mime = url.searchParams.get('mimeType');
    const table = mime === 'text/markdown' ? world.exportsMd : world.exportsPlain;
    const v = table?.[exp[1]];
    if (v === undefined) throw new Error(`fake drive: no ${mime} export for ${exp[1]}`);
    return typeof v === 'string' ? textRes(200, v) : v;
  }
  const fileM = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (fileM) {
    if (url.searchParams.get('alt') === 'media') {
      const v = world.media?.[fileM[1]];
      if (v === undefined) throw new Error(`fake drive: no media for ${fileM[1]}`);
      return v instanceof Uint8Array ? bytesRes(200, v) : v;
    }
    const v = world.gets?.[fileM[1]];
    if (v === undefined) throw new Error(`fake drive: no file get for ${fileM[1]}`);
    return isHostResponse(v) ? v : jsonRes(200, v);
  }
  throw new Error(`fake drive: unhandled url ${url.href}`);
}

/** A Drive-shaped `scriptedFetch`: the SDK kit owns the call log and the
 *  per-URL counters, `routeDrive` owns the endpoints. `world.custom` still
 *  wins over the world tables. */
export function driveFetch(world: DriveWorld = {}): {
  fetchFn: NetFetch;
  calls: string[];
} {
  const { fetchFn, calls } = scriptedFetch({
    custom: (url, count) => world.custom?.(url, count) ?? routeDrive(url, world),
  });
  return { fetchFn, calls };
}

export function fakeQuery(docs: Document[] = []): Query & {
  byExternalIdCalls: Array<{ account: string; externalId: string; type: string }>;
} {
  const byExternalIdCalls: Array<{ account: string; externalId: string; type: string }> = [];
  const unused = () => {
    throw new Error('unused Query surface');
  };
  return {
    byExternalIdCalls,
    byExternalId: async (account, externalId, type) => {
      byExternalIdCalls.push({ account: String(account), externalId, type });
      return (
        docs.find(
          (d) => d.accountId === account && d.externalId === externalId && d.type === type,
        ) ?? null
      );
    },
    document: unused,
    children: unused,
    search: unused,
    count: unused,
    accounts: unused,
  };
}

export function makeHost(fetchFn: NetFetch, query: Query = fakeQuery()): HostFor<'net' | 'query'> {
  return {
    self: { id: 'kia.google-docs', dataDir: '/tmp' },
    log: () => {},
    net: { fetch: fetchFn },
    query,
  };
}

/** The kit's `fakeSession` carrying this connector's account identity, with
 *  the `{ level, msg }` log records the suites assert on (the kit collects
 *  `[level, msg]` tuples). */
export function makeSession(
  opts: {
    creds?: Credentials | null;
    config?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): { session: Session; logs: { level: string; msg: string }[] } {
  const logs: { level: string; msg: string }[] = [];
  const base = fakeSession({
    account: {
      id: 'acc-1',
      source: 'google-docs',
      identifier: 'user@example.com',
      config: opts.config ?? {},
      cursor: null,
    },
    credentials: opts.creds === undefined ? { accessToken: 'ya29.test-deadbeef' } : opts.creds,
    signal: opts.signal,
  });
  // Field-by-field, NOT a spread: the kit's session also carries its own
  // `logs` tuple array, and spreading would hang that always-empty array off
  // the returned session where it would silently shadow the real one.
  const session: Session = {
    account: base.account,
    signal: base.signal,
    credentials: base.credentials,
    log: (level, msg) => logs.push({ level, msg }),
  };
  return { session, logs };
}

/** The kit's `fakeAuthChannel` with every verb scripted to a Google-Docs
 *  default (the kit's own defaults reject) plus recorders for what connect()
 *  asked each verb for. */
export function makeAuth(
  opts: {
    creds?: Credentials;
    answers?: Record<string, unknown>;
    /** pickFolders resolves this selection (default: My Drive) — or, when a
     *  function, drives the spec itself (e.g. to reject as a user cancel). */
    picked?: FolderNode[] | ((spec: FolderPickerSpec) => Promise<FolderNode[]>);
  } = {},
): {
  auth: AuthChannel;
  statuses: string[];
  getScopes: () => string[] | undefined;
  getSchema: () => unknown;
  getPickerSpec: () => FolderPickerSpec | undefined;
} {
  let scopes: string[] | undefined;
  let schema: unknown;
  let pickerSpec: FolderPickerSpec | undefined;
  const auth = fakeAuthChannel({
    oauth: async (s) => {
      scopes = s;
      return opts.creds ?? { accessToken: 'ya29.test-deadbeef' };
    },
    prompt: async (s) => {
      schema = s;
      return opts.answers ?? {};
    },
    pickFolders: async (spec) => {
      pickerSpec = spec;
      if (typeof opts.picked === 'function') return opts.picked(spec);
      return opts.picked ?? [{ id: 'root', name: 'My Drive', hasChildren: true }];
    },
  });
  return {
    auth,
    statuses: auth.statuses,
    getScopes: () => scopes,
    getSchema: () => schema,
    getPickerSpec: () => pickerSpec,
  };
}

export function fakeDoc(
  externalId: string,
  type: string,
  metadata: Record<string, unknown>,
  over: Partial<Document> = {},
): Document {
  return {
    id: `id-${externalId}-${type}`,
    accountId: 'acc-1',
    parentId: null,
    externalId,
    type,
    title: externalId,
    markdown: '',
    metadata,
    createdAt: null,
    contentHash: 'hash-x',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// ── Drive file fixture builders ─────────────────────────────────────────────

export function gdoc(id: string, name: string, over: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.document',
    parents: ['MYDRIVE'],
    webViewLink: `https://docs.google.com/document/d/${id}/edit`,
    headRevisionId: `rev-${id}-1`,
    modifiedTime: '2026-05-01T10:00:00Z',
    createdTime: '2026-04-01T10:00:00Z',
    ...over,
  };
}

export function folder(id: string, name: string, over: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['MYDRIVE'],
    ...over,
  };
}

export function pdf(id: string, name: string, over: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: ['MYDRIVE'],
    md5Checksum: `md5-${id}-1`,
    size: '2048',
    modifiedTime: '2026-05-02T10:00:00Z',
    createdTime: '2026-04-02T10:00:00Z',
    ...over,
  };
}

export function shortcut(
  id: string,
  name: string,
  targetId: string,
  targetMimeType: string,
  over: Partial<DriveFile> = {},
): DriveFile {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.shortcut',
    parents: ['MYDRIVE'],
    shortcutDetails: { targetId, targetMimeType },
    ...over,
  };
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}
