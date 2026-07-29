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
import type { HostFor, Query, Source } from '@kiagent/connector-sdk';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the google-docs source', async () => {
    const root = join(__dirname, '..', '..');
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
      root,
      selfId: 'kia.google-docs',
      sourceIds: ['google-docs'],
      host,
    });

    // `bundleLoadSmoke` covers the build, the require, and the contributed
    // source ids, but never returns the activate() result — so the descriptor
    // check the smoke has always carried is re-asserted here. The bundle is
    // already built and require-cached by the call above, and activate() only
    // closes over the host, so re-activating costs nothing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(root, 'dist', 'index.js'));
    const entry = mod.default ?? mod;
    const result = (await entry.activate(host)) as { sources?: Source[] };
    expect(result.sources?.[0]?.descriptor.auth).toBe('oauth');
  }, 30_000);
});
