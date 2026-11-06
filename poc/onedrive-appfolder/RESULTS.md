# OneDrive app-folder POC: results

Two runs on 2026-11-06 against a personal Microsoft account. The app registration was "Personal Microsoft accounts only", sign-in used the device-code flow, the scope was `Files.ReadWrite.AppFolder offline_access`, and the app folder was `Apps/BYODB`. Raw output is in `results-2026-11-06-run1.json` and `results-2026-11-06-run2.json`.

| Question | Result |
| --- | --- |
| Does `Files.ReadWrite.AppFolder` work on personal accounts? | **Yes.** The scope was granted, and `/me/drive/special/approot` returned 200. |
| Is the app really confined to its folder? | **Yes.** The drive root listing returned 200 with 0 items, `Apps/` returned 404, a write at the drive root returned 404 and wrote nothing, and search returned 401. A leaked token exposes only `Apps/<app>/`. |
| Does `PUT …/content` honour `If-Match`? | **Yes.** A stale eTag or cTag got 412 (`notAllowed`), and the content was left unchanged. A matching eTag got 200. |
| Does `DELETE` honour `If-Match`? | **Yes.** A stale eTag got 412 (`resourceModified`). |
| Does `If-None-Match: *` give create-only writes? | **No.** It was ignored, and the file was overwritten (200). Use `?@microsoft.graph.conflictBehavior=fail` instead, which returned 409 `nameAlreadyExists`. |
| Does the eTag change on every content write? | Yes: `{id},1`, then `,2`, then `,3`. |
| Does the refresh token rotate? | **Yes.** Every refresh returned a new refresh token. |
| Does the old refresh token still work after rotation? | **Yes.** It was redeemed again successfully, so the broker must delete superseded tokens itself. |
| Token lifetimes | Access token about 1 hour (`expires_in=3599`). The response states no refresh-token expiry. |
| Does `delta` work on the app folder? | **Yes.** It returned 200 with a `deltaLink`. |

Notes:
- In run 1, `GET /me/drive` returned 403 straight after first consent. In run 2 it returned 200 (`driveType=personal`). Don't rely on `/me/drive` right after linking; go straight to `approot`.
- Run 2 recorded the root-write probe as FAIL because the check expected 403. The 404 is still a refusal, and the script now accepts 401, 403 or 404.
- Not tested yet: OneDrive for Business (work and school accounts), which is waiting on a JMU app registration.
