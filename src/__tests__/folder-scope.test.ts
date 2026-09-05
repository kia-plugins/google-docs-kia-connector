/**
 * Folder-scope suite: the scope_roots cursor field on EVERY write site,
 * pull()'s order-independent set-equality mismatch check, manageFolders
 * (covering-set collapse, 'root' catch-all, R8 archive set, A-3 NULL
 * repair, cursor transform), invariant 15, and reauthenticate (identity
 * verification, no picker).
 */
import { createGoogleDocsSource, DRIVE_SCOPES, type DriveCursor, type DriveItem } from '../source';
import type { Batch, FolderNode } from '@kiagent/connector-sdk';
import {
  binaryFile,
  collect,
  driveFetch,
  fakeAccount,
  folder,
  gdoc,
  instantClock,
  jsonRes,
  makeAuth,
  makeFolderChannel,
  makeHost,
  makeSession,
} from '../testing/harness';

type B = Batch<DriveCursor, DriveItem>;

const ALPHA = { folderRoots: [{ id: 'FA', name: 'Alpha' }] };

/**
 * pull() gates the phase on set-equality between `cursor.scope_roots` and the
 * configured roots, so ONE un-stamped cursor write makes the next tick
 * mismatch and re-walk — forever, which surfaces as "the connector never
 * finishes syncing". `withScopeRoots` funnels every yield, and these three
 * runs drive all six sites in src/source.ts:
 *   :703 backfill budget flush · :708 backfill end-of-page · :726 live flip
 *   :845 invalid-token recovery · :896 delta budget flush · :906 page advance
 */
describe('scope_roots rides every cursor write site', () => {
  it('backfill: the budget flush (:703), the end-of-page chunk (:708) and the live flip (:726)', async () => {
    const { fetchFn } = driveFetch({
      startPageToken: 'spt-1',
      lists: {
        FA: [gdoc('a1', 'A one', { parents: ['FA'] }), gdoc('a2', 'A two', { parents: ['FA'] })],
      },
      exportsMd: { a1: '# A1', a2: '# A2' },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), {
      ...instantClock,
      batchItemLimit: 1,
    });
    const { session } = makeSession({ config: ALPHA });

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches.map((b) => b.phase)).toEqual(['backfill', 'backfill', 'backfill', 'live']);
    expect(batches.map((b) => b.cursor)).toEqual([
      { page_token: 'spt-1', backfill_done: false, scope_roots: ['FA'] },
      { page_token: 'spt-1', backfill_done: false, scope_roots: ['FA'] },
      { page_token: 'spt-1', backfill_done: false, scope_roots: ['FA'] },
      { page_token: 'spt-1', backfill_done: true, scope_roots: ['FA'] },
    ]);
  });

  it('delta: the budget flush (:896) and the page-advance chunk (:906)', async () => {
    const { fetchFn, calls } = driveFetch({
      changes: {
        'pt-1': {
          changes: [
            { fileId: 'a1', file: gdoc('a1', 'A one', { parents: ['FA'] }) },
            { fileId: 'a2', file: gdoc('a2', 'A two', { parents: ['FA'] }) },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      exportsMd: { a1: '# A1', a2: '# A2' },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), {
      ...instantClock,
      batchItemLimit: 1,
    });
    const { session } = makeSession({ config: ALPHA });

    const batches = (await collect(
      source.pull(session, { page_token: 'pt-1', backfill_done: true, scope_roots: ['FA'] }),
    )) as B[];

    // No 'root' alias among the roots → no files/root resolution.
    expect(calls.some((u) => u.includes('/files/root'))).toBe(false);
    expect(batches.map((b) => b.cursor)).toEqual([
      { page_token: 'pt-1', backfill_done: true, scope_roots: ['FA'] },
      { page_token: 'pt-1', backfill_done: true, scope_roots: ['FA'] },
      { page_token: 'nspt-2', backfill_done: true, scope_roots: ['FA'] },
    ]);
  });

  it('delta: the invalid-token recovery cursor (:845)', async () => {
    const { fetchFn } = driveFetch({ changesInvalid: ['pt-bad'] });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({ config: ALPHA });

    const batches = (await collect(
      source.pull(session, { page_token: 'pt-bad', backfill_done: true, scope_roots: ['FA'] }),
    )) as B[];

    expect(batches).toEqual([
      {
        phase: 'live',
        items: [],
        cursor: { page_token: '', backfill_done: false, scope_roots: ['FA'] },
      },
    ]);
  });
});

describe('pull() scope_roots mismatch check', () => {
  const TWO = {
    folderRoots: [
      { id: 'FA', name: 'Alpha' },
      { id: 'FB', name: 'Beta' },
    ],
  };
  const world = {
    startPageToken: 'spt-new',
    lists: { FA: [], FB: [] },
    changes: { 'pt-1': { changes: [], newStartPageToken: 'nspt-2' } },
  };

  it('a REORDERED root list is the same set — delta, no re-walk', async () => {
    const { fetchFn, calls } = driveFetch(world);
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({ config: TWO });

    const batches = (await collect(
      source.pull(session, { page_token: 'pt-1', backfill_done: true, scope_roots: ['FB', 'FA'] }),
    )) as B[];

    expect(batches.map((b) => b.phase)).toEqual(['live']);
    expect(calls.some((u) => u.includes('startPageToken'))).toBe(false);
  });

  it('a root added under a live cursor re-walks and PRESERVES the page token', async () => {
    const { fetchFn, calls } = driveFetch(world);
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({ config: TWO });

    const batches = (await collect(
      source.pull(session, { page_token: 'pt-1', backfill_done: true, scope_roots: ['FA'] }),
    )) as B[];

    expect(batches.map((b) => b.phase)).toEqual(['backfill', 'backfill', 'live']);
    // The saved token is a superset of what the walk could miss — never recaptured.
    expect(calls.some((u) => u.includes('startPageToken'))).toBe(false);
    expect(batches.at(-1)!.cursor).toEqual({
      page_token: 'pt-1',
      backfill_done: true,
      scope_roots: ['FA', 'FB'],
    });
  });

  it('an ABSENT scope_roots backfills EXACTLY ONCE, then matches forever', async () => {
    // This is the shape core's v3 migration leaves behind: Account.cursor is
    // opaque to core, so it is left untouched (A3 option (i)). One safe
    // full current-root backfill per cloud account. That is intended.
    const first = driveFetch(world);
    const sourceA = createGoogleDocsSource(makeHost(first.fetchFn), instantClock);
    const { session } = makeSession({ config: TWO });

    // scope_roots is OPTIONAL on DriveCursor, so this is the literal legacy
    // shape — no cast needed.
    const one = (await collect(
      sourceA.pull(session, { page_token: 'pt-1', backfill_done: true }),
    )) as B[];

    expect(one.map((b) => b.phase)).toEqual(['backfill', 'backfill', 'live']);
    expect(first.calls.some((u) => u.includes('startPageToken'))).toBe(false);
    const carried = one.at(-1)!.cursor;
    expect(carried).toEqual({
      page_token: 'pt-1',
      backfill_done: true,
      scope_roots: ['FA', 'FB'],
    });

    // Feeding that cursor straight back takes the DELTA branch — proof the
    // absent field costs one backfill, not one per tick.
    const second = driveFetch(world);
    const sourceB = createGoogleDocsSource(makeHost(second.fetchFn), instantClock);
    const two = (await collect(sourceB.pull(session, carried))) as B[];

    expect(two.map((b) => b.phase)).toEqual(['live']);
    expect(second.calls.some((u) => u.includes('startPageToken'))).toBe(false);
  });
});

describe('manageFolders', () => {
  const world = {
    rootId: 'MYDRIVE',
    gets: {
      FOLD1: folder('FOLD1', 'Projects', { parents: ['MYDRIVE'] }),
      FOLD2: folder('FOLD2', 'Specs', { parents: ['MYDRIVE'] }),
      // Needed so a walk that does NOT hit a selected root terminates on
      // `parents[0] === undefined` instead of on an unhandled-fixture throw
      // that costs a full retry ladder and pins the wrong code path.
      MYDRIVE: folder('MYDRIVE', 'My Drive', { parents: [] }),
    },
  };

  it('opens the picker with purpose:manage and the CURRENT roots preselected', async () => {
    const { fetchFn } = driveFetch(world);
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({
      config: { folderRoots: [{ id: 'FOLD1', name: 'Projects' }] },
    });
    const { channel, getPickerSpec } = makeFolderChannel({
      picked: [{ id: 'FOLD1', name: 'Projects', hasChildren: true }],
    });

    await source.manageFolders!(session, channel);

    const spec = getPickerSpec()!;
    expect(spec.purpose).toBe('manage');
    expect(spec.multiSelect).toBe(true);
    expect(spec.selected).toEqual([{ id: 'FOLD1', name: 'Projects', hasChildren: true }]);
    expect(spec.modes).toEqual([
      { key: 'my-drive', label: 'My Drive' },
      { key: 'shared', label: 'Shared with me' },
    ]);
  });

  it("retaining the 'root' catch-all archives NOTHING — the Save-path half of R6's 314-of-316 fix", async () => {
    // DECISIONS R6 + R8's Drive rule. My Drive is a genuine ancestor of its
    // whole subtree, so 'root' covers FOLD1: the covering set collapses to
    // ['root'] AND the archive set is [] — even though FOLD1 was "removed"
    // from folderRoots. Core set-differencing here would archive every live
    // row (314 of 316 on the real production account, all of them frozen at
    // historical folder ids by hashSkip). The alias must also be resolved to
    // the REAL My Drive id before any walk: every descendant's parent chain
    // ends at MYDRIVE, never at the literal string 'root'.
    const { fetchFn, calls } = driveFetch(world);
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({
      config: { folderRoots: [{ id: 'FOLD1', name: 'Projects' }] },
      cursor: { page_token: 'pt-keep', backfill_done: true, scope_roots: ['FOLD1'] },
    });
    const { channel } = makeFolderChannel({
      picked: [
        { id: 'root', name: 'My Drive', hasChildren: true },
        { id: 'FOLD1', name: 'Projects', hasChildren: true },
      ],
    });

    const update = await source.manageFolders!(session, channel);

    expect(update.config).toEqual({ folderRoots: [{ id: 'root', name: 'My Drive' }] });
    expect(update.archiveScopeRootIds).toEqual([]);
    expect(update.archiveNullScoped).toBe(true);
    expect(update.cursor).toEqual({
      page_token: 'pt-keep',
      backfill_done: false,
      scope_roots: ['root'],
    });
    expect(calls.filter((u) => u.includes('/files/root'))).toHaveLength(1);
  });

  it('narrowing with NO catch-all retained archives exactly the removed root (R8)', async () => {
    const { fetchFn } = driveFetch(world);
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({
      config: {
        folderRoots: [
          { id: 'FOLD1', name: 'Projects' },
          { id: 'FOLD2', name: 'Specs' },
        ],
      },
      cursor: { page_token: 'pt-keep', backfill_done: true, scope_roots: ['FOLD1', 'FOLD2'] },
    });
    const { channel } = makeFolderChannel({
      picked: [{ id: 'FOLD1', name: 'Projects', hasChildren: true }],
    });

    const update = await source.manageFolders!(session, channel);

    // An explicit IN-list for core: archive FOLD2's rows, nothing else.
    expect(update.archiveScopeRootIds).toEqual(['FOLD2']);
    expect(update.archiveNullScoped).toBe(true);
    expect(update.cursor).toEqual({
      page_token: 'pt-keep',
      backfill_done: false,
      scope_roots: ['FOLD1'],
    });
  });

  it('an unchanged set archives nothing, leaves backfill_done alone, and is SILENT about the legacy mirror (A-2)', async () => {
    const { fetchFn } = driveFetch(world);
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({
      config: {
        folderRoots: [{ id: 'FOLD1', name: 'Projects' }],
        roots: [{ rootFolderId: 'FOLD1', rootName: 'Projects' }],
        watch: true,
      },
      cursor: { page_token: 'pt-keep', backfill_done: true, scope_roots: ['FOLD1'] },
    });
    const { channel } = makeFolderChannel({
      picked: [{ id: 'FOLD1', name: 'Projects', hasChildren: true }],
    });

    const update = await source.manageFolders!(session, channel);

    // Every stored key rides through. The legacy `roots` mirror is neither
    // written nor stripped here (DECISIONS A-2: core owns it, and
    // applyFolderScope re-derives it from folderRoots in the SAME
    // transaction). A connector that deleted it would end R1's
    // compatibility train on the first Save for a still-installed 2.1.6.
    expect(update.config).toEqual({
      watch: true,
      roots: [{ rootFolderId: 'FOLD1', rootName: 'Projects' }],
      folderRoots: [{ id: 'FOLD1', name: 'Projects' }],
    });
    expect(update.archiveScopeRootIds).toEqual([]);
    expect(update.archiveNullScoped).toBe(false);
    expect(update.cursor).toEqual({
      page_token: 'pt-keep',
      backfill_done: true,
      scope_roots: ['FOLD1'],
    });
  });

  it('archiveNullScoped is true ONLY together with a forced re-establish (A-3)', async () => {
    const prior: DriveCursor = {
      page_token: 'pt-keep',
      backfill_done: true,
      scope_roots: ['FOLD1'],
    };
    const cases: { name: string; picked: FolderNode[] }[] = [
      { name: 'unchanged', picked: [{ id: 'FOLD1', name: 'Projects', hasChildren: true }] },
      { name: 'widened to the catch-all', picked: [{ id: 'root', name: 'My Drive', hasChildren: true }] },
      { name: 'swapped to a sibling', picked: [{ id: 'FOLD2', name: 'Specs', hasChildren: true }] },
    ];

    for (const c of cases) {
      const { fetchFn } = driveFetch(world);
      const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
      const { session } = makeSession({
        config: { folderRoots: [{ id: 'FOLD1', name: 'Projects' }] },
        cursor: prior,
      });
      const { channel } = makeFolderChannel({ picked: c.picked });

      const update = await source.manageFolders!(session, channel);

      if (update.archiveNullScoped) {
        // Archiving NULL-scoped rows is only safe when the SAME update
        // re-walks: contentHash excludes scope and this connector hashSkips,
        // so nothing else would ever re-emit them. The re-walk un-archives
        // them through hashSkip's archived-row exception (source.ts:476),
        // and the page token is never recaptured mid-backfill.
        expect(update.cursor!.backfill_done).toBe(false);
        expect(update.cursor!.page_token).toBe(prior.page_token);
      } else {
        expect(update.cursor!.backfill_done).toBe(true);
      }
    }
  });

  it('rejects an empty selection and names an unreadable selected folder', async () => {
    const { fetchFn } = driveFetch({
      rootId: 'MYDRIVE',
      gets: { GONE: jsonRes(404, { error: { message: 'File not found: GONE.' } }) },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({ config: { folderRoots: [{ id: 'FOLD1', name: 'P' }] } });

    const empty = makeFolderChannel({ picked: [] });
    await expect(source.manageFolders!(session, empty.channel)).rejects.toThrow(
      /no folders selected/,
    );

    const gone = makeFolderChannel({
      picked: [{ id: 'GONE', name: 'Deleted plans', hasChildren: true }],
    });
    await expect(source.manageFolders!(session, gone.channel)).rejects.toThrow(
      /folder "Deleted plans" is no longer readable/,
    );
  });
});

describe('invariant 15 — a newly added root never overrides file-indexability policy', () => {
  it('walks the added root under the forced re-establish and STILL ignores media there', async () => {
    // The hand-off is the risk, not the policy: manageFolders widens scope,
    // core persists config+cursor, and the very next pull() walks a folder
    // this account has never seen. Strict indexing must stay exactly where
    // it was — chooseRoute runs before any byte fetch, the mp3 produces no
    // item, and the aggregate policy log still names reasons only.
    const { fetchFn, calls } = driveFetch({
      rootId: 'MYDRIVE',
      gets: {
        FA: folder('FA', 'Alpha', { parents: ['MYDRIVE'] }),
        FB: folder('FB', 'Beta', { parents: ['MYDRIVE'] }),
        MYDRIVE: folder('MYDRIVE', 'My Drive', { parents: [] }),
      },
      lists: {
        FA: [],
        FB: [
          binaryFile('mp3-1', 'song.mp3', 'audio/mpeg'),
          gdoc('b1', 'B doc', { parents: ['FB'] }),
        ],
      },
      exportsMd: { b1: '# B' },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { session } = makeSession({
      config: { folderRoots: [{ id: 'FA', name: 'Alpha' }] },
      cursor: { page_token: 'pt-1', backfill_done: true, scope_roots: ['FA'] },
    });
    const { channel } = makeFolderChannel({
      picked: [
        { id: 'FA', name: 'Alpha', hasChildren: true },
        { id: 'FB', name: 'Beta', hasChildren: true },
      ],
    });

    const update = await source.manageFolders!(session, channel);
    expect(update.cursor).toEqual({
      page_token: 'pt-1',
      backfill_done: false,
      scope_roots: ['FA', 'FB'],
    });

    // Replay what core would have persisted, as the next pull's input.
    const { session: next, logs } = makeSession({ config: update.config });
    const batches = (await collect(source.pull(next, update.cursor))) as B[];

    // FB IS walked — that is the point of the forced re-establish…
    expect(batches.flatMap((b) => b.items).map((i) => i.file.id)).toEqual(['b1']);
    // …and the mp3 under it is still policy-ignored, with zero byte fetch.
    expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
    const summary = logs.find((l) => /ignored \d+ file\(s\) by policy/.test(l.msg));
    expect(summary!.msg).toMatch(/cloud-media=1/);
    expect(logs.some((l) => l.msg.includes('song.mp3'))).toBe(false);
    // The preserved page_token means no fresh startPageToken capture.
    expect(calls.some((u) => u.includes('startPageToken'))).toBe(false);
  });
});

describe('reauthenticate', () => {
  it('verifies the returned identity (trimmed, case-insensitive) and never opens the picker', async () => {
    const { fetchFn, calls } = driveFetch({
      about: { emailAddress: '  ED@Example.com ', displayName: 'Ed' },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth, statuses, getScopes, getPickerSpec } = makeAuth();

    await expect(
      source.reauthenticate!(fakeAccount({ identifier: 'ed@example.com' }), auth),
    ).resolves.toBeUndefined();

    expect(getScopes()).toEqual(DRIVE_SCOPES);
    expect(statuses).toEqual(['Waiting for Google sign-in…', 'Verifying the Google account…']);
    // Reconnect never changes scope: no picker, and only the about call.
    expect(getPickerSpec()).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/drive/v3/about');
  });

  it('rejects a different identity and names both, with no token in the message', async () => {
    const { fetchFn } = driveFetch({ about: { emailAddress: 'someone@else.com' } });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth();

    await expect(
      source.reauthenticate!(fakeAccount({ identifier: 'ed@example.com' }), auth),
    ).rejects.toThrow(
      /signed in as someone@else\.com, but this account is ed@example\.com/,
    );
  });

  it('throws when oauth returns no accessToken, before any fetch', async () => {
    const { fetchFn, calls } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ creds: { refreshToken: '1//fake-refresh-test' } });

    await expect(source.reauthenticate!(fakeAccount(), auth)).rejects.toThrow(
      /no access token/,
    );
    expect(calls).toHaveLength(0);
  });
});
