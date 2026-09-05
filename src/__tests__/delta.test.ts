/**
 * Delta suite: changes.list ingest with per-page cursor commits, query-first
 * deletions, scope checks against the resolved real root, per-file fault
 * tolerance (the v1-bug-3 regression test), invalid-token recovery, and auth
 * propagation.
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
  binaryFile,
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

const LIVE = { page_token: 'pt-1', backfill_done: true };

function makeSource(world: Parameters<typeof driveFetch>[0], query = fakeQuery()) {
  const { fetchFn, calls } = driveFetch(world);
  const source = createGoogleDocsSource(makeHost(fetchFn, query), instantClock);
  return { source, calls, query };
}

describe('delta', () => {
  it('ingests an in-scope add/modify and commits newStartPageToken', async () => {
    const { source, calls } = makeSource({
      changes: {
        'pt-1': {
          changes: [{ fileId: 'docA', file: gdoc('docA', 'Doc A') }],
          newStartPageToken: 'nspt-2',
        },
      },
      exportsMd: { docA: '# Doc A v2' },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches).toHaveLength(1);
    expect(batches[0].phase).toBe('live');
    expect(batches[0].items.map((i) => i.file.id)).toEqual(['docA']);
    expect(batches[0].items[0].markdown).toBe('# Doc A v2');
    expect(batches[0].deletions).toEqual([]);
    expect(batches[0].cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
    // My Drive root resolved once for the scope walk ('root' is an alias).
    expect(calls.filter((u) => u.includes('/files/root'))).toHaveLength(1);
  });

  it('removed change → deletion refs ONLY for locally existing types (query-first)', async () => {
    const query = fakeQuery([fakeDoc('gone1', 'gdocs.doc', {})]);
    const { source } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [{ fileId: 'gone1', removed: true }],
            newStartPageToken: 'nspt-2',
          },
        },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].deletions).toEqual([{ externalId: 'gone1', type: 'gdocs.doc' }]);
    expect(batches[0].items).toEqual([]);
    // Both types probed, only the existing one emitted.
    expect(query.byExternalIdCalls.map((c) => c.type).sort()).toEqual(['file', 'gdocs.doc']);
  });

  it('trashed file → same query-first deletion path', async () => {
    const query = fakeQuery([fakeDoc('tr1', 'file', {})]);
    const { source } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [{ fileId: 'tr1', file: pdf('tr1', 't.pdf', { trashed: true }) }],
            newStartPageToken: 'nspt-2',
          },
        },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];
    expect(batches[0].deletions).toEqual([{ externalId: 'tr1', type: 'file' }]);
  });

  it('a policy-ignored change (MP3) to a pre-existing live file doc: exactly one deletion ref, no item, no download', async () => {
    const query = fakeQuery([fakeDoc('mp3-1', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [{ fileId: 'mp3-1', file: binaryFile('mp3-1', 'song.mp3', 'audio/mpeg') }],
            newStartPageToken: 'nspt-2',
          },
        },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].deletions).toEqual([{ externalId: 'mp3-1', type: 'file' }]);
    expect(batches[0].items).toEqual([]);
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
  });

  it('a policy-ignored change (ZIP) to a pre-existing live file doc: exactly one deletion ref, no item, no download', async () => {
    const query = fakeQuery([fakeDoc('zip-1', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'zip-1', file: binaryFile('zip-1', 'archive.zip', 'application/zip') },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].deletions).toEqual([{ externalId: 'zip-1', type: 'file' }]);
    expect(batches[0].items).toEqual([]);
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
  });

  it('a post-download too-large ignore (unknown pre-download size) still emits a deletion for a pre-existing live row', async () => {
    // Unknown size is admitted PROVISIONALLY pre-download (chooseRoute has
    // no size to cap on) — the change is downloaded, and only THEN does the
    // post-download backstop discover it exceeds the cap. That 'ignored'
    // BuildResult must be treated the same as a pre-download ignore: a
    // deletion ref for the pre-existing row, not silence.
    const query = fakeQuery([fakeDoc('nosize1', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'nosize1', file: pdf('nosize1', 'n.pdf', { size: undefined }) },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        media: { nosize1: new Uint8Array(MAX_BINARY_BYTES + 1) },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    // The download DID happen (unknown size was admitted provisionally)...
    expect(calls.some((u) => u.includes('alt=media'))).toBe(true);
    // ...but the oversized bytes are discarded: no item, one deletion ref.
    expect(batches[0].items).toEqual([]);
    expect(batches[0].deletions).toEqual([{ externalId: 'nosize1', type: 'file' }]);
  });

  it('a shortcut whose target mime is audio/mpeg is ignored after target resolution: deletion when a local row exists, no download', async () => {
    const query = fakeQuery([fakeDoc('song-target', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'sc1', file: shortcut('sc1', 'Song link', 'song-target', 'audio/mpeg') },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        gets: { 'song-target': binaryFile('song-target', 'song.mp3', 'audio/mpeg') },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].deletions).toEqual([{ externalId: 'song-target', type: 'file' }]);
    expect(batches[0].items).toEqual([]);
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
    // Target resolution DID happen (needed to learn the real mime) — the
    // download that follows a positive route did not.
    expect(calls.some((u) => u.includes('song-target'))).toBe(true);
  });

  it('a shortcut whose target is served with a generic mime but a rescuable .pdf name IS indexed (extension rescue, real target name only known after resolution)', async () => {
    const { source, calls } = makeSource({
      changes: {
        'pt-1': {
          changes: [
            {
              fileId: 'sc1',
              file: shortcut('sc1', 'Scan link', 'scan-target', 'application/octet-stream'),
            },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      gets: {
        'scan-target': binaryFile('scan-target', 'scan.pdf', 'application/octet-stream'),
      },
      media: { 'scan-target': new Uint8Array([1, 2, 3]) },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    // The shortcut's own name ('Scan link') has no extension worth rescuing
    // on — it is the TARGET's real name ('scan.pdf'), only known after
    // buildItem resolves the shortcut, that trips decideFileIndexing's
    // octet-stream + '.pdf' rescue branch.
    expect(batches.flatMap((b) => b.items.map((i) => i.file.id))).toEqual(['scan-target']);
    expect(calls.some((u) => u.includes('alt=media'))).toBe(true);
  });

  it('out-of-scope move → deletion ref for the locally existing doc, nothing downloaded', async () => {
    const query = fakeQuery([fakeDoc('mv1', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [{ fileId: 'mv1', file: pdf('mv1', 'm.pdf', { parents: ['OUTSIDE'] }) }],
            newStartPageToken: 'nspt-2',
          },
        },
        gets: { OUTSIDE: folder('OUTSIDE', 'Outside', { parents: [] }) },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].deletions).toEqual([{ externalId: 'mv1', type: 'file' }]);
    expect(batches[0].items).toEqual([]);
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
  });

  it('folder change updates the in-memory index (no crash, no item) and later files use it', async () => {
    const { source, calls } = makeSource({
      changes: {
        'pt-1': {
          changes: [
            { fileId: 'SUB', file: folder('SUB', 'Sub', { parents: ['MYDRIVE'] }) },
            { fileId: 'docN', file: gdoc('docN', 'Nested', { parents: ['SUB'] }) },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      exportsMd: { docN: '# Nested' },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].items.map((i) => i.file.id)).toEqual(['docN']);
    expect(batches[0].items[0].displayPath).toBe('My Drive / Sub');
    // The folder came from the change feed — no shallow ancestor fetch needed.
    expect(calls.some((u) => u.includes('/files/SUB'))).toBe(false);
  });

  it('fetches unknown ancestors shallow on demand and caches them across files', async () => {
    const { source, calls } = makeSource({
      changes: {
        'pt-1': {
          changes: [
            { fileId: 'd1', file: gdoc('d1', 'One', { parents: ['P1'] }) },
            { fileId: 'd2', file: gdoc('d2', 'Two', { parents: ['P1'] }) },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      gets: { P1: folder('P1', 'Deep', { parents: ['MYDRIVE'] }) },
      exportsMd: { d1: '# 1', d2: '# 2' },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].items.map((i) => i.displayPath)).toEqual([
      'My Drive / Deep',
      'My Drive / Deep',
    ]);
    expect(calls.filter((u) => u.includes('/files/P1'))).toHaveLength(1);
  });

  it('one failing file is warn-skipped, the rest of the tick proceeds (v1 bug #3 regression)', async () => {
    const { source } = makeSource({
      changes: {
        'pt-1': {
          changes: [
            { fileId: 'bad1', file: pdf('bad1', 'bad.pdf') },
            { fileId: 'good1', file: gdoc('good1', 'Good') },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      media: { bad1: jsonRes(404, { error: { message: 'File not found' } }) },
      exportsMd: { good1: '# Good' },
    });
    const { session, logs } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches[0].items.map((i) => i.file.id)).toEqual(['good1']);
    expect(logs.some((l) => l.level === 'warn' && /file bad1 skipped/.test(l.msg))).toBe(true);
    expect(batches[0].cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
  });

  it('commits per page: crash between pages resumes at nextPageToken', async () => {
    const { source } = makeSource({
      changes: {
        'pt-1': {
          changes: [{ fileId: 'd1', file: gdoc('d1', 'One') }],
          nextPageToken: 'pt-2',
        },
        'pt-2': {
          changes: [{ fileId: 'd2', file: gdoc('d2', 'Two') }],
          newStartPageToken: 'nspt-9',
        },
      },
      exportsMd: { d1: '# 1', d2: '# 2' },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches).toHaveLength(2);
    expect(batches[0].cursor).toEqual({ page_token: 'pt-2', backfill_done: true });
    expect(batches[1].cursor).toEqual({ page_token: 'nspt-9', backfill_done: true });
  });

  it('dedupes a page by fileId keeping the LAST change', async () => {
    const query = fakeQuery([]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'd1', file: gdoc('d1', 'Old name') },
              { fileId: 'd1', removed: true },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
      },
      query,
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    // Only the removal is processed — no export attempted for the stale change.
    expect(batches[0].items).toEqual([]);
    expect(calls.some((u) => u.includes('/export'))).toBe(false);
  });

  it('invalid page token → recovery batch { page_token: "", backfill_done: false } and return', async () => {
    const { source } = makeSource({ changesInvalid: ['pt-bad'] });
    const { session, logs } = makeSession();

    const batches = (await collect(
      source.pull(session, { page_token: 'pt-bad', backfill_done: true }),
    )) as B[];

    expect(batches).toEqual([
      { phase: 'live', items: [], cursor: { page_token: '', backfill_done: false } },
    ]);
    expect(logs.some((l) => l.level === 'warn' && /page token rejected/.test(l.msg))).toBe(true);
  });

  it('does not misread a numeric page token as invalid during a 5xx outage (propagates)', async () => {
    // The token embeds "404"; the old whole-message regex would have turned
    // ANY non-auth failure into a full re-walk. The status is now anchored
    // on the typed error instead.
    const { source } = makeSource({
      custom: (url) =>
        url.pathname === '/drive/v3/changes'
          ? jsonRes(500, { error: { message: 'Backend Error' } })
          : undefined,
    });
    const { session } = makeSession();

    await expect(
      collect(source.pull(session, { page_token: 'pt-40404', backfill_done: true })),
    ).rejects.toThrow(/drive 500/);
  });

  it('auth 401 on changes.list propagates out of the generator', async () => {
    const { source } = makeSource({
      custom: (url) =>
        url.pathname === '/drive/v3/changes'
          ? jsonRes(401, { error: { message: 'Invalid Credentials' } })
          : undefined,
    });
    const { session } = makeSession();

    await expect(collect(source.pull(session, LIVE))).rejects.toThrow(GoogleDocsAuthError);
  });

  it('multi-root: a change under the SECOND root is in scope; a file under neither is archived', async () => {
    const query = fakeQuery([fakeDoc('nope1', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'b1', file: gdoc('b1', 'In B', { parents: ['FOLD2'] }) },
              { fileId: 'nope1', file: pdf('nope1', 'n.pdf', { parents: ['ELSEWHERE'] }) },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        gets: { ELSEWHERE: folder('ELSEWHERE', 'Elsewhere', { parents: [] }) },
        exportsMd: { b1: '# In B' },
      },
      query,
    );
    const { session } = makeSession({
      config: {
        roots: [
          { rootFolderId: 'FOLD1', rootName: 'Projects' },
          { rootFolderId: 'FOLD2', rootName: 'Specs' },
        ],
      },
    });

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    // No 'root' alias among the tracked roots → no files/root resolution.
    expect(calls.some((u) => u.includes('/files/root'))).toBe(false);
    expect(batches[0].items.map((i) => i.file.id)).toEqual(['b1']);
    // Attribution comes from the root actually reached.
    expect(batches[0].items[0]).toMatchObject({ displayPath: 'Specs', rootFolderId: 'FOLD2' });
    expect(batches[0].deletions).toEqual([{ externalId: 'nope1', type: 'file' }]);
  });

  it("multi-root: the 'root' alias is resolved ONCE and matched by its real id", async () => {
    const { source, calls } = makeSource({
      rootId: 'MYDRIVE',
      changes: {
        'pt-1': {
          changes: [
            { fileId: 'm1', file: gdoc('m1', 'In My Drive', { parents: ['MYDRIVE'] }) },
            { fileId: 'p1', file: gdoc('p1', 'In Projects', { parents: ['FOLD1'] }) },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      exportsMd: { m1: '# M', p1: '# P' },
    });
    const { session } = makeSession({
      config: {
        roots: [
          { rootFolderId: 'root', rootName: 'My Drive' },
          { rootFolderId: 'FOLD1', rootName: 'Projects' },
        ],
      },
    });

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(calls.filter((u) => u.includes('/files/root'))).toHaveLength(1);
    expect(batches[0].items.map((i) => i.rootFolderId).sort()).toEqual(['FOLD1', 'root']);
    expect(batches[0].items.map((i) => i.displayPath).sort()).toEqual(['My Drive', 'Projects']);
  });

  it('honors a configured root folder: no files/root call, scope matched against it', async () => {
    const query = fakeQuery([fakeDoc('out1', 'file', {})]);
    const { source, calls } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'in1', file: gdoc('in1', 'In', { parents: ['FOLD1'] }) },
              { fileId: 'out1', file: pdf('out1', 'out.pdf', { parents: ['MYDRIVE'] }) },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        gets: { MYDRIVE: folder('MYDRIVE', 'My Drive', { parents: [] }) },
        exportsMd: { in1: '# In' },
      },
      query,
    );
    const { session } = makeSession({
      config: { roots: [{ rootFolderId: 'FOLD1', rootName: 'Projects' }] },
    });

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(calls.some((u) => u.includes('/files/root'))).toBe(false);
    expect(batches[0].items.map((i) => i.file.id)).toEqual(['in1']);
    expect(batches[0].items[0].displayPath).toBe('Projects');
    // A file under My Drive but outside FOLD1 is out of scope → archived.
    expect(batches[0].deletions).toEqual([{ externalId: 'out1', type: 'file' }]);
  });
});
