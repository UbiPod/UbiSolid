# UbiSolid token broker

A small Bun service (SQLite, no dependencies) that holds the long-lived provider grants for cloud-backed pods. It gives CSS one short-lived access token at a time. It is the only process that can decrypt a refresh token, and it has no public routes. See the [design](../../docs/token-broker-design.md).

- **Envelope encryption.** Each link has its own random 256-bit data key, wrapped by Cloud KMS (`BROKER_KMS_KEY`) or, in development, a local master key. The refresh token is sealed with AES-256-GCM under that data key, with the link ID as associated data.
- **Refresh rules.**
  - Access tokens are kept in memory only.
  - One refresh runs at a time per link.
  - Rotated refresh tokens are persisted with a compare-and-swap on `version` before the new access token is released.
  - `invalid_grant` marks the link `revoked`, and its pods then return 503.
  - Issuance is capped at 120 per link per hour.
  - A daily job refreshes Google links idle for 30 days.
- **Binding.** A token is issued only for a pod bound to that link. A link request is tied to the CSS account that started it, and is single use and valid for 10 minutes.
- **Unlink.** The broker revokes at the provider first, then crypto-shreds the link by deleting the wrapped key and the sealed token. The row stays as `revoked`, so its pods answer 503 rather than reappearing empty.

## API (internal; `Authorization: Bearer $BROKER_SERVICE_KEY`)

| | |
| --- | --- |
| `GET /providers` | configured providers |
| `POST /links {provider, accountId}` | `{authorizeUrl}` |
| `POST /callback {code, state, accountId}` | `{link}` |
| `POST /links/{id}/token {podBase}` | `{accessToken, expiresAt, provider, root}` |
| `GET /links?accountId=` | the account's links |
| `DELETE /links/{id}?accountId=` | revoke and shred |
| `GET /pods`, `PUT /pods {podBase, linkId, accountId}`, `DELETE /pods {podBase, accountId}` | pod bindings |
| `POST /session/config {provider}` | private mode: endpoints, client ID and redirect URI for the browser's own sign-in |
| `POST /session/push {provider, accountId, accessToken, expiresIn}` | private mode: an access token from the owner's browser. The provider confirms whose it is; it's kept in memory only, for at most 2 hours |
| `GET /healthz` | no auth |

## Environment

`BROKER_SERVICE_KEY` (at least 32 characters), `BROKER_REDIRECT_URI`, `BROKER_KMS_KEY` or `BROKER_MASTER_KEY`/`BROKER_MASTER_KEY_FILE`, `BROKER_DB`, `BROKER_PORT` or `BROKER_SOCKET`. Then for each provider: `ONEDRIVE_CLIENT_ID`/`_SECRET`/`ONEDRIVE_TENANT`, `DROPBOX_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`. `BROKER_SESSION_REDIRECT_URI` (private mode; defaults to the redirect URI with `callback/` replaced by `session/`). `BROKER_FAKE_PROVIDER=1` enables the test provider, including its browser-facing `/fake/authorize` and `/fake/token` routes (`BROKER_FAKE_PUBLIC_URL`, default `http://localhost:3997`); never set it in production.

The client secrets are optional. Without one, the provider is used as a public PKCE client. That works for Dropbox, and for a Microsoft app whose redirect URI is registered as a public client, but it weakens the design: a stolen refresh token could then be used without the secret.

```
bun test        # 10 unit tests: binding, single use state, single-flight refresh, rotation, invalid_grant, rate limit, unlink, private mode
```

`GcpKmsKeyWrapper` hasn't been run against Cloud KMS yet.
