# Remote client Scan Fit integration

The latest user requirement is a separate account-free client app, connected to existing CRM customer records. It supersedes the earlier staff-app-only routing proposal. The prepared client source is `/workspace/elevate-scan-fit`; the staff review module remains inside this CRM. No live deployment or database change occurred.

## Staff flow

Open a customer's **Scan Fit** tab, select an active physical calibration and click **Create client measurement link**. Copy/share the private link manually. It expires in seven days, is tied to that customer's session and permits one capture submission. The UI can revoke the just-issued link. If a capture fails review, create a new link/session; submitted evidence stays intact. Staff remain authenticated in the CRM; clients do not sign in to the separate app.

Remote captures appear in existing history and review pages with `device_info.source = remote_client`, a `capture_source` provenance column, private originals/annotations/rectifications and unaccepted **Review** status. Order measurements are not automatically changed. Client-supplied vision observations require staff image review and the original physical accuracy/device validation still applies.

## Additive source changes

- `supabase/migrations/202610130019_scan_fit_client_links.sql`: private hash grants; expiry/revocation/submission/consent metadata; remote session provenance; privileged issue/authorize/revoke RPCs; transactional submission using the existing reviewed-capture operation.
- `src/app/api/scan-fit/client-links/route.ts`: cookie-authenticated active clinical staff, origin/body limits, random-token generation and one-time link return; scope rechecked in SQL. This endpoint does not send messages.
- `src/components/scan-fit/client-link.tsx`: calibration selection, create/copy/revoke UI.
- `src/components/scan-fit/history.tsx`: existing history extended with invitation controls and remote provenance.
- `src/lib/types.ts`: added RPC types.
- Initial-database generator/tests now expect 19 migrations and preserve empty-project/transaction/rollback checks. This generator remains forbidden on a populated CRM database.
- Test backend gains an optional `clientScan` flag to load 019 only for remote-flow tests.

The new client app has only `/`, its not-found handler and `/api/client-scan`. It does not expose CRM pages, staff login, customer selection or an anonymous database API. Existing staff/customer/order scope is reused server-side. Public status responses omit customer identifiers, personal details, issuer/order data and images. Tokens are hashes in the private table and URL fragments in customer links, not logged URL paths.

## Hosting/configuration

The client app is a separate Node/Next.js service, with a prepared Render Blueprint named `elevate-scan-fit-client`. It points securely to the existing CRM Supabase project, not a newly seeded customer database. Set the client's `APP_URL` to its own exact HTTPS origin and the staff CRM's `SCAN_FIT_CLIENT_APP_URL` to that origin. Keep the CRM's current `APP_URL` unchanged. Neither website navigation nor DNS was edited.

No second Codex environment or hosting service was provisioned: the available tools only configure the environment attached to this conversation. The client source is prepared separately, with repository https://github.com/manaretaltd/Scan-fit; it can be opened in its own environment. Saved setup instructions do not provision/deploy it. Existing Supabase credentials are absent; enter them securely in the appropriate hosting/environment settings, never chat.

Apply missing migrations 018/019 and review source changes on a development backend first. This report does not authorize deploying an authoritative measurement tool before validation. No client login/Auth redirect is required, but staff Auth/permissions remain required in the CRM.

## Checks performed

- Independent client app production build, TypeScript and ESLint passed.
- Five new SQL tests passed: private grant/RPC access, customer binding, invalid/expired/revoked/deactivated links, consent/session restrictions, and atomic one-submission/receipt with no order write.
- Two new browser workflows passed: account-free landing/invalid origins and a consented five-image submission on the correct customer record, private evidence, Review status and idempotent replay.
- Actual staff CRM UI functional check passed: sign-in, customer Scan Fit tab, link creation, separate client opening without sign-in, revocation and denial after reload.
- Seventeen numerical/vision checks and all three 19-migration bootstrap/rollback checks passed. The staff CRM build, TypeScript and ESLint also passed.
- Responsive client screenshots were captured at desktop and 390-pixel widths.

These checks use a disposable SQL-backed fixture with simulated Auth/Storage. No live Supabase customer data, physical rear camera, actual frame ground truth, iPhone/iPad support or clinical accuracy was tested. Precise scale still requires real measured frame fiducials; distance is guidance only, and iris/frame parallax, lens refraction, gaze and quality heuristics remain validation issues. No automatic retention purge was added.

## Artifacts

The workspace contains the separate client source, account-free UI screenshots and a source bundle. A CRM integration patch contains the full working-tree Scan Fit implementation relative to the current repository HEAD, including the earlier staff module and these remote-link additions; it is not a patch against a separately verified hosted revision. Review it before applying to another checkout. The client source is being published to its separate GitHub repository; no service deployment or live database change is included.
