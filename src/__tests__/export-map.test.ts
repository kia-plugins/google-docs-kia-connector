import { chooseRoute } from '../export-map';

describe('chooseRoute — file policy v5 (SDK 1.10.0)', () => {
  it.each([
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['notes.odt', 'application/vnd.oasis.opendocument.text'],
    ['sheet.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['book.epub', 'application/epub+zip'],
    ['old.doc', 'application/msword'],
    ['memo.rtf', 'application/rtf'],
    ['old.xls', 'application/vnd.ms-excel'],
    ['book.epub', 'application/octet-stream'],
  ])('%s (%s) is downloaded for the converter', (filename, mime) => {
    expect(chooseRoute(mime, filename, 1000)).toEqual({ kind: 'binary', pipeline: 'converter', bytes: 'eager' });
  });

  it.each([
    ['talk.srt', 'application/x-subrip'],
    ['mail.mbox', 'application/mbox'],
  ])('%s stays local-only (ignored in the cloud)', (filename, mime) => {
    expect(chooseRoute(mime, filename, 1000).kind).toBe('ignore');
  });

  it('Google Slides stay ignored (no bytes to download)', () => {
    expect(chooseRoute('application/vnd.google-apps.presentation', 'Deck', 1000)).toEqual({
      kind: 'ignore',
      reason: 'unsupported',
    });
  });
});
