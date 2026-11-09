import {
  ConflictHttpError,
  ForbiddenHttpError,
  NotFoundHttpError,
  PreconditionFailedHttpError,
} from '@solid/community-server';
import { InsufficientStorageHttpError, StorageUnavailableHttpError } from '../CloudFs';

/** Thrown on 401 so the accessor can drop its cached token and retry once. */
export class TokenRejectedError extends Error {}

const DEBUG = Boolean(process.env.CLOUD_DEBUG);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with the provider error handling the design asks for:
 * 429 and 503 are retried once (honouring Retry-After up to 10 s), then become 503;
 * 401 becomes TokenRejectedError; 507 becomes 507.
 * Other statuses are returned for the adapter to interpret.
 */
export async function providerFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    const started = Date.now();
    try {
      res = await fetch(url, init);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = `${(error as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ''}`;
      if (DEBUG) {
        process.stderr.write(`[cloud] ${label} ${init.method ?? 'GET'} ${new URL(url).pathname} failed after ${Date.now() - started}ms: ${detail}\n`);
      }
      // Network failures happen before the provider acts on the request, or on an idempotent
      // request (reads, If-Match writes, deletes), so one retry is safe.
      if (attempt === 0) {
        continue;
      }
      throw new StorageUnavailableHttpError(`${label}: ${detail}`, { cause: error });
    }
    if (DEBUG) {
      // Path only: query strings and bodies may carry tokens.
      process.stderr.write(`[cloud] ${label} ${init.method ?? 'GET'} ${new URL(url).pathname} ${res.status} ${Date.now() - started}ms\n`);
    }
    if (res.status === 401) {
      throw new TokenRejectedError(`${label}: access token rejected`);
    }
    if (res.status === 507) {
      throw new InsufficientStorageHttpError();
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? 1), 10);
      // Bodies are always buffers or strings here, never streams, so a retry can resend them.
      if (attempt === 0) {
        await res.body?.cancel();
        await sleep(wait * 1000);
        continue;
      }
      throw new StorageUnavailableHttpError(`${label}: the provider is throttling requests.`);
    }
    return res;
  }
}

/** Maps a leftover non-2xx response onto a Solid status code. */
export async function failure(res: Response, label: string): Promise<never> {
  const text = await res.text().catch(() => '');
  const detail = `${label}: ${res.status} ${text.slice(0, 300)}`;
  switch (res.status) {
    case 403: throw new ForbiddenHttpError(detail);
    case 404: throw new NotFoundHttpError(detail);
    case 409: throw new ConflictHttpError(detail);
    case 412: throw new PreconditionFailedHttpError(detail);
    default: throw new StorageUnavailableHttpError(detail);
  }
}
