# Elevate Scan Fit — remote client app

This is a separate client-facing application. Clients open a private customer-specific measurement link and do not sign in. Captures are stored on the existing Elevate CRM customer record for staff review. There is no public customer directory, account registration or automatic order update.

The app is prepared in `/workspace/elevate-scan-fit`; the staff CRM source stays in `/workspace/elevate-crm`. These are separate app directories/runtimes in the current cloud machine, **not evidence that a second Codex environment or hosted service has been created**. The available tools cannot provision a new environment or Render/Hostinger service directly. The source repository is https://github.com/manaretaltd/Scan-fit. It can be opened in a separate environment and deployed as a new service after configuration and validation.

## Client workflow

1. Staff open the customer's **Scan Fit** tab in the CRM, select an active physically calibrated frame and create a private seven-day link.
2. Staff copy and share the link privately. The system does not send email/messages automatically.
3. The client opens it, reads the capture instructions and agrees to storage/staff review. There is no sign-in page.
4. The client wears the supplied calibrated fitting frame and asks someone to use the standard rear phone camera approximately 40 cm away. Ordinary glasses cannot establish the required scale.
5. A five-frame burst is sent to the customer-linked CRM session with `remote_client` provenance and **Review** status. The link permits one submission; subsequent requests return a minimal receipt. Staff assess images/quality/results and request another capture if needed.

No independently validated accuracy, exact browser depth or physical iPhone support is claimed. Measurements and quality scores remain provisional. Captures with insufficient quality have evidence but no final aggregate. The independent reference/device checks in the CRM measurement handover remain required before clinical use.

## Development workflow

Use Node 24 and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm prepare:scan-fit
pnpm demo:client
```

The demo builds the app and uses disposable synthetic data, a private application port 3018 and a fixture backend port 54338. It never connects to the live CRM. The processes must restart in each cloud task; stopping the fixture discards its data. There are no real credentials in the source. These ports are agent-internal, not public preview links.

Cloud setup uses `npm_config_store_dir=/workspace/.cache/elevate-crm/pnpm-store` and `PNPM_HOME=/workspace/.cache/elevate-scan-fit/pnpm` so pnpm's automatic dependency checks use the writable verified store. This is only a cloud path configuration; other machines can use their normal pnpm store.

```sh
pnpm typecheck
pnpm lint
pnpm test:client:db
pnpm test:client:browser
pnpm test:scan-fit
```

Browser tests default to `/usr/bin/chromium`; set `PLAYWRIGHT_CHROME_PATH` to another installed Chromium/Chrome executable if needed. They use artificial geometry and simulated vision observations for persistence, not physical camera/accuracy acceptance. The known-transform and vision-library checks are retained.

## Connecting the real CRM

### Hostinger build settings

Use a **Node.js / Next.js app**, repository `manaretaltd/Scan-fit`, branch `main`, and Node 24. Install with `pnpm install --frozen-lockfile`, build with `pnpm build`, and start with `pnpm start`. The build now prepares and checksum-verifies the required model/WASM assets automatically. Static-file hosting cannot run the submission API.

The homepage displays **Your private measurement link** until it is opened with a valid customer link created in the updated CRM. That is the expected account-free landing state. **This link is unavailable** can indicate an expired/revoked token, missing CRM schema/configuration, or a failed backend connection; inspect deployment/runtime logs and the network response before assuming the link expired. No real CRM settings are included in this repository.

Use the **existing CRM Supabase project and staff records**, with the existing scoped access rules. Do not create a second customer database, clone real customer data or run the empty-project bootstrap on the CRM.

The new client service needs these values securely in its hosting settings:

| Variable | Meaning |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing CRM Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Existing project server-only key, never a browser variable or chat value |
| `APP_URL` | Exact HTTPS origin of the separate client service |
| `SCAN_FIT_ALLOW_TEST_ORDER_WRITES` | Keep `0` |

The staff CRM service needs `SCAN_FIT_CLIENT_APP_URL` set to that same separate client origin. Its own `APP_URL`, authentication settings and website origin stay unchanged. The client app needs no client-login redirect or email sign-in setup. Its privileged API authorizes a hashed private link before accessing any session.

Prepare/review migrations **018 and 019** on a development copy of the existing CRM schema first, then the corresponding CRM source integration. Migration 018 adds the measurement module; 019 adds private customer-link grants and remote provenance. If 018 already exists, apply only missing migrations through the normal upgrade workflow. No live migration was executed here. Production use of an unvalidated measurement tool remains prohibited by the original brief.

`render.yaml` describes a **new** service named `elevate-scan-fit-client`, with auto deployment off and TEST-order writes disabled. It has not been applied. Do not reuse the existing `elevate-crm` service or update the website to create this app. A new Render service is the proposed hosting choice; Hostinger is an alternative if the account supports this Node/Next.js app.

## Security and data handling

- Private links use 32 random bytes. Only SHA-256 hashes are stored. The raw token is returned once to staff and carried in a URL fragment, then sent in an Authorization header; it is not a query/path parameter or database value.
- Links are sensitive bearer grants: share them only with the intended client. Possession permits capture for that customer; it is not proof of the client's identity.
- Tokens expire after seven days, can be revoked and stop working if the issuing staff account/scope becomes invalid. Revocation does not delete previously submitted evidence.
- Public APIs return no customer name, directory, staff identity, order details, image download links or credentials. Invalid/expired tokens receive generic errors; origin checks prevent cross-origin browser submission.
- Link tables/RPCs are inaccessible to anonymous and ordinary browser database roles. Only authorized server RPCs perform writes. Submission and consent are committed atomically, with row locks and an idempotent receipt.
- Images are private, bounded and unique; server geometry/derived images are recalculated. Browser observations are client-supplied and must be reviewed against the images. They are not trusted as authoritative measurements.
- Consent records use version `remote-capture/1`. Audit provenance identifies a remote submission and the responsible issuing staff member; it does not pretend that staff operated the client's camera.
- Failure cleanup preserves committed image references and reconciles unused uploads. Automatic image deletion/retention purge is not implemented; the existing CRM retention/archive limitations still apply.

## Verification and current limits

Passed: independent app production build, TypeScript and ESLint; 5 new SQL/security/link tests; 2 account-free browser workflows; a functional browser check of the actual staff CRM link-creation/revocation UI connected to the client app; 17 retained numerical/vision tests; and the CRM's 19-migration bootstrap checks. The broader existing Scan Fit checks are documented in the original CRM report.

The shared-backend test proves that a captured test session is on the same fixture customer's CRM record, in Review status, with no automatic measurement update. Auth/Storage are simulated and SQL executes in PGlite; it does not prove live Supabase integration.

No live CRM credentials are present in this environment, no real customer records were read/copied, and no hosted app/second cloud instance/DNS/website deployment was created. Remaining work: provision the separate host/environment, securely configure the existing CRM backend, verify the schema/source upgrade in development, manufacture/review the physical calibration, test actual iPhone/iPad captures and obtain independent reference measurements before any clinical rollout.

See [CRM_INTEGRATION.md](CRM_INTEGRATION.md) for the staff-side integration inventory and handover. The separate GitHub repository is `manaretaltd/Scan-fit`. Publishing source there does not host the app or configure its real CRM connection.
