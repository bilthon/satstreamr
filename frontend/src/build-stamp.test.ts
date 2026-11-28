import { describe, expect, it } from 'vitest';
import { buildStampLabel, injectBuildStamp, normalizeCommit, resolveBuildStamp } from './build-stamp.js';

const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('buildStampLabel', () => {
  it('shows the version and the first 6 hex characters of a full sha', () => {
    expect(buildStampLabel({ version: '0.3.1', commit: sha })).toBe('v0.3.1 · a1b2c3');
  });

  it('shows only the version when the commit is unknown', () => {
    expect(buildStampLabel({ version: '0.3.1', commit: null })).toBe('v0.3.1');
  });
});

describe('normalizeCommit', () => {
  it('trims and lowercases a valid sha', () => {
    expect(normalizeCommit('  A1B2C3D\n')).toBe('a1b2c3d');
  });

  it.each([undefined, null, '', 'abc12', 'not-a-sha', 'g1b2c3d4', 'a'.repeat(41)])('rejects %j', raw => {
    expect(normalizeCommit(raw)).toBeNull();
  });
});

describe('resolveBuildStamp', () => {
  const base = { version: '0.3.1', envCommit: undefined, githubSha: undefined, gitHead: undefined };

  it('prefers SATSTREAMR_COMMIT over GITHUB_SHA over git HEAD', () => {
    expect(resolveBuildStamp({ ...base, envCommit: 'aaaaaa', githubSha: 'bbbbbb', gitHead: 'cccccc' }).commit).toBe('aaaaaa');
    expect(resolveBuildStamp({ ...base, githubSha: 'bbbbbb', gitHead: 'cccccc' }).commit).toBe('bbbbbb');
    expect(resolveBuildStamp({ ...base, gitHead: `${sha}\n` })).toEqual({ version: '0.3.1', commit: sha });
  });

  it('falls through an invalid SATSTREAMR_COMMIT to git HEAD', () => {
    expect(resolveBuildStamp({ ...base, envCommit: 'nope', gitHead: 'cccccc' }).commit).toBe('cccccc');
  });

  it('yields a null commit when every source is invalid or missing', () => {
    expect(resolveBuildStamp({ ...base, envCommit: 'nope', githubSha: '' })).toEqual({ version: '0.3.1', commit: null });
  });
});

describe('injectBuildStamp', () => {
  it('replaces the token with the HTML-escaped label and keeps $ literal', () => {
    const html = '<span class="build-stamp">__BUILD_STAMP_LABEL__</span>';
    expect(injectBuildStamp(html, 'v0.3.1 · a1b2c3')).toBe('<span class="build-stamp">v0.3.1 · a1b2c3</span>');
    expect(injectBuildStamp(html, 'v<b>&$&')).toBe('<span class="build-stamp">v&lt;b&gt;&amp;$&amp;</span>');
  });
});
