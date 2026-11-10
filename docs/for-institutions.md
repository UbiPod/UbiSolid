# UbiSolid for institutions: one review instead of one per app?

Nov 10, 2026 · Michael Stewart

A university already has a way to let an app use OneDrive: the app registers with Microsoft, asks for Graph permissions, and IT reviews the request before anyone can consent. At JMU that review is a Technology Solution Request. This page asks whether running UbiSolid is a better arrangement than reviewing each app on its own. The answer is "sometimes", and the cases where it isn't are spelled out below.

## The two arrangements

**Per-app review (today).** Each app that wants to read or write files talks to Microsoft Graph directly, with its own app registration and its own permission request. Typical requests are `Files.ReadWrite` or `Files.ReadWrite.All`, which cover the user's whole OneDrive and often more. Where the tenant doesn't let users consent on their own, an admin has to approve each app. With ten apps, there are ten registrations, ten consent grants, ten sets of refresh tokens held by ten vendors, and ten reviews.

**UbiSolid.** One app, the UbiSolid token broker, is registered with Microsoft. It asks only for `Files.ReadWrite.AppFolder`, which is confined to a single folder in each user's OneDrive. Each user connects their OneDrive once and gets a Solid pod whose files live in that folder. Apps never talk to Microsoft. They speak the Solid protocol to the pod, and the user decides with Solid access controls which app can read or write which resource.

| | Per-app review | UbiSolid |
| --- | --- | --- |
| Microsoft app registrations IT approves | One per app | One, the broker |
| Graph scope granted | Whatever each app asks for, often the whole drive | App folder only. Verified on personal accounts; not yet on OneDrive for Business |
| Who holds Microsoft refresh tokens | Every app vendor | The broker only, encrypted under a key the institution controls |
| What an app can reach if it's compromised | Its full Graph scope | The pod resources its user granted it |
| Where the files are | In OneDrive, wherever each app puts them | In OneDrive, in the app folder |
| Turning off one app | Revoke its consent in Entra ID, for everyone at once | Each user, in their pod's access controls. Singling out one app needs Access Control Policies (see below). There's no server-wide block list yet |
| Turning off everything | Revoke each app | Revoke the broker's one enterprise app |
| Who reviews a new app | IT, before anyone can use it | No one at the Microsoft layer; the user grants pod access |

## What UbiSolid improves

- **Review effort scales with one system, not with the number of apps.** The broker and the pod server need one careful review. After that, a course tool, a student project or a research prototype that only needs to store data doesn't need its own Graph permission request.
- **The Microsoft scope is as narrow as Graph allows.** `Files.ReadWrite.AppFolder` can't see the rest of the drive, mail, Teams or SharePoint. The [OneDrive POC](../poc/onedrive-appfolder/RESULTS.md) checked this on personal accounts: the drive root, other apps' folders, writes outside the folder and search were all refused.
- **Third parties never get Microsoft tokens.** Today, each approved app's vendor stores long-lived refresh tokens for institutional accounts. With UbiSolid, apps get only Solid credentials for a pod. The Microsoft grant stays in the broker. It's sealed with a per-user key that Cloud KMS wraps (or a local key), and it's never sent to CSS or to any app.
- **One off switch.** Revoking the broker's enterprise app in Entra ID cuts every pod off from OneDrive at once. Pods then answer 503; they don't fall back to some other copy of the data.
- **The data stays in OneDrive.** Pod files are ordinary files in the user's OneDrive, so they stay under the tenant's storage, retention and legal-hold settings, as other OneDrive content does. Whether a given compliance tool (DLP rules, sensitivity labels) handles `.ttl` and `.meta` files usefully has not been checked.
- **Data outlives apps.** Data is stored in open formats in a standard layout, so a new app can use what an old one wrote. If UbiSolid itself goes away, a plain CSS pointed at the downloaded folder serves the same pod.

## What it doesn't solve, and what it adds

- **It moves the review rather than removing it.** IT no longer sees each app at the Microsoft layer. Any Solid app a user trusts can read whatever that user grants it in their pod. If policy says every app that touches a certain class of data (for example, FERPA-covered records) must be reviewed, that policy still applies. UbiSolid only changes where the control sits: in pod access controls, not in Entra ID consent. An institution can respond with rules about what may be stored in pods, not only with app reviews.
- **Per-app limits in Solid are weaker than in Entra ID today.** CSS's default authorization, Web Access Control, grants access to people (WebIDs), not to particular apps. Access Control Policies can also restrict by client app, and CSS supports them, but this deployment doesn't turn them on yet. Until it does, granting access to "me" means any app I sign in to can use that access.
- **It concentrates risk.** The broker holds the refresh tokens for every connected user, and the pod server can read every pod's folder. That replaces many smaller vendor risks with one larger one that the institution operates. The design limits the damage: tokens are encrypted under KMS, the broker has no public endpoint, CSS only ever holds hour-long access tokens, and each token is issued for one pod. But the service needs to be run, patched and monitored like any other service holding credentials.
- **It only covers data the apps create.** UbiSolid apps can't open a user's existing Word documents or class folders, because the app-folder scope can't see them. An app whose job is to work on existing OneDrive content needs its own Graph access, and its own review.
- **It's slower than talking to Graph directly.** Each Solid request becomes one or more Graph calls, and every call is a network round trip of about a second. With caching, a cold read takes 1.5–4 seconds and a repeat read takes milliseconds. Creating a pod takes 15–35 seconds. That's fine for documents and settings, but not for anything chatty.
- **It's new.** This is version 0.1: one person's implementation, with no independent security review. It has been tested against personal OneDrive accounts only. Whether `Files.ReadWrite.AppFolder` confines an app the same way on OneDrive for Business is an [open question](token-broker-design.md#open-questions) that needs a JMU test app.

## When each is the better choice

UbiSolid fits when:

- many small apps, such as class projects, research prototypes or student-built tools, need somewhere to keep each user's own data
- that data belongs to the user, not to the institution
- the apps don't need anything else from Microsoft 365
- the institution prefers to review one storage service once rather than review storage access app by app

Per-app review is still the right path when:

- the app needs existing OneDrive or SharePoint content, mail, calendars or Teams
- the data is institutional records, or data whose policy requires each app that handles it to be approved
- there are only a few apps, and each comes from a vendor that is reviewed anyway
- the app needs speed or features that a Solid pod over OneDrive can't give it

## Questions a reviewer should ask about UbiSolid

1. **Hosting.** Where do the broker and the pod server run, and who operates them? Who can read the broker's database, and who can use its KMS key?
2. **Tenant.** Which Entra tenant and which account types does the app registration accept? Is the app folder confined on this tenant, rather than only on personal accounts? Rerun the POC with `MS_AUTHORITY=organizations` to check.
3. **Data.** What data classes may users put in pods? What tells them?
4. **Sign-up.** Who can create a pod? The test deployment is invite-only, using [css-invites](https://github.com/UbiPod/css-invites).
5. **Logs.** What do the logs keep, and for how long? At present CSS logs the full OAuth callback URL. The code in it is single-use and already redeemed by then, but it should still be redacted.
6. **Offboarding.** What happens when someone leaves? Disconnecting revokes the grant and takes the pod offline. The files stay in their OneDrive, under the tenant's usual offboarding rules.
7. **App access.** Will per-app restrictions (Access Control Policies) be required before launch?

## Bottom line

For the common case of many small apps that each just need to store a user's own data, UbiSolid is likely the better arrangement. IT reviews one narrowly scoped integration, instead of a stream of requests for broad Graph access by vendors who would each hold long-lived tokens. It isn't a way to skip review for apps that handle institutional data or need the rest of Microsoft 365. It also needs its own review first, including the OneDrive for Business confinement test that hasn't been run yet.
