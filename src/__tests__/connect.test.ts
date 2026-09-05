/**
 * connect(auth) suite: platform-owned OAuth (auth.oauth with the
 * drive.readonly scope), Drive profile fetch, and the shared folder-picker
 * (auth.pickFolders) — multi-root selection, spec wiring, empty selection,
 * and cancel propagation.
 */
import { createGoogleDocsSource, DRIVE_SCOPES } from '../source';
import {
  driveFetch,
  folder,
  instantClock,
  makeAuth,
  makeHost,
} from '../testing/harness';

describe('connect', () => {
  it('oauth happy path: scope, statuses, identifier = email, picked folders → roots config', async () => {
    const { fetchFn, calls } = driveFetch({
      about: { emailAddress: 'ed@example.com', displayName: 'Ed' },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth, statuses, getScopes } = makeAuth({
      picked: [
        { id: 'FOLD1', name: 'Projects', hasChildren: true },
        { id: 'SH1', name: 'Shared specs', hasChildren: true },
      ],
    });

    const res = await source.connect(auth);

    expect(getScopes()).toEqual(DRIVE_SCOPES);
    expect(statuses).toEqual(['Waiting for Google sign-in…', 'Fetching Drive profile…']);
    expect(res).toEqual({
      identifier: 'ed@example.com',
      config: {
        folderRoots: [
          { id: 'FOLD1', name: 'Projects' },
          { id: 'SH1', name: 'Shared specs' },
        ],
      },
    });
    // Only the about call — the fake picker resolves without invoking the
    // lazy spec callbacks, and connect() itself does no folder lookups.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/drive/v3/about');
  });

  it('passes the pinned picker spec: My Drive + Shared tabs, multiSelect', async () => {
    const { fetchFn } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth, getPickerSpec } = makeAuth();

    await source.connect(auth);

    const spec = getPickerSpec()!;
    expect(spec.modes).toEqual([
      { key: 'my-drive', label: 'My Drive' },
      { key: 'shared', label: 'Shared with me' },
    ]);
    expect(spec.multiSelect).toBe(true);
    // A new connection: nothing preselected, connect copy.
    expect(spec.purpose).toBe('connect');
    expect(spec.selected).toEqual([]);
  });

  it("spec.roots('my-drive') is the static My Drive node — no API call", async () => {
    const { fetchFn, calls } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth, getPickerSpec } = makeAuth();
    await source.connect(auth);
    const before = calls.length;

    await expect(getPickerSpec()!.roots('my-drive')).resolves.toEqual([
      { id: 'root', name: 'My Drive', hasChildren: true },
    ]);
    expect(calls).toHaveLength(before);
  });

  it("spec.roots('shared') / children / count run against Drive with the connect token", async () => {
    const { fetchFn } = driveFetch({
      sharedRoots: [folder('SH1', 'Shared specs')],
      lists: {
        SH1: [folder('SUB1', 'Sub', { parents: ['SH1'] }), { id: 'f1', name: 'a.txt', mimeType: 'text/plain' }],
        SUB1: [{ id: 'f2', name: 'b.txt', mimeType: 'text/plain' }],
      },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth, getPickerSpec } = makeAuth();
    await source.connect(auth);
    const spec = getPickerSpec()!;

    await expect(spec.roots('shared')).resolves.toEqual([
      { id: 'SH1', name: 'Shared specs', hasChildren: true },
    ]);
    await expect(spec.children('SH1')).resolves.toEqual([
      { id: 'SUB1', name: 'Sub', hasChildren: true },
    ]);
    await expect(spec.count!('SH1')).resolves.toEqual({ count: 2, capped: false });
  });

  it('throws when the user confirms an empty selection', async () => {
    const { fetchFn } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ picked: [] });

    await expect(source.connect(auth)).rejects.toThrow(/no folders selected/);
  });

  it('propagates a pickFolders rejection (user cancelled) out of connect', async () => {
    const { fetchFn } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({
      picked: async () => {
        throw new Error('picker cancelled');
      },
    });

    await expect(source.connect(auth)).rejects.toThrow(/picker cancelled/);
  });

  it('throws when oauth returns no accessToken, before any fetch', async () => {
    const { fetchFn, calls } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ creds: { refreshToken: '1//fake-refresh-test' } });
    await expect(source.connect(auth)).rejects.toThrow(/no access token/);
    expect(calls).toHaveLength(0);
  });

  it('declares the folder-scope capability', () => {
    const { fetchFn } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    expect(source.descriptor.folderScope).toBe(true);
    // A descriptor with the flag MUST implement manageFolders.
    expect(typeof source.manageFolders).toBe('function');
    expect(typeof source.reauthenticate).toBe('function');
  });
});

