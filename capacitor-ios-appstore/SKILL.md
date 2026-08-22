---
name: capacitor-ios-appstore
description: >-
  End-to-end guide to ship a Capacitor (or Ionic) iOS app to the Apple App
  Store using Codemagic CI — Developer-portal bundle ID registration, App Store
  Connect app record, code signing, building on a cloud Mac, and TestFlight.
  Use this WHENEVER the user wants to build, sign, or publish a Capacitor iOS
  app, set up Codemagic for iOS, get an app onto TestFlight or the App Store, or
  is debugging iOS CI build/signing failures ("requires a provisioning
  profile", "No matching profiles found", "Cannot save Signing Certificates
  without certificate private key", missing shared scheme, "Capacitor CLI
  requires NodeJS", app name already in use). Especially relevant when the user
  is on Windows and cannot run Xcode locally.
---

# Ship a Capacitor iOS app to the App Store via Codemagic

This skill captures a full, battle-tested path from a Capacitor app to a
TestFlight build, using **Codemagic** as the cloud-Mac build service. It exists
because this journey has many non-obvious failure points, and each one costs a
full build cycle to discover. Follow the phases in order; each ends in a
checkpoint so you know it worked before moving on.

**Why Codemagic:** Apple's build+sign toolchain only runs on macOS. If the
developer is on Windows/Linux (or just doesn't want to manage a Mac), a cloud CI
with macOS runners is the standard answer. Codemagic has first-class Capacitor
support and a free tier. Everything below is Codemagic-specific.

## Prerequisites — verify these before starting

Check each one explicitly; a missing prerequisite wastes later phases.

1. **Active paid Apple Developer Program membership** ($99/yr). An expired or
   organization-member-only account will block enrollment steps. (If the user
   is stuck behind an old employer's org account, the fix is Apple Developer
   Support detaching their Apple ID — that's out of scope here.)
2. **The app is a git repo on a remote** Codemagic can read (GitHub/GitLab/
   Bitbucket). Note the remote URL.
3. **The backend is publicly hosted, not `localhost`.** A shipped app has no
   local server. Grep the client for how it picks its API/WebSocket host (e.g.
   `location.host`, a hardcoded `SERVER_HOST`, `wss://`) and confirm the native
   build points at a public HTTPS/WSS URL, not `localhost:PORT`. This is the
   single most common "works in dev, broken in the store" trap.
4. **Capacitor iOS platform already added** (`ios/` exists locally with
   `ios/App/App.xcodeproj`). If not, `npx cap add ios` first.

## Phase 1 — App Store Connect: bundle ID + app record

These live on **two different Apple sites**, which trips people up:
- **developer.apple.com** (Certificates, Identifiers & Profiles) — register the
  bundle ID here.
- **appstoreconnect.apple.com** — create the app record here.

**Order matters: register the bundle ID FIRST**, or it won't appear in the App
Store Connect "New App" dropdown.

1. Find the bundle ID in `capacitor.config.ts` (`appId`, e.g.
   `us.emojimatch.app`). This is *not* a URL you need to own — it's a
   reverse-DNS identifier, only needs to be globally unique in Apple's system.
2. **Register it:** developer.apple.com → Account → Certificates, Identifiers &
   Profiles → **Identifiers** → **Register an App ID** → **App IDs** → **App** →
   Explicit bundle ID = the `appId`, a description, no capabilities needed →
   Register. (Apple's portal is slow and deep-links error — navigate from the
   Identifiers list, not a direct `/add` URL.)
3. **Create the app record:** appstoreconnect.apple.com → Apps → **+** → **New
   App** → iOS, pick the now-listed bundle ID, primary language, a **globally
   unique app name**, and any SKU (internal-only). User Access: Full.
   - **App name collisions are common.** Plain names ("Emoji Match") are
     usually taken. If rejected with "already being used," try a distinctive
     multi-word or coined name. The store name is editable until first release
     and does NOT need to match the bundle ID or in-app name.
4. Note the numeric **App Store Connect app ID** from the URL
   (`/apps/<APP_ID>/...`) and the **Team ID** (shown top-right in the Developer
   portal) — you'll want both for the build config.

**Checkpoint:** the app record exists at "1.0 Prepare for Submission".

> Driving Apple's web UI with browser automation? The New App form is a React
> SPA where `form_input` silently no-ops — use real clicks+typing for text
> fields and focus→arrow-keys→Enter for the native `<select>` dropdowns. Its
> portal pages are also slow; wait and re-read rather than hammering.

## Phase 2 — Prepare the repo for CI

Capacitor's defaults are hostile to CI in three specific ways. Fix all three or
the build fails on the cloud Mac.

1. **Commit the `ios/` project.** Capacitor's root `.gitignore` lists `ios/`, so
   the native project isn't on the remote and Codemagic has nothing to build.
   Remove `ios/` from the root `.gitignore` (keep `node_modules/`). The nested
   `ios/.gitignore` still excludes build artifacts (`App/build`,
   `App/App/public`, generated `capacitor.config.json`/`config.xml`) — CI
   regenerates those via `cap sync`. Result is ~20 tracked files including the
   app icon, `Info.plist`, and the SPM package.
2. **Add a shared Xcode scheme.** Capacitor projects have no shared scheme (the
   `App` scheme lives in gitignored `xcuserdata`), but headless `xcodebuild
   archive` requires one. Create
   `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` — see
   `references/app-scheme-template.xml` and substitute the native target's
   `BlueprintIdentifier` (find it: grep `PBXNativeTarget` in
   `ios/App/App.xcodeproj/project.pbxproj`).
3. **Enable `apple-generic` versioning.** So CI can bump the build number with
   `agvtool`. Capacitor sets `CURRENT_PROJECT_VERSION`/`MARKETING_VERSION` but
   not `VERSIONING_SYSTEM`. Add `VERSIONING_SYSTEM = "apple-generic";` to BOTH
   the Debug and Release `buildSettings` in `project.pbxproj`.

Do this on a **branch** (e.g. `codemagic-ios-build`) and push it — Codemagic
builds from the remote, and a branch keeps `main` clean while you iterate.

**Checkpoint:** `git ls-files ios/ | wc -l` is ~20 and includes
`xcshareddata/xcschemes/App.xcscheme`; the branch is pushed.

## Phase 3 — Write codemagic.yaml

Copy `assets/codemagic.yaml` to the repo root and fill in the placeholders
(`<BUNDLE_ID>`, `<APP_STORE_APP_ID>`, `<ASC_INTEGRATION_NAME>`). It already
encodes every fix below, so read the comments rather than trimming them.

Key facts baked into the template (all learned the hard way):
- **`node: 22`** — Capacitor 8's CLI requires Node ≥22 (`node: 20` fails with
  `[fatal] The Capacitor CLI requires NodeJS >=22.0.0`). Match the app's
  Capacitor major version.
- **Modern Capacitor uses Swift Package Manager, not CocoaPods** (tell:
  `ios/App/CapApp-SPM` exists and there's no `Podfile`). So there's no `pod
  install` step; just `npx cap sync ios` then `xcodebuild
  -resolvePackageDependencies`.
- Signing is done explicitly (see Phase 4), NOT via the automatic
  `environment.ios_signing` block — that block only fetches existing profiles
  and fails on a fresh account.

## Phase 4 — Codemagic account + signing (the hard part)

This is where most build cycles get spent. The root problem on a fresh account:
there is **no distribution certificate and no provisioning profile yet**, and
creating a certificate requires a **private key** that you must supply.

**User-side steps (Claude cannot create accounts or handle the secret in-UI):**

1. **App Store Connect API key.** App Store Connect → Users and Access →
   **Integrations** → App Store Connect API → **Team Keys** → generate with role
   **App Manager** (App Manager was confirmed sufficient to create certs/
   profiles once a private key is supplied; escalate to **Admin** only if you
   hit a 403 on cert/profile creation). Download the `.p8` (one-time), note the
   **Issuer ID** and **Key ID**.
2. **Sign up at codemagic.io with GitHub**, authorize the repo, add it as an
   application.
3. **Add the API key to Codemagic** (Team settings → Integrations → App Store
   Connect). Whatever name you give it must equal `<ASC_INTEGRATION_NAME>` in
   the YAML — easiest to just match the YAML to the name they chose.

**The certificate private key (the crux):**

`app-store-connect fetch-signing-files --create` can create the provisioning
profile but cannot create the distribution *certificate* without a private key
(error: `Cannot save Signing Certificates without certificate private key`). So:

4. Generate an RSA key once: `openssl genrsa -out cert_key.pem 2048`. It's a
   secret — generate it OUTSIDE the repo (or delete after), never commit it.
   - If generating it for the user, do NOT print its contents into the
     transcript; write it to a file and pipe to their clipboard
     (`cat cert_key.pem | clip.exe` on Windows/Git Bash).
5. In Codemagic, add a **secure** environment variable `CERTIFICATE_PRIVATE_KEY`
   = the full PEM contents, in a variable **group** named `ios_signing` (the
   YAML references `groups: [ios_signing]`).

The YAML's signing step then runs:
`keychain initialize` → `fetch-signing-files "$BUNDLE_ID" --type IOS_APP_STORE
--certificate-key @env:CERTIFICATE_PRIVATE_KEY --create` → `keychain
add-certificates` → `xcode-project use-profiles`. It creates the cert+profile
once and reuses them on every later build.

**Checkpoint:** the "Set up code signing" step logs `Created certificate…` and
`Created provisioning profile…` and applies a profile to target `App`.

## Phase 5 — First build, then TestFlight

Expect to iterate: **treat build #1 as a smoke test.** Each failure has a known
cause — consult `references/troubleshooting.md`, which maps every error we've
seen to its fix, before guessing.

- Run the workflow on the `codemagic-ios-build` branch.
- **TestFlight — internal vs external:**
  - **Internal** (the developer + up to 100 people on the account): no beta
    review, no test info. The build is usable the moment it finishes
    processing. This is the fast path to get it on a device. Set
    `submit_to_testflight: false` in the YAML — the build still uploads and is
    auto-available to internal testers.
  - **External** (public beta): requires Beta App Info (feedback email) + Beta
    App Review contact info + Apple's ~1-day review. Only then set
    `submit_to_testflight: true` and add external `beta_groups`.
- Install via the TestFlight app on a real device and **verify the real,
  hosted-backend gameplay/flow works** — this is the end-to-end proof that the
  Phase-1 backend check (public URL, not localhost) actually held.

Once green and verified, merge `codemagic-ios-build` → `main`; subsequent pushes
produce TestFlight builds automatically.

## Reference files

- `references/troubleshooting.md` — every error → cause → fix, in the order
  you'll hit them. Read this the moment a build fails.
- `references/app-scheme-template.xml` — the shared `App.xcscheme` to drop in
  (Phase 2), with the one value to substitute.
- `assets/codemagic.yaml` — the full working workflow to copy into the repo.
