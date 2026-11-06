# OneDrive app-folder POC

Checks the OneDrive open questions in the "BYO-Storage Solid Pods on CSS" design against a real personal Microsoft account:

- **Q1:** Does `Files.ReadWrite.AppFolder` work for personal accounts, and does it really block the rest of the drive?
- **Q2:** Does `PUT …/content` honour `If-Match`? Also tested: a stale cTag, `If-None-Match: *`, `conflictBehavior=fail`, and a stale-eTag `DELETE`.
- **Q3:** Refresh-token rotation. Is a new refresh token returned, and does the old one still work?
- **Q4:** Does `delta` (the change feed) work on the app folder?

## Setup (one time)

1. Go to https://entra.microsoft.com, then **App registrations**, then **New registration**.
   - Name: what users will see. The app folder becomes `Apps/<name>`.
   - Supported account types: **Personal Microsoft accounts only**.
   - Redirect URI: leave it empty.
2. Open **Authentication**, then **Advanced settings**, and set **Allow public client flows** to **Yes**. This is needed for the device-code sign-in.
3. Copy the **Application (client) ID**. It is not a secret.

## Run

```
MS_CLIENT_ID=<client id> MS_AUTHORITY=consumers bun poc.ts   # personal-accounts-only registration
MS_CLIENT_ID=<client id> MS_AUTHORITY=organizations bun poc.ts   # work/school accounts
```

The authority defaults to `common`. A registration that accepts only personal accounts must use `consumers`.

If sign-in fails with `AADSTS70002 ... must be marked as 'mobile'`, set "Allow public client flows" to Yes. If it still fails, add the "Mobile and desktop applications" platform as well.

Results from 2026-11-06 are in [RESULTS.md](RESULTS.md).

Sign in at the printed URL with the code it shows, using a personal Microsoft account. The results are printed and also written to `results.json`. Tokens stay in memory only. The test files go in `Apps/<name>/poc-<timestamp>/` and are deleted at the end.

The device-code flow uses a public client. The production broker would be a confidential web client. Scope behaviour, conditional writes and rotation don't depend on which flow you use, but the refresh-token lifetime for public clients may differ.
