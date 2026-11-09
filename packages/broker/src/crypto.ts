import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Wraps and unwraps per-link data keys. In production this is Cloud KMS,
 * so a copy of the database is useless without the broker's KMS permission.
 */
export interface KeyWrapper {
  readonly name: string;
  wrap(dek: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

/** AES-256-GCM with associated data. Output: base64(iv | tag | ciphertext). */
export function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function open(key: Buffer, sealed: string, aad: string): Buffer {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

/**
 * Development stand-in for KMS: a 32-byte master key from a file or env var.
 * Anyone with the key file and the database can recover refresh tokens, so keep the key off the database host,
 * or use GcpKmsKeyWrapper.
 */
export class LocalKeyWrapper implements KeyWrapper {
  public readonly name = 'local';
  private readonly key: Buffer;

  public constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error('The local master key must be 32 bytes (base64 in BROKER_MASTER_KEY or BROKER_MASTER_KEY_FILE).');
    }
    this.key = key;
  }

  public static fromEnv(env: Record<string, string | undefined>): LocalKeyWrapper {
    const b64 = env.BROKER_MASTER_KEY ?? (env.BROKER_MASTER_KEY_FILE && readFileSync(env.BROKER_MASTER_KEY_FILE, 'utf8').trim());
    if (!b64) {
      throw new Error('Set BROKER_KMS_KEY (Cloud KMS) or BROKER_MASTER_KEY / BROKER_MASTER_KEY_FILE (local).');
    }
    return new LocalKeyWrapper(Buffer.from(b64, 'base64'));
  }

  public async wrap(dek: Buffer): Promise<string> {
    return `local:${seal(this.key, dek, 'dek')}`;
  }

  public async unwrap(wrapped: string): Promise<Buffer> {
    if (!wrapped.startsWith('local:')) {
      throw new Error('This data key was not wrapped by the local key wrapper.');
    }
    return open(this.key, wrapped.slice(6), 'dek');
  }
}

/**
 * Cloud KMS over REST. `keyName` is projects/P/locations/L/keyRings/R/cryptoKeys/K.
 * Credentials come from the GCE/Cloud Run metadata server, or GOOGLE_OAUTH_ACCESS_TOKEN for local testing.
 * Restrict cloudkms.cryptoKeyEncrypterDecrypter on the key to the broker's service account only.
 */
export class GcpKmsKeyWrapper implements KeyWrapper {
  public readonly name = 'gcp-kms';
  private token?: { value: string; expiresAt: number };

  public constructor(private readonly keyName: string, private readonly env: Record<string, string | undefined>) {}

  private async accessToken(): Promise<string> {
    if (this.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
      return this.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    }
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'metadata-flavor': 'Google' } },
    );
    if (!res.ok) {
      throw new Error(`Metadata server token request failed: ${res.status}`);
    }
    const body = await res.json() as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(op: 'encrypt' | 'decrypt', body: object): Promise<Record<string, string>> {
    const res = await fetch(`https://cloudkms.googleapis.com/v1/${this.keyName}:${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Cloud KMS ${op} failed: ${res.status} ${await res.text()}`);
    }
    return await res.json() as Record<string, string>;
  }

  public async wrap(dek: Buffer): Promise<string> {
    const { ciphertext } = await this.call('encrypt', { plaintext: dek.toString('base64') });
    return `kms:${ciphertext}`;
  }

  public async unwrap(wrapped: string): Promise<Buffer> {
    if (!wrapped.startsWith('kms:')) {
      throw new Error('This data key was not wrapped by Cloud KMS.');
    }
    const { plaintext } = await this.call('decrypt', { ciphertext: wrapped.slice(4) });
    return Buffer.from(plaintext, 'base64');
  }
}

export function keyWrapperFromEnv(env: Record<string, string | undefined>): KeyWrapper {
  return env.BROKER_KMS_KEY ? new GcpKmsKeyWrapper(env.BROKER_KMS_KEY, env) : LocalKeyWrapper.fromEnv(env);
}
