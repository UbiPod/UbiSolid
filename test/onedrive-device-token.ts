// Gets a OneDrive app-folder access token with the device-code flow (public client), for adapter tests.
// Prints the code to enter, then the token on the last line of stdout.
const clientId = process.env.MS_CLIENT_ID ?? '23e3f27c-6240-4e17-9ad9-46a8f83201ab';
const authority = `https://login.microsoftonline.com/${process.env.MS_AUTHORITY ?? 'consumers'}/oauth2/v2.0`;
const scope = 'Files.ReadWrite.AppFolder offline_access';
const dc = await (await fetch(`${authority}/devicecode`, {
  method: 'POST',
  body: new URLSearchParams({ client_id: clientId, scope }),
})).json() as Record<string, any>;
if (!dc.device_code) {
  console.error(dc);
  process.exit(1);
}
console.error(`CODE ${dc.user_code} at ${dc.verification_uri}`);
for (;;) {
  await Bun.sleep((dc.interval ?? 5) * 1000);
  const res = await fetch(`${authority}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code }),
  });
  const body = await res.json() as Record<string, any>;
  if (body.access_token) {
    console.log(body.access_token);
    process.exit(0);
  }
  if (body.error !== 'authorization_pending' && body.error !== 'slow_down') {
    console.error(body);
    process.exit(1);
  }
}
