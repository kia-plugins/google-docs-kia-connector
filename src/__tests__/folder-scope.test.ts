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
