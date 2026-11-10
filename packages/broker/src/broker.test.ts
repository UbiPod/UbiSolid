import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, BrokerError } from './broker';
import { LocalKeyWrapper } from './crypto';
import { FakeProvider } from './providers';
import type { ProviderName } from './providers';

const REDIRECT = 'https://pod.test/.account/storage/callback/';

function setup(now = () => Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'broker-'));
  const fake = new FakeProvider();
  const keys = new LocalKeyWrapper(randomBytes(32));
  const dbPath = join(dir, 'b.sqlite');
  const broker = new Broker(dbPath, keys, new Map<ProviderName, any>([[ 'fake', fake ]]), REDIRECT, { now, issueLimitPerHour: 5 });
  return { broker, fake, dbPath };
}

async function link(broker: Broker, accountId = 'acct-1', user = 'alice') {
  const { authorizeUrl } = broker.createLink('fake', accountId, user);
  const url = new URL(authorizeUrl);
  expect(url.href.startsWith(REDIRECT)).toBe(true);
  return broker.completeLink(url.searchParams.get('code')!, url.searchParams.get('state')!, accountId);
}

test('links, binds and issues tokens; the refresh token is never stored in the clear', async() => {
  const { broker, dbPath } = setup();
  const l = await link(broker);
  expect(l.provider).toBe('fake');
  expect(l.email).toBe('alice@example.test');
  const { root } = broker.bindPod('https://pod.test/alice/', l.linkId, 'acct-1');
  expect(root).toBe('/alice');
  const t = await broker.token(l.linkId, 'https://pod.test/alice/');
  expect(t.accessToken.startsWith('fake-at.alice.')).toBe(true);
  const raw = new Database(dbPath).query('SELECT * FROM links').get() as Record<string, string>;
  expect(JSON.stringify(raw)).not.toContain('fake-rt.');
});

test('state is single use and bound to the account that started it', async() => {
  const { broker } = setup();
  const { authorizeUrl } = broker.createLink('fake', 'acct-1');
  const url = new URL(authorizeUrl);
  const code = url.searchParams.get('code')!;
  const state = url.searchParams.get('state')!;
  await expect(broker.completeLink(code, state, 'acct-evil')).rejects.toMatchObject({ status: 403 });
  // Burned by the failed attempt.
  await expect(broker.completeLink(code, state, 'acct-1')).rejects.toMatchObject({ status: 400 });
});

test('tokens are only issued for the pod bound to the link', async() => {
  const { broker } = setup();
  const a = await link(broker, 'acct-1', 'alice');
  const b = await link(broker, 'acct-2', 'bob');
  broker.bindPod('https://pod.test/alice/', a.linkId, 'acct-1');
  await expect(broker.token(b.linkId, 'https://pod.test/alice/')).rejects.toMatchObject({ status: 403 });
  expect(() => broker.bindPod('https://pod.test/x/', a.linkId, 'acct-2')).toThrow(BrokerError);
  expect(() => broker.bindPod('https://pod.test/alice/', b.linkId, 'acct-2')).toThrow(BrokerError);
});

test('concurrent requests share one refresh, and rotation is persisted', async() => {
  let clock = Date.now();
  const { broker, fake } = setup(() => clock);
  fake.strictRotation = true;
  const l = await link(broker);
  broker.bindPod('https://pod.test/alice/', l.linkId, 'acct-1');
  clock += 2 * 3600_000; // cached token expired
  const results = await Promise.all([ 1, 2, 3 ].map(() => broker.token(l.linkId, 'https://pod.test/alice/')));
  expect(fake.refreshCount).toBe(1);
  expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
  // With strict rotation, this only works if the rotated refresh token was stored.
  clock += 2 * 3600_000;
  await broker.token(l.linkId, 'https://pod.test/alice/');
  expect(fake.refreshCount).toBe(2);
});

test('invalid_grant marks the link revoked and the pod answers 410', async() => {
  let clock = Date.now();
  const { broker, fake } = setup(() => clock);
  const l = await link(broker);
  broker.bindPod('https://pod.test/alice/', l.linkId, 'acct-1');
  fake.revokeAll();
  clock += 2 * 3600_000;
  await expect(broker.token(l.linkId, 'https://pod.test/alice/')).rejects.toMatchObject({ status: 410 });
  expect(broker.links('acct-1')[0].status).toBe('revoked');
});

test('issuance is rate limited per link', async() => {
  const { broker } = setup();
  const l = await link(broker);
  broker.bindPod('https://pod.test/alice/', l.linkId, 'acct-1');
  for (let i = 0; i < 5; i++) {
    await broker.token(l.linkId, 'https://pod.test/alice/');
  }
  await expect(broker.token(l.linkId, 'https://pod.test/alice/')).rejects.toMatchObject({ status: 429 });
});

test('unlink revokes, shreds the key, and keeps the pod offline rather than unbound', async() => {
  const { broker, dbPath } = setup();
  const l = await link(broker);
  broker.bindPod('https://pod.test/alice/', l.linkId, 'acct-1');
  await expect(broker.unlink(l.linkId, 'acct-2')).rejects.toMatchObject({ status: 404 });
  expect(await broker.unlink(l.linkId, 'acct-1')).toEqual({ provider: 'fake', revokedAtProvider: 'revoked' });
  const raw = new Database(dbPath).query('SELECT wrapped_dek, sealed_refresh FROM links').get() as Record<string, unknown>;
  expect(raw).toEqual({ wrapped_dek: null, sealed_refresh: null });
  await expect(broker.token(l.linkId, 'https://pod.test/alice/')).rejects.toMatchObject({ status: 410 });
  expect(broker.pods()).toHaveLength(1);
});

test('relinking the same provider account reuses the link', async() => {
  const { broker } = setup();
  const a = await link(broker);
  const b = await link(broker);
  expect(b.linkId).toBe(a.linkId);
  expect(broker.links('acct-1')).toHaveLength(1);
});

test('private mode: pushed tokens keep the pod online, nothing long-lived is stored, and it goes offline', async() => {
  let clock = 1_000_000;
  const { broker, fake, dbPath } = setup(() => clock);
  // The browser signs in by itself; the broker only sees the access token.
  const browser = await fake.publicToken(new URLSearchParams({ grant_type: 'authorization_code', code: 'fake-code.carol', code_verifier: 'v' }));
  const l = await broker.pushSessionToken('acct-3', 'fake', browser.accessToken, 600);
  expect(l.mode).toBe('session');
  expect(l.onlineUntil).toBeDefined();
  broker.bindPod('https://pod.test/carol/', l.linkId, 'acct-3');
  const t = await broker.token(l.linkId, 'https://pod.test/carol/');
  expect(t.accessToken).toBe(browser.accessToken);
  const raw = JSON.stringify(new Database(dbPath).query('SELECT * FROM links').all());
  expect(raw).not.toContain('fake-rt.');
  expect(raw).not.toContain('fake-at.');
  // A second push for the same drive reuses the link.
  const again = await broker.pushSessionToken('acct-3', 'fake', `fake-at.carol.${'b'.repeat(16)}`, 600);
  expect(again.linkId).toBe(l.linkId);
  // The owner closes the page: once the token runs out, the pod is offline (503), not disconnected.
  clock += 600_000;
  const offline = await broker.token(l.linkId, 'https://pod.test/carol/').catch((e: BrokerError) => e);
  expect((offline as BrokerError).status).toBe(503);
  expect(broker.links('acct-3')[0].onlineUntil).toBeUndefined();
  expect(fake.refreshCount).toBe(0);
});

test('private mode: a token the provider does not recognise is refused, and expiry claims are capped', async() => {
  let clock = 1_000_000;
  const { broker } = setup(() => clock);
  await expect(broker.pushSessionToken('acct-4', 'fake', 'not-a-token', 600)).rejects.toThrow('didn');
  const l = await broker.pushSessionToken('acct-4', 'fake', 'fake-at.dave.x', 10 * 24 * 3600);
  broker.bindPod('https://pod.test/dave/', l.linkId, 'acct-4');
  clock += 3 * 3600_000;
  await expect(broker.token(l.linkId, 'https://pod.test/dave/')).rejects.toThrow('private mode');
});
