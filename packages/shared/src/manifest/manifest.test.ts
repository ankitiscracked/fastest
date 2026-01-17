/**
 * Tests for manifest module
 * Run with: bun test packages/shared/src/manifest/manifest.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  sha256,
  generateFromFiles,
  toJSON,
  fromJSON,
  hashManifest,
  diff,
  totalSize,
  fileCount,
  getBlobHashes,
  getNewBlobHashes,
  empty,
} from './manifest';
import { IgnoreMatcher, DEFAULT_PATTERNS } from './ignore';

describe('sha256', () => {
  test('hashes string correctly', async () => {
    // "hello" SHA-256 hash
    const hash = await sha256('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  test('hashes Uint8Array correctly', async () => {
    const data = new TextEncoder().encode('hello');
    const hash = await sha256(data);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  test('empty string hash', async () => {
    const hash = await sha256('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('IgnoreMatcher', () => {
  test('matches default patterns', () => {
    const matcher = new IgnoreMatcher();

    expect(matcher.match('.git', true)).toBe(true);
    expect(matcher.match('.git/config', false)).toBe(true);
    expect(matcher.match('node_modules', true)).toBe(true);
    expect(matcher.match('node_modules/lodash/index.js', false)).toBe(true);
    expect(matcher.match('.DS_Store', false)).toBe(true);
    expect(matcher.match('file.pyc', false)).toBe(true);
  });

  test('does not match regular files', () => {
    const matcher = new IgnoreMatcher();

    expect(matcher.match('src/index.ts', false)).toBe(false);
    expect(matcher.match('package.json', false)).toBe(false);
    expect(matcher.match('README.md', false)).toBe(false);
  });

  test('handles custom patterns', () => {
    const matcher = new IgnoreMatcher([...DEFAULT_PATTERNS, 'dist/', '*.log']);

    expect(matcher.match('dist', true)).toBe(true);
    expect(matcher.match('dist/bundle.js', false)).toBe(true);
    expect(matcher.match('error.log', false)).toBe(true);
    expect(matcher.match('src/index.ts', false)).toBe(false);
  });

  test('handles negation patterns', () => {
    const matcher = new IgnoreMatcher(['*.log', '!important.log']);

    expect(matcher.match('error.log', false)).toBe(true);
    expect(matcher.match('important.log', false)).toBe(false);
  });

  test('parses .fstignore content', () => {
    const content = `
# Comment
dist/
*.log

# Another comment
build/
    `;

    const matcher = IgnoreMatcher.fromFileContent(content);

    expect(matcher.match('dist', true)).toBe(true);
    expect(matcher.match('build', true)).toBe(true);
    expect(matcher.match('error.log', false)).toBe(true);
    expect(matcher.match('src/index.ts', false)).toBe(false);
  });
});

describe('generateFromFiles', () => {
  test('generates manifest from files', async () => {
    const files = [
      { path: 'b.txt', content: 'hello' },
      { path: 'a.txt', content: 'world' },
    ];

    const manifest = await generateFromFiles(files);

    expect(manifest.version).toBe('1');
    expect(manifest.files.length).toBe(2);

    // Files should be sorted by path
    expect(manifest.files[0].path).toBe('a.txt');
    expect(manifest.files[1].path).toBe('b.txt');

    // Hashes should be correct
    expect(manifest.files[0].hash).toBe(await sha256('world'));
    expect(manifest.files[1].hash).toBe(await sha256('hello'));
  });

  test('ignores default patterns', async () => {
    const files = [
      { path: 'src/index.ts', content: 'code' },
      { path: 'node_modules/lodash/index.js', content: 'lodash' },
      { path: '.DS_Store', content: 'junk' },
    ];

    const manifest = await generateFromFiles(files);

    expect(manifest.files.length).toBe(1);
    expect(manifest.files[0].path).toBe('src/index.ts');
  });

  test('handles Uint8Array content', async () => {
    const content = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    const files = [{ path: 'binary.bin', content }];

    const manifest = await generateFromFiles(files);

    expect(manifest.files[0].hash).toBe(await sha256('hello'));
    expect(manifest.files[0].size).toBe(5);
  });

  test('includes mod_time when requested', async () => {
    const files = [
      { path: 'file.txt', content: 'test', modTime: 1234567890 },
    ];

    const manifest = await generateFromFiles(files, { includeModTime: true });

    expect(manifest.files[0].mod_time).toBe(1234567890);
  });
});

describe('toJSON / fromJSON', () => {
  test('round-trips manifest', async () => {
    const original = await generateFromFiles([
      { path: 'test.txt', content: 'hello' },
    ]);

    const json = toJSON(original);
    const parsed = fromJSON(json);

    expect(parsed.version).toBe(original.version);
    expect(parsed.files.length).toBe(original.files.length);
    expect(parsed.files[0].path).toBe(original.files[0].path);
    expect(parsed.files[0].hash).toBe(original.files[0].hash);
  });

  test('produces deterministic JSON', async () => {
    const files = [
      { path: 'b.txt', content: 'b' },
      { path: 'a.txt', content: 'a' },
    ];

    const m1 = await generateFromFiles(files);
    const m2 = await generateFromFiles([...files].reverse());

    expect(toJSON(m1)).toBe(toJSON(m2));
  });
});

describe('hashManifest', () => {
  test('produces consistent hash', async () => {
    const manifest = await generateFromFiles([
      { path: 'test.txt', content: 'hello' },
    ]);

    const hash1 = await hashManifest(manifest);
    const hash2 = await hashManifest(manifest);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  test('different content produces different hash', async () => {
    const m1 = await generateFromFiles([{ path: 'test.txt', content: 'hello' }]);
    const m2 = await generateFromFiles([{ path: 'test.txt', content: 'world' }]);

    const hash1 = await hashManifest(m1);
    const hash2 = await hashManifest(m2);

    expect(hash1).not.toBe(hash2);
  });
});

describe('diff', () => {
  test('detects added files', async () => {
    const base = await generateFromFiles([
      { path: 'a.txt', content: 'a' },
    ]);
    const current = await generateFromFiles([
      { path: 'a.txt', content: 'a' },
      { path: 'b.txt', content: 'b' },
    ]);

    const result = diff(base, current);

    expect(result.added).toEqual(['b.txt']);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  test('detects modified files', async () => {
    const base = await generateFromFiles([
      { path: 'a.txt', content: 'old' },
    ]);
    const current = await generateFromFiles([
      { path: 'a.txt', content: 'new' },
    ]);

    const result = diff(base, current);

    expect(result.added).toEqual([]);
    expect(result.modified).toEqual(['a.txt']);
    expect(result.deleted).toEqual([]);
  });

  test('detects deleted files', async () => {
    const base = await generateFromFiles([
      { path: 'a.txt', content: 'a' },
      { path: 'b.txt', content: 'b' },
    ]);
    const current = await generateFromFiles([
      { path: 'a.txt', content: 'a' },
    ]);

    const result = diff(base, current);

    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual(['b.txt']);
  });

  test('detects all change types', async () => {
    const base = await generateFromFiles([
      { path: 'unchanged.txt', content: 'same' },
      { path: 'modified.txt', content: 'old' },
      { path: 'deleted.txt', content: 'gone' },
    ]);
    const current = await generateFromFiles([
      { path: 'unchanged.txt', content: 'same' },
      { path: 'modified.txt', content: 'new' },
      { path: 'added.txt', content: 'new file' },
    ]);

    const result = diff(base, current);

    expect(result.added).toEqual(['added.txt']);
    expect(result.modified).toEqual(['modified.txt']);
    expect(result.deleted).toEqual(['deleted.txt']);
  });
});

describe('utility functions', () => {
  test('totalSize', async () => {
    const manifest = await generateFromFiles([
      { path: 'a.txt', content: 'hello' },  // 5 bytes
      { path: 'b.txt', content: 'world!' }, // 6 bytes
    ]);

    expect(totalSize(manifest)).toBe(11);
  });

  test('fileCount', async () => {
    const manifest = await generateFromFiles([
      { path: 'a.txt', content: 'a' },
      { path: 'b.txt', content: 'b' },
      { path: 'c.txt', content: 'c' },
    ]);

    expect(fileCount(manifest)).toBe(3);
  });

  test('getBlobHashes', async () => {
    const manifest = await generateFromFiles([
      { path: 'a.txt', content: 'same' },
      { path: 'b.txt', content: 'same' },  // Same content = same hash
      { path: 'c.txt', content: 'different' },
    ]);

    const hashes = getBlobHashes(manifest);

    expect(hashes.length).toBe(2); // Deduplicated
  });

  test('getNewBlobHashes', async () => {
    const base = await generateFromFiles([
      { path: 'old.txt', content: 'old content' },
    ]);
    const current = await generateFromFiles([
      { path: 'old.txt', content: 'old content' },
      { path: 'new.txt', content: 'new content' },
    ]);

    const newHashes = getNewBlobHashes(base, current);

    expect(newHashes.length).toBe(1);
    expect(newHashes[0]).toBe(await sha256('new content'));
  });

  test('empty', () => {
    const manifest = empty();

    expect(manifest.version).toBe('1');
    expect(manifest.files).toEqual([]);
  });
});
