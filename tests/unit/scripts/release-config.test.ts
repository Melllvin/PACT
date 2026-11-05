import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// V1 release: the installers built by electron-builder and published to a draft GitHub Release,
// from the release workflow on a tag or from `npm run release` on a Mac or a PC.

const read = (path: string) => readFileSync(path, 'utf8');
const code = (path: string) =>
  read(path)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
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
  extraResources?: { from: string; to: string }[];
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

  it('ships the role skills beside the app, outside the asar (004 R3)', () => {
    expect(builder.extraResources).toContainEqual({ from: 'resources/skills', to: 'skills' });
    expect(read('resources/skills/README.md')).toContain('contracts/skills.md');
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
    expect(workflow).toContain('electron-builder --mac --publish never');
    expect(workflow).toContain('electron-builder --win --publish never');
  });

  it('refuses a tag that is not the version of package.json', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('"v$version"');
    expect(workflow).toContain('jq -r .version package.json');
  });

  it('refuses a tag whose commit is not on main, before creating the draft', () => {
    const workflow = read('.github/workflows/release.yml');
    const prepare = workflow.slice(workflow.indexOf('\n  prepare:'), workflow.indexOf('\n  mac:'));
    expect(prepare).toContain('fetch-depth: 0');
    expect(prepare).toContain('persist-credentials: false');
    expect(prepare).toContain('git merge-base --is-ancestor HEAD origin/main');
    expect(prepare.indexOf('is-ancestor')).toBeLessThan(prepare.indexOf('gh release create'));
  });

  it('publishes the draft only once it holds the .dmg, whatever Windows did', () => {
    const workflow = read('.github/workflows/release.yml');
    const publish = workflow.slice(workflow.indexOf('\n  publish:'));
    expect(publish).toContain("needs.mac.result == 'success'");
    expect(publish).not.toContain("needs.windows.result == 'success'");
    expect(publish).toContain("grep -q '\\.dmg$'");
    expect(publish).toContain('--draft=false');
    // Everything before the publish job leaves the release a draft.
    expect(workflow.slice(0, workflow.indexOf('\n  publish:'))).toContain('--draft');
  });

  it('builds a manual run without any release, and never runs for a pull request', () => {
    const workflow = code('.github/workflows/release.yml');
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('actions/upload-artifact');
    expect(workflow).not.toMatch(/^\s*pull_request/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('keeps the symptom of #63 out of the package: no node-pty bin cache, no darwin prebuilds', () => {
    const files = (JSON.parse(read('electron-builder.json')) as { files: string[] }).files;
    expect(files).toContain('!node_modules/node-pty/bin/**');
    expect(files).toContain('!node_modules/node-pty/prebuilds/darwin-*/**');
  });

  it('verifies the universal Mac build in CI, only for changes that reach the packaging', () => {
    const ci = code('.github/workflows/ci.yml');
    expect(ci).toContain('mac-build-changes');
    expect(ci).toContain("needs.mac-build-changes.outputs.build == 'true'");
    expect(ci).toContain('bash scripts/verify-mac-universal.sh');
    expect(ci).not.toContain('pull_request_target');
  });
});
