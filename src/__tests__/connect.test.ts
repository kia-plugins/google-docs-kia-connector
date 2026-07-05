/**
 * connect(auth) suite: platform-owned OAuth (auth.oauth with the
 * drive.readonly scope), Drive profile fetch, and the one optional
 * root-folder prompt with its URL/ID parsing and validation.
 */
import { createGoogleDocsSource, DRIVE_SCOPES, parseRootInput } from '../source';
import {
  driveFetch,
  instantClock,
  jsonRes,
  makeAuth,
  makeHost,
} from '../testing/harness';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

describe('parseRootInput', () => {
  it.each([
    ['', 'root'],
    ['   ', 'root'],
    ['https://drive.google.com/drive/folders/FOLD_a-1?usp=sharing', 'FOLD_a-1'],
    ['https://drive.google.com/drive/u/0/folders/FOLD2', 'FOLD2'],
    ['https://drive.google.com/open?id=FOLD3&usp=drive', 'FOLD3'],
    ['FOLDraw', 'FOLDraw'],
    ['  FOLDraw  ', 'FOLDraw'],
  ])('%j → %s', (input, expected) => {
    expect(parseRootInput(input)).toBe(expected);
  });
});

describe('connect', () => {
  it('oauth happy path: scope, statuses, identifier = email, blank root → My Drive', async () => {
    const { fetchFn, calls } = driveFetch({
      about: { emailAddress: 'ed@example.com', displayName: 'Ed' },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth, statuses, getScopes, getSchema } = makeAuth({ answers: { root: '  ' } });

    const res = await source.connect(auth);

    expect(getScopes()).toEqual(DRIVE_SCOPES);
    expect(statuses).toEqual(['Waiting for Google sign-in…', 'Fetching Drive profile…']);
    expect(res).toEqual({
      identifier: 'ed@example.com',
      config: { rootFolderId: 'root', rootName: 'My Drive' },
    });
    // Blank root: only the about call — no folder validation fetch.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/drive/v3/about');

    // Prompt schema: ONE optional text field keyed `root` — and NO password
    // field (nothing rides the prompt vault here).
    const schema = getSchema() as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(['root']);
    expect(schema.required ?? []).toEqual([]);
  });

  it('throws when oauth returns no accessToken, before any fetch', async () => {
    const { fetchFn, calls } = driveFetch({});
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ creds: { refreshToken: '1//fake-refresh-test' } });
    await expect(source.connect(auth)).rejects.toThrow(/no access token/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['https://drive.google.com/drive/folders/FOLD1?usp=sharing', 'FOLD1'],
    ['https://drive.google.com/open?id=FOLD1', 'FOLD1'],
    ['FOLD1', 'FOLD1'],
  ])('parses %s, validates the folder, and records its name', async (input, id) => {
    const { fetchFn } = driveFetch({
      gets: { [id]: { id, name: 'Projects', mimeType: FOLDER_MIME } },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ answers: { root: input } });
    const res = await source.connect(auth);
    expect(res.config).toEqual({ rootFolderId: id, rootName: 'Projects' });
  });

  it('rejects an id Drive cannot open with a clear message', async () => {
    const { fetchFn } = driveFetch({
      gets: { NOPE: jsonRes(404, { error: { message: 'File not found: NOPE' } }) },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ answers: { root: 'NOPE' } });
    await expect(source.connect(auth)).rejects.toThrow(
      /could not open folder "NOPE".*check the URL or ID/,
    );
  });

  it('rejects a non-folder id with a clear message', async () => {
    const { fetchFn } = driveFetch({
      gets: { PDF1: { id: 'PDF1', name: 'report.pdf', mimeType: 'application/pdf' } },
    });
    const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ answers: { root: 'PDF1' } });
    await expect(source.connect(auth)).rejects.toThrow(/"report\.pdf" is not a folder/);
  });
});
