/**
 * Folder-picker callback suite: shared-with-me root listing (pagination +
 * silent 1000-folder stop), child-folder listing (folders only, id escaping),
 * and the budgeted recursive file count (budget/CAP exhaustion → capped,
 * shortcut counted as file, API error → null).
 */
import { countFilesUnder, listChildFolders, listSharedRoots } from '../source';
import { DriveClient } from '../client';
import type { NetFetch } from '../client';
import {
  binaryFile,
  driveFetch,
  folder,
  gdoc,
  instantClock,
  jsonRes,
  pdf,
  shortcut,
} from '../testing/harness';

const makeClient = (fetchFn: NetFetch) =>
  new DriveClient({
    fetch: fetchFn,
    getToken: async () => 'ya29.test-deadbeef',
    ...instantClock,
  });

const FOLDER_MIME = 'application/vnd.google-apps.folder';

describe('listSharedRoots', () => {
  it('lists shared-with-me folders across pages as hasChildren:true nodes', async () => {
    const { fetchFn, calls } = driveFetch({
      sharedRoots: [
        [folder('SH1', 'Alpha'), folder('SH2', 'Beta')],
        [folder('SH3', 'Gamma')],
      ],
    });

    const nodes = await listSharedRoots(makeClient(fetchFn));

    expect(nodes).toEqual([
      { id: 'SH1', name: 'Alpha', hasChildren: true },
      { id: 'SH2', name: 'Beta', hasChildren: true },
      { id: 'SH3', name: 'Gamma', hasChildren: true },
    ]);
    expect(calls).toHaveLength(2);
    const u = new URL(calls[0]);
    expect(u.searchParams.get('q')).toBe(
      `sharedWithMe = true and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    expect(u.searchParams.get('orderBy')).toBe('name');
    expect(u.searchParams.get('pageSize')).toBe('200');
    expect(u.searchParams.get('fields')).toBe('files(id,name),nextPageToken');
  });

  it('stops silently at 1000 folders and does not fetch further pages', async () => {
    const page = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => folder(`SH${start + i}`, `F ${start + i}`));
    const { fetchFn, calls } = driveFetch({
      sharedRoots: [page(0, 600), page(600, 500), page(1100, 100)],
    });

    const nodes = await listSharedRoots(makeClient(fetchFn));

    expect(nodes).toHaveLength(1000);
    expect(nodes[999].id).toBe('SH999');
    // Hit the cap mid-page 2 — page 3 is never requested.
    expect(calls).toHaveLength(2);
  });
});

describe('listChildFolders', () => {
  it('lists only child FOLDERS of the given id, hasChildren always true', async () => {
    const { fetchFn, calls } = driveFetch({
      lists: {
        F1: [folder('C1', 'Sub A', { parents: ['F1'] }), gdoc('d1', 'Doc'), pdf('p1', 'a.pdf')],
      },
    });

    const nodes = await listChildFolders(makeClient(fetchFn), 'F1');

    expect(nodes).toEqual([{ id: 'C1', name: 'Sub A', hasChildren: true }]);
    const u = new URL(calls[0]);
    expect(u.searchParams.get('q')).toBe(
      `'F1' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
  });

  it("escapes single quotes in the folder id (defense-in-depth: ids are [A-Za-z0-9_-])", async () => {
    const { fetchFn, calls } = driveFetch({ lists: { "a\\'b": [] } });

    const nodes = await listChildFolders(makeClient(fetchFn), "a'b");

    expect(nodes).toEqual([]);
    const u = new URL(calls[0]);
    expect(u.searchParams.get('q')).toBe(
      `'a\\'b' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
  });
});

describe('countFilesUnder', () => {
  it('counts eligible files in a flat folder, excluding policy-ignored ones (capped: false)', async () => {
    const { fetchFn, calls } = driveFetch({
      lists: {
        F1: [
          pdf('p1', 'a.pdf'),
          pdf('p2', 'b.pdf'),
          gdoc('d1', 'Doc'),
          binaryFile('mp3-1', 'song.mp3', 'audio/mpeg'),
          binaryFile('zip-1', 'archive.zip', 'application/zip'),
        ],
      },
    });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 3, capped: false });
    const u = new URL(calls[0]);
    expect(u.searchParams.get('q')).toBe("'F1' in parents and trashed = false");
    expect(u.searchParams.get('fields')).toBe(
      'files(id,mimeType,name,size,shortcutDetails(targetMimeType)),nextPageToken',
    );
    expect(u.searchParams.get('pageSize')).toBe('1000');
  });

  it('recurses into nested folders (BFS) and sums files', async () => {
    const { fetchFn } = driveFetch({
      lists: {
        F1: [folder('S1', 'Sub'), pdf('p1', 'a.pdf'), gdoc('d1', 'Doc')],
        S1: [folder('S2', 'Deeper'), pdf('p2', 'b.pdf')],
        S2: [gdoc('d2', 'Deep doc')],
      },
    });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 4, capped: false });
  });

  it('counts a shortcut whose target is eligible, without resolving the target (estimate)', async () => {
    const { fetchFn, calls } = driveFetch({
      lists: {
        F1: [shortcut('sc1', 'Link', 'TD1', 'application/pdf'), gdoc('d1', 'Doc')],
      },
    });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 2, capped: false });
    expect(calls.some((u) => u.includes('TD1'))).toBe(false);
  });

  it('does not count a shortcut whose target is ineligible (e.g. audio) — target mime decides, no fetch', async () => {
    const { fetchFn, calls } = driveFetch({
      lists: {
        F1: [shortcut('sc1', 'Song link', 'TD1', 'audio/mpeg'), gdoc('d1', 'Doc')],
      },
    });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 1, capped: false });
    expect(calls.some((u) => u.includes('TD1'))).toBe(false);
  });

  it('stops when the 20-page request budget runs out mid-walk → capped, lower bound', async () => {
    // 21 pages of one file each: the 21st page would exceed the budget.
    const pages = Array.from({ length: 21 }, (_, i) => [pdf(`p${i}`, `f${i}.pdf`)]);
    const { fetchFn, calls } = driveFetch({ lists: { F1: pages } });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 20, capped: true });
    expect(calls).toHaveLength(20);
  });

  it('a walk that finishes on exactly the last budgeted page is NOT capped', async () => {
    const pages = Array.from({ length: 20 }, (_, i) => [pdf(`p${i}`, `f${i}.pdf`)]);
    const { fetchFn, calls } = driveFetch({ lists: { F1: pages } });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 20, capped: false });
    expect(calls).toHaveLength(20);
  });

  it('stops at the 50k file CAP → capped', async () => {
    const many = Array.from({ length: 50_001 }, (_, i) => ({
      id: `f${i}`,
      name: `f${i}`,
      mimeType: 'text/plain',
    }));
    const { fetchFn } = driveFetch({ lists: { F1: many } });

    const res = await countFilesUnder(makeClient(fetchFn), 'F1');

    expect(res).toEqual({ count: 50_000, capped: true });
  });

  it('resolves null on a Drive API error instead of rejecting', async () => {
    const { fetchFn } = driveFetch({
      custom: (url) =>
        url.pathname === '/drive/v3/files'
          ? jsonRes(404, { error: { message: 'File not found: F1' } })
          : undefined,
    });

    await expect(countFilesUnder(makeClient(fetchFn), 'F1')).resolves.toBeNull();
  });
});
