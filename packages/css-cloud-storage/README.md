# css-cloud-storage

A [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) 7.3 plugin that keeps a pod's files in its owner's OneDrive, Dropbox or Google Drive, inside an app-only folder. Everything that isn't a linked pod stays on local disk: the server root, `/.internal/` (accounts, OIDC keys) and ordinary pods.

CSS never holds a refresh token. It asks the UbiSolid [token broker](../broker/) for an hour-long access token per pod and keeps it in memory. See the [design](../../docs/token-broker-design.md).

## What it adds

- **`CloudDataAccessor`** replaces the `FileDataAccessor` in CSS's backend store. It mirrors `FileDataAccessor` operation by operation and uses the same layout: `$.ext` suffixes, `.meta` and `.acl` files. So a pod folder downloaded from the provider can be served by a plain CSS with `-f`.
- **Adapters** for OneDrive (Microsoft Graph, `approot`), Dropbox (App folder) and Google Drive (`drive.file`, under a `UbiSolid` folder). There is also `LocalFolderAdapter`, which stands in for a provider in tests.
- **Connected storage page** at `/.account/account/<id>/storage/`. It is linked from the account page and has Connect and Disconnect buttons. The JSON API on the same URL is `GET` → `{ providers, links }`, and `POST` with `{ provider }`, `{ code, state }` or `{ unlink }`.
- **OAuth callback page** at `/.account/storage/callback/`. Register exactly this URL with each provider. The page posts `code` and `state` to the API with the visitor's own session, and the broker refuses to finish a link started by a different account.
- **Pod creation in linked storage.** The create-pod page gains a *Storage* choice, which sends `settings.linkId`. `CloudPodCreator` binds the pod to the link before CSS writes the starter files, so they land in the cloud.
- **Private mode** (opt-in), at `/.account/storage/session/`. The owner's browser signs in to the provider itself, as a single-page app with PKCE, and keeps the refresh token in memory. It hands the server a fresh access token every hour. The server stores no token for these links, so their pods are online only while the owner has the page open, plus up to an hour. Register this URL under *Single-page application* with Microsoft. It needs a secure page (https, or localhost). OneDrive and the test provider support it. See [the alternatives](../../docs/for-institutions.md#alternatives-that-reduce-the-concentrated-risk).
- **Tenant mode** (prototype): `OneDriveTenantAdapter` addresses `/drives/{driveId}/items/{folderId}`, which the broker returns with each token. A tenant link shows as *waiting for your institution* until the provisioning job has granted the folder. `TENANT_GRAPH_URL` points it at a mock.
- **503 for disconnected storage.** `StorageStatusModesExtractor` answers 503 before authorization runs. Otherwise CSS's permission readers swallow the storage error and the owner sees 401 or 403.

## Configure

Import the plugin's config after a stock CSS config:

```json
{
  "@context": "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld",
  "import": [
    "css:config/file.json",
    "https://linkedsoftwaredependencies.org/bundles/npm/css-cloud-storage/^0.1.0/config/cloud-storage.json"
  ]
}
```

Set these environment variables:

| Variable | |
| --- | --- |
| `BROKER_URL` | e.g. `http://ubisolid-broker:8600` |
| `BROKER_SERVICE_KEY` | the shared secret the broker expects |
| `FAKE_STORAGE_DIR` | tests only: enables `LocalFolderAdapter` |

It works alongside [css-invites](https://github.com/UbiPod/css-invites). See `deploy/css/` for a combined image.

## Limits (0.1)

- Uploads are buffered in memory, up to 100 MB (`maxUploadMb`). Chunked upload sessions are not implemented.
- Conditional requests are checked by CSS against `getMetadata`, inside CSS's lock. The provider version isn't passed to the write yet (upstream change 1 in the design), so an edit made directly in OneDrive or Dropbox between the check and the write can be overwritten. The adapters do support `ifVersion`.
- Every request makes a few provider calls (`stat`, the `.meta` file, the write). Nothing is cached apart from Drive's path-to-ID map.
- Pods must be path-based (`/name/`), which is CSS's default. Subdomain pods aren't handled by `PodLinkIndex.isServerLocal`.
- Edits made directly in the provider don't trigger Solid notifications.
- The OneDrive adapter passes `test/adapter-conformance.ts` (15 checks) against a personal OneDrive. The Dropbox and Google Drive adapters follow the API docs but haven't been run against the real service.
