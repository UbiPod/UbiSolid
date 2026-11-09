// Runs the CloudFs contract against one adapter.
//   bun test/adapter-conformance.ts fake                      (local folder, no network)
//   ACCESS_TOKEN=... bun test/adapter-conformance.ts onedrive  (or dropbox, googledrive)
//   CACHED=1 bun test/adapter-conformance.ts fake               (through PodListingCache)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { DropboxAdapter, GoogleDriveAdapter, LocalFolderAdapter, OneDriveAdapter, PodListingCache } from '../packages/css-cloud-storage/dist/index.js';

const provider = process.argv[2] ?? 'fake';
const adapters: Record<string, any> = {
  fake: new LocalFolderAdapter(mkdtempSync(join(tmpdir(), 'conf-'))),
  onedrive: new OneDriveAdapter(),
  dropbox: new DropboxAdapter(),
  googledrive: new GoogleDriveAdapter(),
};
const token = provider === 'fake' ? 'fake-at.tester.x' : process.env.ACCESS_TOKEN!;
const root = `/conformance-${Date.now().toString(36)}`;
// CACHED=1 runs the same contract through the listing cache CloudDataAccessor puts in front.
const raw = adapters[provider].open(token, root);
const fs = process.env.CACHED ? new PodListingCache().wrap(raw) : raw;

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    const result = await fn();
    if (result === false) {
      throw new Error('returned false');
    }
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${(error as Error).message?.slice(0, 300)}`);
  }
}
const text = async(stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};
const status = async(fn: () => Promise<unknown>): Promise<number | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
};

console.log(`${provider}: pod root ${root}`);
await check('a missing pod root stats as undefined', async() => await fs.stat('/') === undefined);
await check('mkdirp creates the pod root', async() => {
  await fs.mkdirp('/');
  return (await fs.stat('/'))?.isDirectory === true;
});
await check('mkdirp creates nested folders and is idempotent', async() => {
  await fs.mkdirp('/a/b');
  await fs.mkdirp('/a/b');
  return (await fs.stat('/a/b'))?.isDirectory === true;
});
await check('write then stat and read', async() => {
  await fs.write('/a/b/x.txt', Buffer.from('hello'));
  const s = await fs.stat('/a/b/x.txt');
  return s?.isDirectory === false && s.size === 5 && await text(await fs.read('/a/b/x.txt')) === 'hello';
});
await check('write creates missing parents', async() => {
  await fs.write('/deep/er/y.ttl', Buffer.from('<a> <b> <c>.'));
  return (await fs.stat('/deep/er'))?.isDirectory === true;
});
await check('awkward names: $ suffix, space, accents, #', async() => {
  for (const name of [ 'thing$.ttl', 'sp ace é.txt', 'hash#tag.txt', 'card.acl', '.meta' ]) {
    await fs.write(`/a/b/${name}`, Buffer.from(name));
    if (await text(await fs.read(`/a/b/${name}`)) !== name) {
      throw new Error(`round trip failed for ${name}`);
    }
  }
  return true;
});
await check('list shows files and folders with types', async() => {
  await fs.mkdirp('/a/b/sub');
  const names = (await fs.list('/a/b')).map((e: any) => `${e.name}${e.isDirectory ? '/' : ''}`).sort();
  const expected = [ '.meta', 'card.acl', 'hash#tag.txt', 'sp ace é.txt', 'sub/', 'thing$.ttl', 'x.txt' ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(names.join(', '));
  }
  return true;
});
await check('list of a missing folder is 404', async() => await status(() => fs.list('/nope')) === 404);
await check('write with a stale version is 412', async() =>
  await status(() => fs.write('/a/b/x.txt', Buffer.from('x'), '"stale-version"')) === 412);
await check('write with the current version succeeds', async() => {
  const version = (await fs.stat('/a/b/x.txt'))!.version;
  await fs.write('/a/b/x.txt', Buffer.from('hello again'), version);
  return await text(await fs.read('/a/b/x.txt')) === 'hello again';
});
await check('overwrite without a version', async() => {
  await fs.write('/a/b/x.txt', Buffer.from('third'));
  return await text(await fs.read('/a/b/x.txt')) === 'third';
});
await check('remove a file, and removing a missing one is fine', async() => {
  await fs.remove('/a/b/x.txt');
  await fs.remove('/a/b/x.txt');
  return await fs.stat('/a/b/x.txt') === undefined;
});
await check('remove a folder recursively', async() => {
  await fs.remove('/a');
  return await fs.stat('/a/b/thing$.ttl') === undefined && await fs.stat('/a') === undefined;
});
await check('1 MB binary round trip', async() => {
  const data = Buffer.alloc(1048576, 7);
  await fs.write('/big.bin', data);
  const chunks: Buffer[] = [];
  for await (const chunk of await fs.read('/big.bin')) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).equals(data);
});
await check('clean up the pod root', async() => {
  await fs.remove('/');
  return await fs.stat('/') === undefined;
});
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
