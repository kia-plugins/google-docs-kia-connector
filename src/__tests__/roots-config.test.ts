/**
 * rootsConfig normalization: the multi-root shape, the My Drive default,
 * per-entry name fallbacks, and dedupe by rootFolderId.
 */
import { rootsConfig } from '../source';
import { makeSession } from '../testing/harness';

const roots = (config: Record<string, unknown>) =>
  rootsConfig(makeSession({ config }).session);

describe('rootsConfig', () => {
  it('returns the v2.1.0 roots array as-is', () => {
    expect(
      roots({
        roots: [
          { rootFolderId: 'FA', rootName: 'Alpha' },
          { rootFolderId: 'SH1', rootName: 'Shared specs' },
        ],
      }),
    ).toEqual([
      { rootFolderId: 'FA', rootName: 'Alpha' },
      { rootFolderId: 'SH1', rootName: 'Shared specs' },
    ]);
  });

  it("falls back per entry: 'My Drive' for id 'root', the id otherwise", () => {
    expect(
      roots({ roots: [{ rootFolderId: 'root' }, { rootFolderId: 'FA', rootName: '' }] }),
    ).toEqual([
      { rootFolderId: 'root', rootName: 'My Drive' },
      { rootFolderId: 'FA', rootName: 'FA' },
    ]);
  });

  it('skips invalid entries and keeps the valid ones', () => {
    expect(
      roots({
        roots: [{ rootFolderId: '' }, 42, null, { rootFolderId: 'FA', rootName: 'Alpha' }],
      }),
    ).toEqual([{ rootFolderId: 'FA', rootName: 'Alpha' }]);
  });

  it('an empty or all-invalid roots array falls through to the My Drive default', () => {
    expect(roots({ roots: [] })).toEqual([{ rootFolderId: 'root', rootName: 'My Drive' }]);
    expect(roots({ roots: [{ rootFolderId: 7 }] })).toEqual([
      { rootFolderId: 'root', rootName: 'My Drive' },
    ]);
  });

  it('defaults to My Drive with no config at all', () => {
    expect(roots({})).toEqual([{ rootFolderId: 'root', rootName: 'My Drive' }]);
  });

  it('dedupes by rootFolderId keeping the FIRST entry', () => {
    expect(
      roots({
        roots: [
          { rootFolderId: 'FA', rootName: 'First' },
          { rootFolderId: 'FB', rootName: 'Other' },
          { rootFolderId: 'FA', rootName: 'Second' },
        ],
      }),
    ).toEqual([
      { rootFolderId: 'FA', rootName: 'First' },
      { rootFolderId: 'FB', rootName: 'Other' },
    ]);
  });

  it('reads the canonical folderRoots shape', () => {
    expect(
      roots({
        folderRoots: [
          { id: 'FA', name: 'Alpha' },
          { id: 'SH1', name: 'Shared specs' },
        ],
      }),
    ).toEqual([
      { rootFolderId: 'FA', rootName: 'Alpha' },
      { rootFolderId: 'SH1', rootName: 'Shared specs' },
    ]);
  });

  it('prefers folderRoots over the legacy roots mirror when both are present', () => {
    // Core writes the mirror alongside the canonical set for one release
    // train (DECISIONS R1 + A-2) so a still-installed 2.1.6 keeps working.
    // This connector must never read the mirror while the canonical set is
    // usable — and never writes or strips it either.
    expect(
      roots({
        folderRoots: [{ id: 'FA', name: 'Alpha' }],
        roots: [{ rootFolderId: 'STALE', rootName: 'Stale' }],
      }),
    ).toEqual([{ rootFolderId: 'FA', rootName: 'Alpha' }]);
  });

  it('falls back to the legacy roots mirror when folderRoots is absent or unusable', () => {
    const legacy = { roots: [{ rootFolderId: 'FA', rootName: 'Alpha' }] };
    expect(roots(legacy)).toEqual([{ rootFolderId: 'FA', rootName: 'Alpha' }]);
    expect(roots({ folderRoots: [], ...legacy })).toEqual([
      { rootFolderId: 'FA', rootName: 'Alpha' },
    ]);
    expect(roots({ folderRoots: [{ id: 7 }], ...legacy })).toEqual([
      { rootFolderId: 'FA', rootName: 'Alpha' },
    ]);
  });

  it('folderRoots keeps the per-entry name fallback and the first-wins dedupe', () => {
    expect(
      roots({
        folderRoots: [
          { id: 'root' },
          { id: 'FA', name: '' },
          { id: 'FA', name: 'Second' },
        ],
      }),
    ).toEqual([
      { rootFolderId: 'root', rootName: 'My Drive' },
      { rootFolderId: 'FA', rootName: 'FA' },
    ]);
  });
});
