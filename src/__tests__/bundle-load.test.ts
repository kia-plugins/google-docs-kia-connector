/**
 * Smoke test for the bundled dist/index.js — proves the CJS/ESM dual export
 * in src/index.ts (`export default mod; module.exports = mod;`) against
 * actual esbuild output, exactly what silently breaks on an esbuild upgrade.
 *
 * The build + require + activate plumbing is the SDK's `bundleLoadSmoke`; the
 * host it activates against is local, because this extension's activate()
 * reads `query` as well as `net` (HostFor<'net' | 'query'>) and the kit's
 * default host carries `net` only.
 */
import { join } from 'node:path';
import type { HostFor, Query } from '@kiagent/connector-sdk';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the google-docs source', async () => {
    const unused = () => {
      throw new Error('unused in this smoke test');
    };
    const host: HostFor<'net' | 'query'> = {
      self: { id: 'kia.google-docs', dataDir: '/tmp' },
      log: () => {},
      net: { fetch: unused },
      query: {
        document: unused,
        children: unused,
        byExternalId: unused,
        search: unused,
        count: unused,
        accounts: unused,
      } as unknown as Query,
    };

    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'kia.google-docs',
      sourceIds: ['google-docs'],
      host,
    });
  }, 30_000);
});
