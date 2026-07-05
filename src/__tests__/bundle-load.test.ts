/**
 * Smoke test for the bundled dist/index.js — proves the CJS/ESM dual export
 * in src/index.ts (`export default mod; module.exports = mod;`) against
 * actual esbuild output, exactly what silently breaks on an esbuild upgrade
 * (same rationale as the notion reference port's bundle-load test).
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostFor, Query } from '../kiagent-contracts';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the google-docs source', async () => {
    const root = join(__dirname, '..', '..');
    execSync('npm run build', { cwd: root });

    // Bare Node child-process require — proves the bundle loads outside
    // jest's module registry, the way the extension host child loads it.
    const out = execSync(
      'node -e "const m=require(\'./dist/index.js\');const e=m.default??m;' +
        "if(typeof e.activate!=='function')throw new Error('no activate');" +
        'console.log(\'activate:\'+typeof e.activate)"',
      { cwd: root },
    ).toString();
    expect(out).toContain('activate:function');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(root, 'dist', 'index.js'));
    const entry = mod.default ?? mod;
    expect(typeof entry.activate).toBe('function');

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
    const result = await entry.activate(host);

    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]?.descriptor.id).toBe('google-docs');
    expect(result.sources?.[0]?.descriptor.auth).toBe('oauth');
  }, 30_000);
});
