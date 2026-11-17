import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FileSystemMCPServer } from '../dist/server.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'hela-membrane-security-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withMcpServer(allowedRoots, fn) {
  const previousRoots = process.env.HELA_ALLOWED_ROOTS;
  const previousAlias = process.env.ALLOWED_ROOTS;
  const previousEnvelope = process.env.HELA_ENVELOPE;
  process.env.HELA_ALLOWED_ROOTS = allowedRoots.join(':');
  delete process.env.ALLOWED_ROOTS;
  process.env.HELA_ENVELOPE = 'true';
  const server = new FileSystemMCPServer();
  const client = new Client({ name: 'security-edge-cases', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
    await fn(client);
  } finally {
    await Promise.allSettled([client.close(), serverTransport.close()]);
    if (previousRoots === undefined) delete process.env.HELA_ALLOWED_ROOTS;
    else process.env.HELA_ALLOWED_ROOTS = previousRoots;
    if (previousAlias === undefined) delete process.env.ALLOWED_ROOTS;
    else process.env.ALLOWED_ROOTS = previousAlias;
    if (previousEnvelope === undefined) delete process.env.HELA_ENVELOPE;
    else process.env.HELA_ENVELOPE = previousEnvelope;
  }
}

function payload(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (!text) return result.content?.[0];
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' && 'ok' in parsed
    ? { ...(parsed.data || {}), success: parsed.data?.success ?? parsed.ok, error: parsed.error ?? parsed.data?.error }
    : parsed;
}

test('workspace policy rejects direct, parent, and chained symlink escapes', async () => {
  await withTempDir(async base => {
    const root = join(base, 'allowed');
    const outside = join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const secret = join(outside, 'secret.txt');
    await fs.writeFile(secret, 'outside-secret');
    await fs.symlink(secret, join(root, 'direct-link'));
    await fs.symlink(outside, join(root, 'parent-link'));
    await fs.symlink(secret, join(root, 'chain-second'));
    await fs.symlink(join(root, 'chain-second'), join(root, 'chain-first'));

    await withMcpServer([root], async client => {
      for (const escapedPath of [
        join(root, 'direct-link'),
        join(root, 'parent-link', 'secret.txt'),
        join(root, 'chain-first'),
      ]) {
        const read = payload(await client.callTool({ name: 'read_file', arguments: { path: escapedPath } }));
        assert.equal(read.success, false, `read unexpectedly succeeded for ${escapedPath}`);
        assert.match(read.error, /escapes configured workspace roots/);

        const write = payload(await client.callTool({
          name: 'write_file', arguments: { path: escapedPath, content: 'overwritten' },
        }));
        assert.equal(write.success, false, `write unexpectedly succeeded for ${escapedPath}`);
        assert.match(write.error, /escapes configured workspace roots/);

        const listed = payload(await client.callTool({ name: 'list_directory', arguments: { path: escapedPath } }));
        assert.equal(listed.success, false, `listing unexpectedly succeeded for ${escapedPath}`);
        assert.match(listed.error, /escapes configured workspace roots/);
      }
    });
    assert.equal(await fs.readFile(secret, 'utf8'), 'outside-secret');
  });
});

test('listing an allowed root does not disclose entries reached through symlinks', async () => {
  await withTempDir(async base => {
    const root = join(base, 'allowed');
    const outside = join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'secret.txt'), 'outside-secret');
    await fs.symlink(outside, join(root, 'outside-link'));
    await fs.symlink(join(outside, 'secret.txt'), join(root, 'secret-link'));

    await withMcpServer([root], async client => {
      const listed = payload(await client.callTool({
        name: 'list_directory', arguments: { path: root, recursive: true, includeHidden: true },
      }));
      assert.equal(listed.success, true);
      assert.equal(listed.data.items.some(item => item.path.includes('outside-link')), false);
      assert.equal(listed.data.items.some(item => item.path.includes('secret-link')), false);

      const found = payload(await client.callTool({ name: 'find_files', arguments: { directory: root, pattern: '**/*' } }));
      assert.equal(found.success, true);
      assert.equal(found.data.files.some(item => item.path.includes('outside-link') || item.path.includes('secret-link')), false);

      const searched = payload(await client.callTool({
        name: 'search_in_files', arguments: { directory: root, pattern: 'outside-secret' },
      }));
      assert.equal(searched.success, true);
      assert.equal(searched.data.totalMatches, 0);
    });
  });
});

test('archive extraction currently expands beyond any configured size limit', async () => {
  await withTempDir(async base => {
    const root = join(base, 'allowed');
    await fs.mkdir(root);
    const source = join(root, 'compressible.txt');
    const expanded = 'A'.repeat(2 * 1024 * 1024);
    const archive = join(root, 'payload.zip');
    const destination = join(root, 'extracted');

    await fs.writeFile(source, expanded);
    await withMcpServer([root], async client => {
      const created = payload(await client.callTool({
        name: 'archive_files', arguments: { files: [source], archivePath: archive, format: 'zip' },
      }));
      assert.equal(created.success, true, created.error);
      assert.ok((await fs.stat(archive)).size < expanded.length / 10, 'fixture must have a high expansion ratio');

      const extraction = payload(await client.callTool({
        name: 'extract_archive', arguments: { archivePath: archive, destination },
      }));
      assert.equal(extraction.success, true, extraction.error);
      const extractedFiles = [];
      async function collectFiles(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await collectFiles(path);
          else if (entry.isFile()) extractedFiles.push(path);
        }
      }
      await collectFiles(destination);
      assert.equal(extractedFiles.length, 1);
      assert.equal((await fs.stat(extractedFiles[0])).size, expanded.length);
    });
  });
});

test('stopped watcher releases filesystem handles and does not keep the process alive', async () => {
  await withTempDir(async root => {
    const watched = join(root, 'watched');
    await fs.mkdir(watched);
    const activeWatchers = () => process._getActiveHandles().filter(handle => handle.constructor?.name === 'FSWatcher').length;
    const baseline = activeWatchers();

    await withMcpServer([root], async client => {
      const started = payload(await client.callTool({ name: 'watch_file', arguments: { path: watched } }));
      assert.equal(started.success, true, started.error);
      const stopped = payload(await client.callTool({ name: 'stop_watching', arguments: { path: watched } }));
      assert.equal(stopped.success, true, stopped.error);
      const stoppedAgain = payload(await client.callTool({ name: 'stop_watching', arguments: { path: watched } }));
      assert.equal(stoppedAgain.success, false, 'stopped watcher should be removed from the active watcher registry');
      assert.match(stoppedAgain.error, /Watcher not found/);

      await new Promise(resolve => setTimeout(resolve, 100));
      await fs.writeFile(join(watched, 'after-stop.txt'), 'no watcher should observe this');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(activeWatchers(), baseline, 'watcher handles should be closed after stop');
    });
  });
});

test('large reads and copies preserve all bytes; no maximum size limit is configured', async () => {
  await withTempDir(async root => {
    const source = join(root, 'large.bin');
    const destination = join(root, 'large-copy.bin');
    const content = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    await fs.writeFile(source, content);

    await withMcpServer([root], async client => {
      const read = payload(await client.callTool({ name: 'read_file', arguments: { path: source, encoding: 'base64' } }));
      assert.equal(read.success, true, read.error);
      assert.equal(Buffer.from(read.data.content, 'base64').length, content.length);
      assert.equal(createHash('sha256').update(Buffer.from(read.data.content, 'base64')).digest('hex'), createHash('sha256').update(content).digest('hex'));

      const copied = payload(await client.callTool({
        name: 'copy_file', arguments: { source, destination },
      }));
      assert.equal(copied.success, true, copied.error);
      assert.deepEqual(await fs.readFile(destination), content);
    });
  });
});
