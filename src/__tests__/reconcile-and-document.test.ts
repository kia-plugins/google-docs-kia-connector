/**
 * Reconcile (full listing, throw-on-failure), toDocument purity/shape, and
 * fetchBytes (happy path, guards, 404/410 → null).
 */
import {
  createGoogleDocsSource,
  MAX_BINARY_BYTES,
  type DriveItem,
} from '../source';
import { DriveApiError } from '../client';
import type { DocumentInput } from '@kiagent/connector-sdk';
import {
  binaryFile,
  collect,
  driveFetch,
  fakeDoc,
  folder,
  gdoc,
  googleNative,
  instantClock,
  jsonRes,
  makeHost,
  makeSession,
  pdf,
  shortcut,
} from '../testing/harness';

function makeSource(world: Parameters<typeof driveFetch>[0]) {
  const { fetchFn, calls } = driveFetch(world);
  const source = createGoogleDocsSource(makeHost(fetchFn), instantClock);
  return { source, calls };
}

describe('reconcile', () => {
  it('lists the full tree, refs typed as routing would emit, shortcuts ref the TARGET id; ignored files/shortcut targets are omitted', async () => {
    const sheet = googleNative('sheet1', 'Budget', 'application/vnd.google-apps.spreadsheet');
    const { source, calls } = makeSource({
      lists: {
        root: [
          gdoc('docA', 'Doc A'),
          folder('S', 'Sub'),
          pdf('pdfB', 'b.pdf'),
          sheet,
          binaryFile('mp3-1', 'song.mp3', 'audio/mpeg'),
          binaryFile('zip-1', 'archive.zip', 'application/zip'),
          shortcut('sc1', 'Link', 'TD1', 'application/vnd.google-apps.document'),
          shortcut('sc2', 'Chain', 'TD2', 'application/vnd.google-apps.shortcut'),
          // A shortcut whose target is itself ignored (cloud-media) — the
          // target mime alone decides, no target fetch needed.
          shortcut('sc3', 'Song link', 'TD3', 'audio/mpeg'),
        ],
        S: [gdoc('docC', 'Doc C', { parents: ['S'] })],
      },
    });
    const { session } = makeSession();

    const pages = await collect(source.reconcile!(session));

    expect(pages).toEqual([
      [
        { externalId: 'docA', type: 'gdocs.doc' },
        { externalId: 'pdfB', type: 'file' },
        { externalId: 'TD1', type: 'gdocs.doc' },
      ],
      [{ externalId: 'docC', type: 'gdocs.doc' }],
    ]);
    // Ref typing comes from shortcutDetails.targetMimeType — no target fetch.
    expect(calls.some((u) => u.includes('/files/TD1'))).toBe(false);
    expect(calls.some((u) => u.includes('/files/TD3'))).toBe(false);
  });

  it('multi-root: lists every root; an overlapping subtree (root inside root) is listed once', async () => {
    const { source, calls } = makeSource({
      lists: {
        FA: [gdoc('a1', 'A doc', { parents: ['FA'] }), folder('FB', 'B Folder', { parents: ['FA'] })],
        FB: [gdoc('b1', 'B doc', { parents: ['FB'] })],
      },
    });
    const { session } = makeSession({
      config: {
        roots: [
          { rootFolderId: 'FA', rootName: 'Alpha' },
          { rootFolderId: 'FB', rootName: 'Beta' },
        ],
      },
    });

    const pages = await collect(source.reconcile!(session));

    expect(pages).toEqual([
      [{ externalId: 'a1', type: 'gdocs.doc' }],
      [{ externalId: 'b1', type: 'gdocs.doc' }],
    ]);
    expect(
      calls.filter((u) => (new URL(u).searchParams.get('q') ?? '').includes("'FB' in parents")),
    ).toHaveLength(1);
  });

  it("multi-root: THROWS when the second root's listing fails (partial must not read as complete)", async () => {
    const { source } = makeSource({
      lists: { FA: [gdoc('a1', 'A doc', { parents: ['FA'] })] },
      custom: (url) =>
        url.pathname === '/drive/v3/files' &&
        (url.searchParams.get('q') ?? '').includes("'FB'")
          ? jsonRes(500, { error: { message: 'Backend Error' } })
          : undefined,
    });
    const { session } = makeSession({
      config: {
        roots: [
          { rootFolderId: 'FA', rootName: 'Alpha' },
          { rootFolderId: 'FB', rootName: 'Beta' },
        ],
      },
    });

    await expect(collect(source.reconcile!(session))).rejects.toThrow(/drive 500/);
  });

  it('THROWS on any listing failure instead of yielding a partial live-set', async () => {
    const { source } = makeSource({
      lists: { root: [gdoc('docA', 'Doc A'), folder('S', 'Sub')] },
      custom: (url) =>
        url.pathname === '/drive/v3/files' && (url.searchParams.get('q') ?? '').includes("'S'")
          ? jsonRes(500, { error: { message: 'Backend Error' } })
          : undefined,
    });
    const { session } = makeSession();

    await expect(collect(source.reconcile!(session))).rejects.toThrow(/drive 500/);
  });
});

describe('toDocument', () => {
  const { source } = makeSource({});

  it('maps a native doc item — and is pure (same output twice, input untouched)', () => {
    const item: DriveItem = {
      file: gdoc('docA', 'Doc A'),
      docType: 'gdocs.doc',
      markdown: '# Doc A',
      extractionStatus: 'ok',
      displayPath: 'My Drive',
      rootFolderId: 'root',
    };
    const snapshot = JSON.parse(JSON.stringify(item));

    const doc = source.toDocument(item) as DocumentInput;

    expect(doc).toEqual({
      externalId: 'docA',
      type: 'gdocs.doc',
      title: 'Doc A',
      markdown: '# Doc A',
      url: 'https://docs.google.com/document/d/docA/edit',
      metadata: {
        drive_file_id: 'docA',
        mime_type: 'application/vnd.google-apps.document',
        size_bytes: null,
        drive_parents: ['MYDRIVE'],
        display_path: 'My Drive',
        modified_time: '2026-05-01T10:00:00Z',
        head_revision_id: 'rev-docA-1',
        md5_checksum: null,
        extraction_status: 'ok',
        root_folder_id: 'root',
      },
      createdAt: '2026-04-01T10:00:00Z',
    });
    expect(source.toDocument(item)).toEqual(doc);
    expect(JSON.parse(JSON.stringify(item))).toEqual(snapshot);
  });

  it('maps a binary item with bytes, a Drive url fallback, and createdAt fallback', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const item: DriveItem = {
      file: pdf('pdfB', 'b.pdf', { createdTime: undefined }),
      docType: 'file',
      markdown: null,
      bytes,
      extractionStatus: 'ok',
      displayPath: 'My Drive / Sub',
      rootFolderId: 'root',
    };

    const doc = source.toDocument(item) as DocumentInput;

    expect(doc.type).toBe('file');
    expect(doc.markdown).toBeNull();
    expect(doc.binary).toEqual({ bytes, mime: 'application/pdf', filename: 'b.pdf' });
    expect(doc.url).toBe('https://drive.google.com/file/d/pdfB/view');
    expect(doc.metadata.size_bytes).toBe(2048);
    expect(doc.metadata.md5_checksum).toBe('md5-pdfB-1');
    expect(doc.createdAt).toBe('2026-05-02T10:00:00Z'); // modifiedTime fallback
    // Engine vision/classify aliases ride alongside the v1-named keys on
    // 'file' docs (kiagent-core classify.ts reads mime/filename/sizeBytes).
    expect(doc.metadata.mime).toBe('application/pdf');
    expect(doc.metadata.filename).toBe('b.pdf');
    expect(doc.metadata.sizeBytes).toBe(2048);
  });

  it('maps a metadata-only item: empty-string markdown, NO binary', () => {
    const sheetFile = {
      id: 'sheet1',
      name: 'Budget',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['MYDRIVE'],
      modifiedTime: '2026-05-01T00:00:00Z',
    };
    const item: DriveItem = {
      file: sheetFile,
      docType: 'file',
      markdown: '',
      extractionStatus: 'unsupported',
      displayPath: 'My Drive',
      rootFolderId: 'root',
    };

    const doc = source.toDocument(item) as DocumentInput;

    expect(doc.markdown).toBe('');
    expect(doc.binary).toBeUndefined();
    expect(doc.metadata.extraction_status).toBe('unsupported');
    // Aliases present on metadata-only 'file' docs too; sizeBytes omitted
    // when Drive reports no size (classify's ?? fallback handles absence).
    expect(doc.metadata.mime).toBe('application/vnd.google-apps.spreadsheet');
    expect(doc.metadata.filename).toBe('Budget');
    expect('sizeBytes' in doc.metadata).toBe(false);
  });
});

describe('fetchBytes', () => {
  const pdfDocMeta = {
    drive_file_id: 'pdfB',
    mime_type: 'application/pdf',
    size_bytes: 2048,
  };

  it('re-downloads a convertible binary through alt=media', async () => {
    const raw = new Uint8Array([7, 7, 7]);
    const { source } = makeSource({ media: { pdfB: raw } });
    const { session } = makeSession();

    const bytes = await source.fetchBytes!(session, fakeDoc('pdfB', 'file', pdfDocMeta));
    expect(bytes).toEqual(raw);
  });

  it('serves image bytes for the vision pipeline', async () => {
    const raw = new Uint8Array([137, 80, 78, 71]);
    const { source } = makeSource({ media: { img1: raw } });
    const { session } = makeSession();

    const bytes = await source.fetchBytes!(
      session,
      fakeDoc('img1', 'file', {
        drive_file_id: 'img1',
        mime_type: 'image/png',
        size_bytes: 4,
      }),
    );
    expect(bytes).toEqual(raw);
  });

  it('returns null for native docs without fetching (markdown already in the doc)', async () => {
    const { source, calls } = makeSource({});
    const { session } = makeSession();

    const bytes = await source.fetchBytes!(
      session,
      fakeDoc('docA', 'gdocs.doc', { drive_file_id: 'docA' }),
    );
    expect(bytes).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null for non-convertible mimes without fetching', async () => {
    const { source, calls } = makeSource({});
    const { session } = makeSession();

    const bytes = await source.fetchBytes!(
      session,
      fakeDoc('zip1', 'file', {
        drive_file_id: 'zip1',
        mime_type: 'application/zip',
        size_bytes: 10,
      }),
    );
    expect(bytes).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null over the 25 MiB cap without fetching', async () => {
    const { source, calls } = makeSource({});
    const { session } = makeSession();

    const bytes = await source.fetchBytes!(
      session,
      fakeDoc('big1', 'file', {
        drive_file_id: 'big1',
        mime_type: 'application/pdf',
        size_bytes: MAX_BINARY_BYTES + 1,
      }),
    );
    expect(bytes).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it.each([404, 410])('returns null when the file is gone upstream (%i)', async (status) => {
    const { source } = makeSource({
      media: { pdfB: jsonRes(status, { error: { message: 'gone' } }) },
    });
    const { session } = makeSession();

    const bytes = await source.fetchBytes!(session, fakeDoc('pdfB', 'file', pdfDocMeta));
    expect(bytes).toBeNull();
  });

  it('propagates other HTTP failures', async () => {
    const { source } = makeSource({
      media: { pdfB: jsonRes(403, { error: { message: 'The user does not have permission' } }) },
    });
    const { session } = makeSession();

    await expect(
      source.fetchBytes!(session, fakeDoc('pdfB', 'file', pdfDocMeta)),
    ).rejects.toThrow(DriveApiError);
  });
});
