import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileOperations } from '../dist/file-operations.js';
import { AdvancedOperations } from '../dist/advanced-operations.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'membrane-'));

test('read_file: a byte limit never splits a UTF-8 character', async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, 'utf8.txt');
    await writeFile(file, 'héllo — ünïcode\n');
    const result = await FileOperations.readFile({ path: file, limit: 2 });
    assert.equal(result.success, true);
    assert.ok(!result.data.content.includes('\uFFFD'), `replacement character in ${JSON.stringify(result.data.content)}`);
    assert.equal(result.data.content, 'hé', 'the range should extend to complete the character');
    assert.equal(result.data.endByte, 3);
    assert.equal(result.data.size, 3, 'size is the byte range actually consumed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read_file: a mid-sequence offset snaps back to the character boundary', async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, 'utf8.txt');
    await writeFile(file, 'héllo');
    // Byte 2 is the continuation byte of é (C3 A9 at 1-2): a mid-sequence offset.
    const result = await FileOperations.readFile({ path: file, offset: 2, limit: 3 });
    assert.equal(result.success, true);
    assert.ok(!result.data.content.includes('\uFFFD'));
    assert.equal(result.data.startByte, 1, 'offset should snap back to the lead byte');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compare_files: size is bytes, characters are reported separately, lines ignore the trailing newline', async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, 'a.txt');
    const content = 'line one\nline two\nCafé Ünïcode — em dash\n';
    await writeFile(file, content);

    const result = await AdvancedOperations.compareFiles({ file1: file, file2: file });
    assert.equal(result.success, true);
    const stats = result.data.file1;
    assert.equal(stats.size, Buffer.byteLength(content, 'utf8'), 'size must be bytes');
    assert.equal(stats.characters, content.length, 'characters is the code-unit count');
    assert.equal(stats.lines, 3, 'a trailing newline does not add a line');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extract_archive: reports skipped traversal entries instead of dropping them silently', async () => {
  const dir = await tmp();
  try {
    const archive = path.join(dir, 'evil.zip');
    execFileSync('python3', ['-c', `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('../../escaped.txt', 'gone')
    z.writestr('harmless.txt', 'kept')
`, archive]);

    const out = path.join(dir, 'out');
    const result = await AdvancedOperations.extractArchive(archive, out);

    assert.equal(result.success, true);
    assert.equal(result.data.extracted, 1);
    assert.equal(result.data.skipped.length, 1);
    assert.equal(result.data.skipped[0].entry, '../../escaped.txt');
    assert.match(result.data.skipped[0].reason, /traversal/);
    assert.match(result.message, /skipped/);

    const files = await readFile(path.join(out, 'harmless.txt'), 'utf8');
    assert.equal(files, 'kept');
    await assert.rejects(readFile(path.join(dir, 'escaped.txt')), 'traversal must not write outside');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('watch_file: a repeat call returns the events the watcher buffered', async () => {
  const dir = await tmp();
  try {
    const watched = path.join(dir, 'watched');
    await mkdir(watched);
    const started = await AdvancedOperations.watchFile({ path: watched, recursive: true, ignoreInitial: true });
    assert.equal(started.success, true);
    assert.deepEqual(started.data.events, []);

    await writeFile(path.join(watched, 'triggered.txt'), 'change');

    let events = [];
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const polled = await AdvancedOperations.watchFile({ path: watched, recursive: true, ignoreInitial: true });
      events = polled.data.events;
    }
    assert.ok(events.length > 0, 'no events returned after a create inside the watched tree');
    assert.ok(events.some(event => event.type === 'add' && event.path.endsWith('triggered.txt')));

    const stopped = await AdvancedOperations.stopWatching(watched);
    assert.equal(stopped.data.watching, false);
  } finally {
    await AdvancedOperations.cleanupAllWatchers?.();
    await rm(dir, { recursive: true, force: true });
  }
});
