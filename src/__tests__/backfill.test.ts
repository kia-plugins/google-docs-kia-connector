/**
 * Backfill suite: BFS walk with page-aligned batches, stable cursor until the
 * final live flip, display_path, shortcut resolution, export fallback chain,
 * routing (unsupported / too-large), hash-skip, per-file fault tolerance,
 * abort, resume-without-recapture, and auth propagation.
 */
import {
  createGoogleDocsSource,
  MAX_BINARY_BYTES,
  type DriveCursor,
  type DriveItem,
} from '../source';
import { GoogleDocsAuthError } from '../client';
import type { Batch } from '@kiagent/connector-sdk';
import {
  collect,
  driveFetch,
  fakeDoc,
  fakeQuery,
  folder,
  gdoc,
  instantClock,
  jsonRes,
  makeHost,
  makeSession,
  pdf,
  shortcut,
} from '../testing/harness';

type B = Batch<DriveCursor, DriveItem>;

const ids = (b: B) => b.items.map((i) => i.file.id);

function makeSource(world: Parameters<typeof driveFetch>[0], query = fakeQuery()) {
  const { fetchFn, calls } = driveFetch(world);
  const source = createGoogleDocsSource(makeHost(fetchFn, query), instantClock);
  return { source, calls, query };
}

describe('backfill', () => {
  it('BFS-walks a 2-level tree with pagination: one batch per page, cursor stable, final live flip', async () => {
    const { source, calls } = makeSource({
      startPageToken: 'spt-1',
      lists: {
        root: [[gdoc('docA', 'Doc A'), folder('S', 'Sub')], [pdf('pdfB', 'b.pdf')]],
        S: [gdoc('docC', 'Doc C', { parents: ['S'] })],
      },
      exportsMd: { docA: '# Doc A', docC: '# Doc C' },
      media: { pdfB: new Uint8Array([9, 9]) },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches).toHaveLength(4);
    expect(batches.map((b) => b.phase)).toEqual(['backfill', 'backfill', 'backfill', 'live']);
    // startPageToken captured FIRST, before any listing.
    expect(calls[0]).toContain('/changes/startPageToken');
    // Cursor unchanged all walk long; only the final batch flips.
    for (const b of batches.slice(0, 3)) {
      expect(b.cursor).toEqual({ page_token: 'spt-1', backfill_done: false });
    }
    expect(batches[3]).toEqual({
      phase: 'live',
      items: [],
      cursor: { page_token: 'spt-1', backfill_done: true },
    });
    // Page-aligned batches in BFS order: root p0, root p1, then Sub.
    expect(ids(batches[0])).toEqual(['docA']);
    expect(ids(batches[1])).toEqual(['pdfB']);
    expect(ids(batches[2])).toEqual(['docC']);
    // Native export + binary download happened.
    expect(batches[0].items[0]).toMatchObject({
      docType: 'gdocs.doc',
      markdown: '# Doc A',
      extractionStatus: 'ok',
    });
    expect(batches[1].items[0]).toMatchObject({ docType: 'file', markdown: null });
    expect(batches[1].items[0].bytes).toEqual(new Uint8Array([9, 9]));
    // display_path: rootName + intermediate folder names.
    expect(batches[0].items[0].displayPath).toBe('My Drive');
    expect(batches[2].items[0].displayPath).toBe('My Drive / Sub');
  });

  it('resolves shortcuts to their target (keeping the shortcut parents) and skips shortcut-of-shortcut with a warn', async () => {
    const { source } = makeSource({
      lists: {
        root: [
          shortcut('sc1', 'A link', 'TD1', 'application/vnd.google-apps.document', {
            parents: ['MYDRIVE'],
          }),
          shortcut('sc2', 'Chain link', 'TD2', 'application/vnd.google-apps.shortcut'),
        ],
      },
      gets: { TD1: gdoc('TD1', 'Target Doc', { parents: ['ELSEWHERE'] }) },
      exportsMd: { TD1: '# Target' },
    });
    const { session, logs } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(ids(batches[0])).toEqual(['TD1']);
    // Target metadata, shortcut's parents (v1 ingest parity).
    expect(batches[0].items[0].file.parents).toEqual(['MYDRIVE']);
    expect(logs.some((l) => l.level === 'warn' && /shortcut-of-shortcut.*sc2/.test(l.msg))).toBe(
      true,
    );
  });

  it('falls back to text/plain when the markdown export fails non-retryably', async () => {
    const { source } = makeSource({
      lists: { root: [gdoc('docA', 'Doc A')] },
      exportsMd: { docA: jsonRes(400, { error: { message: 'Export only supports…' } }) },
      exportsPlain: { docA: 'plain text body' },
    });
    const { session, logs } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches[0].items[0]).toMatchObject({
      docType: 'gdocs.doc',
      markdown: 'plain text body',
      extractionStatus: 'ok',
    });
    expect(logs.some((l) => /markdown export failed.*docA/.test(l.msg))).toBe(true);
  });

  it('emits a metadata-only gdocs.doc row when both exports fail', async () => {
    const fail = jsonRes(400, { error: { message: 'nope' } });
    const { source } = makeSource({
      lists: { root: [gdoc('docA', 'Doc A')] },
      exportsMd: { docA: fail },
      exportsPlain: { docA: fail },
    });
    const { session, logs } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches[0].items[0]).toMatchObject({
      docType: 'gdocs.doc',
      markdown: '',
      extractionStatus: 'failed',
    });
    expect(batches[0].items[0].bytes).toBeUndefined();
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it('routes non-Doc Google-native types to metadata-only unsupported rows (no fetch)', async () => {
    const sheet = {
      id: 'sheet1',
      name: 'Budget',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['MYDRIVE'],
      modifiedTime: '2026-05-01T00:00:00Z',
    };
    const { source, calls } = makeSource({ lists: { root: [sheet] } });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches[0].items[0]).toMatchObject({
      docType: 'file',
      markdown: '',
      extractionStatus: 'unsupported',
    });
    expect(calls.filter((u) => u.includes('sheet1'))).toEqual([]);
  });

  it('skips bytes for a too-large binary (no alt=media call) and marks it too-large', async () => {
    const big = pdf('big1', 'huge.pdf', { size: String(26 * 1024 * 1024) });
    const { source, calls } = makeSource({ lists: { root: [big] } });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches[0].items[0]).toMatchObject({
      docType: 'file',
      markdown: '',
      extractionStatus: 'too-large',
    });
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
  });

  it('hash-skip: unchanged head_revision_id / md5_checksum → no export, no download, no item', async () => {
    const query = fakeQuery([
      fakeDoc('docA', 'gdocs.doc', { head_revision_id: 'rev-docA-1' }),
      fakeDoc('pdfB', 'file', { md5_checksum: 'md5-pdfB-1' }),
    ]);
    const { source, calls } = makeSource(
      { lists: { root: [gdoc('docA', 'Doc A'), pdf('pdfB', 'b.pdf')] } },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches.flatMap(ids)).toEqual([]);
    expect(calls.some((u) => u.includes('/export'))).toBe(false);
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
    expect(query.byExternalIdCalls).toContainEqual({
      account: 'acc-1',
      externalId: 'docA',
      type: 'gdocs.doc',
    });
  });

  it('hash-skip does NOT apply to an archived match (re-emitting un-archives it)', async () => {
    const query = fakeQuery([
      fakeDoc(
        'docA',
        'gdocs.doc',
        { head_revision_id: 'rev-docA-1' },
        { archivedAt: '2026-06-01T00:00:00Z' },
      ),
    ]);
    const { source } = makeSource(
      { lists: { root: [gdoc('docA', 'Doc A')] }, exportsMd: { docA: '# Doc A' } },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];
    expect(batches.flatMap(ids)).toEqual(['docA']);
  });

  it('hash-skip does NOT apply to a failed-extraction row — the export IS re-attempted', async () => {
    const query = fakeQuery([
      fakeDoc('docA', 'gdocs.doc', {
        head_revision_id: 'rev-docA-1', // matches the listed revision…
        extraction_status: 'failed', // …but the last walk's exports failed
      }),
    ]);
    const { source, calls } = makeSource(
      { lists: { root: [gdoc('docA', 'Doc A')] }, exportsMd: { docA: '# Doc A' } },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(calls.some((u) => u.includes('/export'))).toBe(true);
    expect(batches.flatMap(ids)).toEqual(['docA']);
    expect(batches[0].items[0]).toMatchObject({
      markdown: '# Doc A',
      extractionStatus: 'ok',
    });
  });

  it('caps an unknown-size binary AFTER download (post-hoc too-large row, no bytes emitted)', async () => {
    const { source } = makeSource({
      lists: { root: [pdf('nosize1', 'n.pdf', { size: undefined })] },
      media: { nosize1: new Uint8Array(MAX_BINARY_BYTES + 1) },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches[0].items[0]).toMatchObject({
      docType: 'file',
      markdown: '',
      extractionStatus: 'too-large',
    });
    expect(batches[0].items[0].bytes).toBeUndefined();
  });

  it('one unreadable file is warn-skipped and the walk continues', async () => {
    const { source } = makeSource({
      lists: { root: [pdf('bad1', 'bad.pdf'), gdoc('docA', 'Doc A')], S: [] },
      media: { bad1: jsonRes(404, { error: { message: 'File not found' } }) },
      exportsMd: { docA: '# Doc A' },
    });
    const { session, logs } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches.flatMap(ids)).toEqual(['docA']);
    expect(logs.some((l) => l.level === 'warn' && /file bad1 skipped/.test(l.msg))).toBe(true);
    // Still flips to live at the end.
    expect(batches[batches.length - 1].cursor.backfill_done).toBe(true);
  });

  it('stops cleanly when aborted mid-walk (no flip batch)', async () => {
    const controller = new AbortController();
    const { source } = makeSource({
      lists: {
        root: [[gdoc('docA', 'Doc A')], [gdoc('docB', 'Doc B')]],
      },
      exportsMd: { docA: '# A', docB: '# B' },
    });
    const { session } = makeSession({ signal: controller.signal });

    const iter = source.pull(session, null)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(ids(first.value as B)).toEqual(['docA']);
    controller.abort();
    const second = await iter.next();
    expect(second.done).toBe(true);
  });

  it('resumes an interrupted walk (backfill_done:false) reusing the saved page_token — no recapture', async () => {
    const { source, calls } = makeSource({
      lists: { root: [gdoc('docA', 'Doc A')] },
      exportsMd: { docA: '# Doc A' },
    });
    const { session } = makeSession();

    const batches = (await collect(
      source.pull(session, { page_token: 'pt-keep', backfill_done: false }),
    )) as B[];

    expect(calls.some((u) => u.includes('startPageToken'))).toBe(false);
    expect(batches[0].cursor).toEqual({ page_token: 'pt-keep', backfill_done: false });
    expect(batches[batches.length - 1].cursor).toEqual({
      page_token: 'pt-keep',
      backfill_done: true,
    });
  });

  it('recaptures a fresh startPageToken after the invalid-token recovery cursor (page_token empty)', async () => {
    const { source, calls } = makeSource({
      startPageToken: 'spt-fresh',
      lists: { root: [] },
    });
    const { session } = makeSession();

    const batches = (await collect(
      source.pull(session, { page_token: '', backfill_done: false }),
    )) as B[];

    expect(calls[0]).toContain('startPageToken');
    expect(batches[batches.length - 1].cursor).toEqual({
      page_token: 'spt-fresh',
      backfill_done: true,
    });
  });

  it('multi-root: seeds every root; a shared walked set ingests an overlapping subtree once', async () => {
    // Root B (FB) lives INSIDE root A (FA) — the one overlap Drive's
    // single-parent model allows. FB must be listed exactly once, and its
    // items attributed to root B (each root is seeded before any listing).
    const { source, calls } = makeSource({
      startPageToken: 'spt-1',
      lists: {
        FA: [gdoc('a1', 'A doc', { parents: ['FA'] }), folder('FB', 'B Folder', { parents: ['FA'] })],
        FB: [gdoc('b1', 'B doc', { parents: ['FB'] })],
      },
      exportsMd: { a1: '# A', b1: '# B' },
    });
    const { session } = makeSession({
      config: {
        roots: [
          { rootFolderId: 'FA', rootName: 'Alpha' },
          { rootFolderId: 'FB', rootName: 'Beta' },
        ],
      },
    });

    const batches = (await collect(source.pull(session, null))) as B[];

    const items = batches.flatMap((b) => b.items);
    // b1 exactly once — FB is never re-walked as a child of FA.
    expect(items.map((i) => i.file.id)).toEqual(['a1', 'b1']);
    expect(items[0]).toMatchObject({ displayPath: 'Alpha', rootFolderId: 'FA' });
    expect(items[1]).toMatchObject({ displayPath: 'Beta', rootFolderId: 'FB' });
    const fbLists = calls.filter((u) =>
      (new URL(u).searchParams.get('q') ?? '').includes("'FB' in parents"),
    );
    expect(fbLists).toHaveLength(1);
    // Still one shared cursor: stable until the single final live flip.
    expect(batches[batches.length - 1]).toEqual({
      phase: 'live',
      items: [],
      cursor: { page_token: 'spt-1', backfill_done: true },
    });
  });

  it('propagates auth errors out of the walk (401 on export)', async () => {
    const { source } = makeSource({
      lists: { root: [gdoc('docA', 'Doc A')] },
      exportsMd: { docA: jsonRes(401, { error: { message: 'Invalid Credentials' } }) },
    });
    const { session } = makeSession();

    await expect(collect(source.pull(session, null))).rejects.toThrow(GoogleDocsAuthError);
  });

  it('propagates missing credentials as an auth error', async () => {
    const { source } = makeSource({ lists: { root: [] } });
    const { session } = makeSession({ creds: null });

    await expect(collect(source.pull(session, null))).rejects.toThrow(
      /reconnect the account/,
    );
  });
});
