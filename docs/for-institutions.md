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

## Alternatives that reduce the concentrated risk

The risk above comes from one service holding a long-lived Microsoft grant for every user. Three designs change who holds that grant. They suit different accounts, so UbiSolid offers all three.

**Not an alternative: PKCE alone.** The broker already uses PKCE on every sign-in. PKCE protects the authorization code on its way back from Microsoft; it does nothing for tokens once they're stored. Dropping the client secret, so that the broker runs as a "PKCE-only" public client, would make things worse. A copy of the token database would then be enough to mint access tokens. With a secret, an attacker also needs the secret.

### 1. Stored grant (the default, for personal accounts)

The broker keeps the refresh token, sealed with a per-user key that Cloud KMS wraps. Pods are always online, and other people's apps can read what the owner shared even while the owner is away. The risk is the one described above. Limits on the damage:

- the app-folder scope, so a breach exposes the UbiSolid folder, not the whole drive
- the KMS key, which only the broker can use
- no public endpoint on the broker
- hour-long, per-pod access tokens in CSS

### 2. Private mode (opt-in): the browser holds the grant

The owner's browser signs in to Microsoft itself, as a single-page app with PKCE. It keeps the refresh token in memory, and each hour it hands the server a fresh access token. The server never sees a refresh token, so there is nothing long-lived to steal from it. A copy of its disk gets nothing at all, and a server compromised while running gets an hour of access to the pods whose owners are online at the time.

The trade-off is availability. The pod is online only while the owner has the private-mode page open, plus up to an hour after they close it. Microsoft caps refresh tokens for single-page apps at 24 hours, so owners sign in at least daily. It suits people who use their pod only themselves, or who want to know their data can't be reached while they're away. One known weakness: CSS serves pod content from the same origin as its account pages, so a malicious HTML page in another pod, opened in the same browser, could reach the private-mode page's tokens. Serving that page from its own origin would close the gap, but the prototype doesn't do that yet.

### 3. Tenant mode (for an institution's own accounts): no user grants at all

For work and school accounts, Microsoft Graph has an app-only permission, `Files.SelectedOperations.Selected`. By itself it grants nothing. An administrator then gives the app a role on specific folders, and a grant on a folder covers the files inside it ([Microsoft Learn](https://learn.microsoft.com/graph/permissions-selected-overview)). In tenant mode:

- **The broker signs in as itself,** with a certificate whose private key stays in KMS or an HSM. It stores no user tokens.
- **A separate provisioning job creates each user's UbiSolid folder and grants the broker access to it.** This job needs broad SharePoint rights, so it runs apart from the broker, with its own tightly held credential, and only processes requests the broker queues.
- **The institution can see and control everything in its own tenant.** It can list every grant, apply Conditional Access for workload identities, rotate the certificate, and revoke one folder or all of them.

This doesn't remove concentration completely. One app credential reaches every granted folder, and the access token CSS holds during an hour also reaches every granted folder, not just one pod's. But the credential belongs to the institution and is audited in its own tenant, rather than being a database of user grants run by an app. It only works for an organization's own tenant, not for personal accounts. The prototype is tested against a mock of Graph. The exact grant request (Microsoft's docs show the older `grantedTo` property) and the confinement have not been checked against a real tenant.

### Summary

| | Stored grant | Private mode | Tenant mode |
| --- | --- | --- | --- |
| Long-lived secret on the server | Every user's refresh token (sealed) | None | One app certificate (in KMS/HSM) |
| A copy of the server's disk gives | Nothing without the KMS key and client secret | Nothing | Nothing without the certificate key |
| A compromise of the running server gives | Every pod's folder, for as long as it lasts | Online owners' pods, for an hour | Every granted folder, for as long as it lasts |
| Pod availability | Always | While the owner's page is open, plus up to an hour | Always |
| Accounts | Personal and work | Personal and work (needs a single-page-app redirect URI) | The institution's tenant only |
| Who can revoke | User, at the provider; operator, by unlinking | User, by closing the page | IT, centrally, per folder or all at once |

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
