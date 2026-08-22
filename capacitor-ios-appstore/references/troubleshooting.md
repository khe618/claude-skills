# Troubleshooting: Capacitor iOS on Codemagic

Errors in roughly the order you hit them as the pipeline gets further each
build. Each is a real failure observed setting up a Capacitor 8 / SPM app on a
fresh individual Apple account. Find your error message, apply the fix, re-run.

General approach: **treat the first several builds as a smoke test.** Each build
fails one step further than the last. Read the log of the *failing* step (and
the step just before it) rather than guessing — the signing failures in
particular only make sense when you read the step that was supposed to create
the profile.

---

## "Your Apple Developer Program membership has expired" / org account

Symptom: the account is under an old employer's organization, "Account Holder
X must renew," and the user can't remove themselves or enroll individually
("still says I am part of the old organization").

Cause: their Apple ID was invited as a *member* of an org they no longer
control; a member can't remove themselves and the ID stays claimed.

Fix: this needs **Apple Developer Support** to detach the Apple ID from the
defunct org, after which Individual enrollment works. Not self-serve. Out of
scope for the build, but blocks everything until resolved.

---

## App Store Connect "New App": bundle ID dropdown is empty

Cause: the bundle ID isn't registered in the Developer portal yet. App Store
Connect only lists registered App IDs.

Fix: register it first at developer.apple.com → Identifiers → Register an App ID
→ App IDs → App → Explicit = your `appId`. Then reload the New App form.
(Apple's portal deep-links error and pages load slowly — navigate from the
Identifiers list and be patient.)

## App Store Connect "New App": "The app name you entered is already being used"

Cause: store display names are globally unique and common ones are taken.

Fix: use a distinctive multi-word or coined name. It's only the public title —
editable until first release, independent of the bundle ID and in-app name.

---

## `[fatal] The Capacitor CLI requires NodeJS >=22.0.0`

Cause: `node:` in codemagic.yaml is too low for the app's Capacitor version.

Fix: set `node: 22` (or match the Capacitor major). Capacitor 8 needs ≥22.

## `App Store Connect integration "<name>" does not exist`

Cause: the `integrations.app_store_connect` name in the YAML doesn't match the
API-key integration name in Codemagic (capitalization/spaces matter).

Fix: make them identical. Easiest is to edit the YAML to whatever the user named
the key in Codemagic → Team settings → Integrations → App Store Connect.

---

## `"App" requires a provisioning profile` (at the archive/Build IPA step)

Cause: no provisioning profile got applied to the target. The archive command
shows `CODE_SIGN_STYLE=Manual` with no profile specifier — because the signing
step upstream produced nothing to apply. Read the "Set up code signing" step to
see why (usually one of the next two).

## `No matching profiles found ... distribution type "app_store"`

Cause: the automatic `environment.ios_signing` block only *fetches* existing
profiles, and a fresh account has none.

Fix: don't use the automatic block. Use the explicit script in the template:
`fetch-signing-files ... --create` + `use-profiles`. (Then you may hit the next
one.)

## `Cannot save Signing Certificates without certificate private key`

Cause (the crux): `fetch-signing-files --create` can create the *profile* but
cannot create the distribution *certificate* without a private key to tie it to,
and a fresh account has no certificate. So it creates nothing usable →
"Did not find any certificates" → "Did not find matching provisioning profiles".

Fix:
1. `openssl genrsa -out cert_key.pem 2048` (outside the repo; never commit).
2. Add its full PEM as a **secure** Codemagic variable `CERTIFICATE_PRIVATE_KEY`
   in a variable group `ios_signing`.
3. YAML: `environment.groups: [ios_signing]` and pass
   `--certificate-key @env:CERTIFICATE_PRIVATE_KEY` to `fetch-signing-files
   --create`.
It creates the cert+profile once and reuses them thereafter.

## `403` / `FORBIDDEN` while creating certificate or profile

Cause: the App Store Connect API key's role can't manage Certificates,
Identifiers & Profiles. (Note: "App Manager" was confirmed *sufficient* in
practice once a private key was supplied — try it first.)

Fix: regenerate the API key with **Admin** role, re-add it in Codemagic under
the same integration name, re-run.

---

## `Complete test information is required ... for external testing`

(Build uploaded and processed fine — this is only the final submit step.)

Cause: `submit_to_testflight: true` submits for EXTERNAL beta review, which
requires Beta App Info (feedback email) + Beta App Review contact info.

Fix: for internal testing (fastest, no review), set `submit_to_testflight:
false` — the build still uploads and is auto-available to internal testers after
processing. For external, fill the test info in App Store Connect → TestFlight →
Test Information, then set it back to `true` and add external `beta_groups`.

---

## App builds and installs but can't connect / is broken in TestFlight

Cause: the app is still pointed at `localhost` (or a dev-only host). A shipped
app has no local server.

Fix: this should have been caught in Phase 1 prerequisites — the native build
must target a public HTTPS/WSS backend. Grep the client for its host selection
(`location.host`, a hardcoded `SERVER_HOST`, `wss://`) and confirm the
Capacitor/native path uses the production URL. Re-verify on device via
TestFlight after fixing.
