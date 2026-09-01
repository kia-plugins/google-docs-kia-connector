/**
 * Batch byte-budget suite: a Drive listing / changes page (pageSize 1000) is
 * flushed to the engine in sub-page chunks once the accumulated payload
 * (binary bytes + native-export markdown) or entry count crosses a budget,
 * instead of holding every file of the page in memory at once. Intermediate
 * chunks repeat the cursor that fetched the page; only the page's final chunk
 * advances it — a crash mid-page replays the page (idempotent via hash-skip)
 * and never skips its remainder.
 */
import {
  BATCH_BYTE_BUDGET,
  BATCH_ITEM_LIMIT,
  createGoogleDocsSource,
  MAX_BINARY_BYTES,
  type DriveCursor,
  type DriveItem,
} from '../source';
import type { Batch } from '@kiagent/connector-sdk';
import {
  collect,
  driveFetch,
  fakeDoc,
  fakeQuery,
  gdoc,
  instantClock,
  makeHost,
  makeSession,
  pdf,
} from '../testing/harness';

type B = Batch<DriveCursor, DriveItem>;
const ids = (b: B) => b.items.map((i) => i.file.id);
const LIVE = { page_token: 'pt-1', backfill_done: true };
const bytes = (n: number) => new Uint8Array(n).fill(7);

function makeSource(
  world: Parameters<typeof driveFetch>[0],
  seams: { batchByteBudget?: number; batchItemLimit?: number } = {},
  query = fakeQuery(),
) {
  const { fetchFn, calls } = driveFetch(world);
  const source = createGoogleDocsSource(makeHost(fetchFn, query), { ...instantClock, ...seams });
  return { source, calls, query };
}

describe('batch byte budget', () => {
  it('defaults: budget sits between one max-size file and a small multiple of it', () => {
    expect(BATCH_BYTE_BUDGET).toBeGreaterThanOrEqual(MAX_BINARY_BYTES);
    expect(BATCH_BYTE_BUDGET).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(BATCH_ITEM_LIMIT).toBeGreaterThan(0);
  });

  it('delta: flushes mid-page once binary bytes cross the budget; only the final chunk advances the token', async () => {
    const { source } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'a', file: pdf('a', 'a.pdf') },
              { fileId: 'b', file: pdf('b', 'b.pdf') },
              { fileId: 'c', file: pdf('c', 'c.pdf') },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        media: { a: bytes(3), b: bytes(3), c: bytes(3) },
      },
      { batchByteBudget: 5 },
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches.map(ids)).toEqual([['a', 'b'], ['c']]);
    expect(batches[0].cursor).toEqual({ page_token: 'pt-1', backfill_done: true });
    expect(batches[1].cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
  });

  it('delta: native-export markdown counts against the budget too', async () => {
    const { source } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'd1', file: gdoc('d1', 'One') },
              { fileId: 'd2', file: gdoc('d2', 'Two') },
              { fileId: 'd3', file: gdoc('d3', 'Three') },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        exportsMd: { d1: 'abc', d2: 'abc', d3: 'abc' },
      },
      { batchByteBudget: 5 },
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches.map(ids)).toEqual([['d1', 'd2'], ['d3']]);
    expect(batches[0].cursor).toEqual({ page_token: 'pt-1', backfill_done: true });
    expect(batches[1].cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
  });

  it('delta: a budget hit on the last item still advances the token via a trailing empty chunk', async () => {
    const { source } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'a', file: pdf('a', 'a.pdf') },
              { fileId: 'b', file: pdf('b', 'b.pdf') },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
        media: { a: bytes(3), b: bytes(3) },
      },
      { batchByteBudget: 5 },
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches.map(ids)).toEqual([['a', 'b'], []]);
    expect(batches[0].cursor).toEqual({ page_token: 'pt-1', backfill_done: true });
    expect(batches[1].cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
  });

  it('delta: the item limit flushes metadata-only items and deletions too; each deletion lands in exactly one chunk', async () => {
    const exe = { mimeType: 'application/x-msdownload' };
    const { source } = makeSource(
      {
        changes: {
          'pt-1': {
            changes: [
              { fileId: 'gone1', removed: true },
              { fileId: 'x1', file: pdf('x1', 'x1.exe', exe) },
              { fileId: 'x2', file: pdf('x2', 'x2.exe', exe) },
              { fileId: 'x3', file: pdf('x3', 'x3.exe', exe) },
              { fileId: 'gone2', removed: true },
            ],
            newStartPageToken: 'nspt-2',
          },
        },
      },
      { batchItemLimit: 2 },
      fakeQuery([fakeDoc('gone1', 'file', {}), fakeDoc('gone2', 'file', {})]),
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches.map((b) => [...(b.deletions ?? []).map((d) => d.externalId), ...ids(b)])).toEqual([
      ['gone1', 'x1'],
      ['x2', 'x3'],
      ['gone2'],
    ]);
    expect(batches.slice(0, -1).every((b) => b.cursor.page_token === 'pt-1')).toBe(true);
    expect(batches.at(-1)!.cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
  });

  it('backfill: a listing page splits into chunks under the same (stable) cursor, then the live flip', async () => {
    const { source } = makeSource(
      {
        startPageToken: 'spt-1',
        lists: { root: [pdf('a', 'a.pdf'), pdf('b', 'b.pdf'), pdf('c', 'c.pdf')] },
        media: { a: bytes(3), b: bytes(3), c: bytes(3) },
      },
      { batchByteBudget: 5 },
    );
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, null))) as B[];

    expect(batches.map(ids)).toEqual([['a', 'b'], ['c'], []]);
    expect(batches.map((b) => b.phase)).toEqual(['backfill', 'backfill', 'live']);
    expect(batches[0].cursor).toEqual({ page_token: 'spt-1', backfill_done: false });
    expect(batches[1].cursor).toEqual({ page_token: 'spt-1', backfill_done: false });
    expect(batches[2].cursor).toEqual({ page_token: 'spt-1', backfill_done: true });
  });

  it('never splits a page when the budget is not reached (unchanged one-batch-per-page behaviour)', async () => {
    const { source } = makeSource({
      changes: {
        'pt-1': {
          changes: [
            { fileId: 'a', file: pdf('a', 'a.pdf') },
            { fileId: 'b', file: pdf('b', 'b.pdf') },
          ],
          newStartPageToken: 'nspt-2',
        },
      },
      media: { a: bytes(3), b: bytes(3) },
    });
    const { session } = makeSession();

    const batches = (await collect(source.pull(session, LIVE))) as B[];

    expect(batches.map(ids)).toEqual([['a', 'b']]);
    expect(batches[0].cursor).toEqual({ page_token: 'nspt-2', backfill_done: true });
  });
});
