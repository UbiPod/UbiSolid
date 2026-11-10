# UbiSolid

Solid pods for everyone, with files stored in the cloud storage people already have (Google Drive, Dropbox, OneDrive).

- [Design: BYO-storage pods on the Community Solid Server, with a token broker](docs/token-broker-design.md)
- [For institutions: one review instead of one per app?](docs/for-institutions.md)
- [OneDrive app-folder POC](poc/onedrive-appfolder/) and its [results](poc/onedrive-appfolder/RESULTS.md)

## Code

- [`packages/css-cloud-storage`](packages/css-cloud-storage/): the CSS 7.3 plugin. It provides `CloudDataAccessor`, OneDrive, Dropbox and Google Drive adapters, the *Connected storage* account page, and pod creation in linked storage.
- [`packages/broker`](packages/broker/): the token broker. It uses envelope-encrypted refresh tokens, single-flight refresh with rotation, and only an internal API.
- [`deploy/`](deploy/): Docker images, a test stack, the production compose file and provider registration notes.
- [`test/`](test/): `e2e.ts` (47 checks against the test stack, private mode included), `e2e-tenant.ts` (24 checks of tenant mode against `mock-graph.ts`, a stand-in for Entra and Graph), and `adapter-conformance.ts` (the storage contract, run against the fake provider or a real one).

