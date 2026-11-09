# Deploying

## Images

```
docker build -t ubisolid-broker:0.1.0 packages/broker
docker build -f deploy/css/Dockerfile -t ubisolid-css:0.1.0 .
```

`ubisolid-css` is CSS 7.3 with [css-invites](https://www.npmjs.com/package/css-invites) from npm and `css-cloud-storage` from this repo. The config it runs is `deploy/css/config.json`.

## Test locally (no provider accounts needed)

```
mkdir -p .test-data/fake-cloud
docker compose -f deploy/compose.test.yaml up -d
bun test/e2e.ts                               # 37 checks, using the broker's fake provider
bun test/adapter-conformance.ts fake          # the CloudFs contract
docker compose -f deploy/compose.test.yaml down
```

The fake provider stores each user's "app folder" in `.test-data/fake-cloud/<user>/`, so you can watch the pod files appear.

## Register the providers

The redirect URI for every provider is `<CSS_BASE_URL>.account/storage/callback/`, for example `https://pod.mhciael.com/.account/storage/callback/`.

- **OneDrive (Entra app registration).**
  - Under Authentication, add a **Web** platform with the redirect URI.
  - Under Certificates & secrets, add a client secret and use it as `ONEDRIVE_CLIENT_SECRET`.
  - Under API permissions, add Microsoft Graph delegated `Files.ReadWrite.AppFolder`, `offline_access`, `openid` and `email`.
  - Set `ONEDRIVE_TENANT=consumers` for personal accounts only, or `common` once work accounts are approved.
- **Dropbox.** Create a Scoped App with *App folder* access. Grant the permissions `account_info.read`, `files.metadata.read`, `files.metadata.write`, `files.content.read` and `files.content.write`. Add the redirect URI. The app key and secret go in `DROPBOX_CLIENT_ID` and `DROPBOX_CLIENT_SECRET`.
- **Google.** Create an OAuth client of type *Web application* with the redirect URI. The scopes are `openid email https://www.googleapis.com/auth/drive.file`. While the consent screen is in Testing, refresh tokens die after 7 days.

## Run

Copy `.env.example` to `.env` next to `compose.yaml` and fill it in. Then `docker compose up -d` and proxy `ubisolid-css:3000` in Nginx Proxy Manager, with websockets on.

The broker publishes no ports. Back up `broker-data/` and `css-data/`. With a local master key, keep the key out of the `broker-data` backups, or the backups hold everything needed to use the refresh tokens.
