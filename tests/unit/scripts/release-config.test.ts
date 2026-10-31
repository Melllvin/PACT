import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// V1 release: the installers built by electron-builder and published to a draft GitHub Release,
// from the release workflow on a tag or from `npm run release` on a Mac or a PC.

const read = (path: string) => readFileSync(path, 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  author?: string;
  scripts: Record<string, string>;
};
const builder = JSON.parse(read('electron-builder.json')) as {
  appId: string;
  productName: string;
  icon: string;
  asarUnpack: string[];
  publish: { provider: string; owner: string; repo: string; releaseType: string };
  mac: { identity: string | null; target: { target: string; arch: string[] }[] };
  win: { target: { target: string; arch: string[] }[] };
  nsis: Record<string, unknown>;
};

describe('release configuration', () => {
  it('is version 1.0.0, with an author for the installers', () => {
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.author).toBeTruthy();
  });

  it('publishes with `npm run release`, after building', () => {
    expect(pkg.scripts.release).toBe('npm run build && electron-builder --publish always');
  });

  it('builds a universal dmg, ad-hoc signed so it opens on Apple Silicon', () => {
    expect(builder.mac.target).toEqual([{ target: 'dmg', arch: ['universal'] }]);
    // No Apple certificate for the V1: '-' signs ad hoc, `null` would leave arm64 unopenable.
    expect(builder.mac.identity).toBe('-');
  });

  it('builds an NSIS installer for Windows x64 and arm64, installable per user', () => {
    expect(builder.win.target).toEqual([{ target: 'nsis', arch: ['x64', 'arm64'] }]);
    expect(builder.nsis).toMatchObject({ oneClick: false, perMachine: false });
  });

  it('keeps node-pty outside the asar', () => {
    expect(builder.asarUnpack).toContain('node_modules/node-pty/**');
  });

  it('publishes to a draft release of the repository, never straight to the public', () => {
    expect(builder.publish).toEqual({
      provider: 'github',
      owner: 'Melllvin',
      repo: 'PACT',
      releaseType: 'draft',
    });
  });

  it('has a 1024 px PNG icon', () => {
    expect(builder.icon).toBe('build/icon.png');
    const png = readFileSync(builder.icon);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    // IHDR: width then height, big-endian, right after the signature and the chunk header.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 1024]);
  });

  it('runs the release workflow on a version tag, on macOS and Windows', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toMatch(/tags:\s*\[?\s*['"]?v\*/);
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('macos-latest');
    expect(workflow).toContain('windows-latest');
    expect(workflow).toContain('npm run release');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });
});
