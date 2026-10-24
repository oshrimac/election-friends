# הקלפי — Election Friends

A Hebrew, right-to-left election prediction game for independent groups of friends. This version replaces the browser-only prototype with a server, persistent PostgreSQL data, private participant access, an admin screen, and public results and rankings.

## What works

- Share the home URL with friends. They join by name and receive a private personal link.
- A personal link restores that participant's editing session on another browser/device. Participants do not need email or a password.
- Each prediction must contain whole numbers from 0 to 120 and total exactly 120 seats. The server validates every submission.
- Submissions can be edited until the deadline or an early admin lock. Other participants' predictions are hidden by the API until closing.
- The deadline is enforced by the server on every request; no scheduled task is necessary.
- `/admin` has a separate password-protected session. The admin configures the group, parties, deadline, early lock, and actual results.
- Publishing results computes the shared scoreboard from database predictions. Corrections recalculate all scores and are recorded in an audit table.
- Anyone with the group URL can see published results, the scoreboard, and per-party prediction comparisons. The report supports CSV export and printing / Save as PDF.
- Read-only results and scoreboard screens refresh every 15 seconds. A refresh button updates other screens.

No payments or money are involved. Names are display names rather than verified identities. A person can join under more than one distinct name; this version does not enforce one entry per real-world person.

## Run locally

Requirements: Node.js 22.9+ (Node.js 24 recommended), npm.

```bash
npm ci
npm run admin:password
```

The password command asks for a new password in a terminal with hidden input. Use at least 16 characters. It prints a **password hash**, not your password. Create `.env.local` and store the hash as a single literal line:

```dotenv
ADMIN_PASSWORD_HASH=scrypt$<salt>$<hash>
```

Do not run that line as a shell command; the dollar signs are literal. Do not commit `.env.local` or share it in chat.

```bash
npm run dev
```

Open `http://localhost:3000/admin`, sign in, configure the group, then open `http://localhost:3000/` to join.

Without `DATABASE_URL`, local development uses a real embedded PostgreSQL engine (PGlite), persisted in `.data/ballot`. It starts empty; there are no demo participants or fake predictions. The suggested party names in setup are **examples**, not a verified current election slate. Replace them before inviting friends.

The app deliberately refuses a local database fallback on Vercel or when `NODE_ENV=production`. Production requires a PostgreSQL connection.

## Publish on your Vercel account

Publishing cannot be completed by uploading only `index.html`: the API and database are required. Deploy the **entire project**.

1. Restore the Vercel connection's access to the intended workspace. In the preparation session, the authenticated user's default workspace was `osh7`, and scoped project/integration requests returned **403, not authorized**. No project or database was created and no deployment was made.
2. Put this source in a private Git repository and import it into Vercel, or use the Vercel CLI from this folder. Choose **Other** for Framework Preset. Build command: `npm run build`. Output directory: `public`. Use Node.js 24. `vercel.json` supplies the API routes, headers and function configuration.
3. In the project's Storage / Marketplace area, provision a PostgreSQL database (Neon is a suitable choice) and connect it to the project. The app reads `DATABASE_URL`. Use the provider's TLS-enabled, pooled connection URL. Confirm you are connecting the intended production database.
4. Run `npm run admin:password` on your own computer. Store the resulting value as a **secret environment variable** named `ADMIN_PASSWORD_HASH` in Vercel. Do not use the original password as this variable. Keep the plaintext password in your password manager.
5. Ensure both `DATABASE_URL` and `ADMIN_PASSWORD_HASH` are set for the deployment's environment. Use a **separate database** for Preview; do not connect unreviewed preview code to the production database.
6. Deploy. The initial request creates or upgrades the schema inside a transaction protected by a PostgreSQL advisory lock. The v2 upgrade preserves existing rows and assigns them to the original group; it removes the singleton restriction and replaces globally unique participant names with names unique within each group. No participant data is deleted or seeded. The database user needs schema creation permission on first start.
7. Open the published `/admin`, sign in, set your group title, party list and future closing time, and save. The date/time input uses your device's timezone; the saved deadline is also displayed in Israel time for confirmation.
8. Make sure the **production URL is accessible to anyone with the link**, rather than protected by a Vercel sign-in gate. The app's admin screen remains password protected.
9. Test from two browsers/devices: join under distinct names, submit 120 seats, verify predictions are hidden before closing. Use a separate test deployment/database to exercise locking and results publication.
10. Share the production home URL. Keep your admin password and every participant's personal link private.

`APP_URL` is optional. If set, use the exact canonical origin, such as `https://your-domain.example`, with no path. Mutating requests must match that origin. Leave it unset for preview deployments; the request's own host is checked instead. Do not apply a production `APP_URL` to previews or an alternate domain you intend to use.

For an already authenticated CLI, a typical production deployment is:

```bash
npx vercel link
npx vercel --prod
```

Select your intended workspace and project. Configure the database and environment secrets before deploying. Deploying does not itself configure the game or make an unprovisioned database work.

## Independent friend groups

The existing home URL and `/admin` remain the original group. Existing participants, predictions, results, personal links and admin sessions remain valid. `DATABASE_URL` and `ADMIN_PASSWORD_HASH` are unchanged.

1. Sign in at the original `/admin` with the existing site-owner password.
2. In **עוד פרלמנט, קישור משלו**, enter the new group's title and a new administrator password (16–256 characters). Store it privately; only its scrypt hash is stored in the database.
3. Press **פתיחת קבוצה נפרדת**. The new group appears under **הקבוצות שפתחתם**, with its shareable participant link and a management link.
4. Open its management link, sign in using that group's password, then configure parties and closing time before sharing.

Participant URL: `/?group=<random-group-code>`
Admin URL: `/admin?group=<random-group-code>`
Scoreboard: `/?group=<random-group-code>#ranking`

Each group has its own party list, deadline, players, predictions, results, scoreboard, audit rows and admin sessions. Participant names need only be unique within a group. Cookies are scoped by group name, so the same browser can participate in and administer several groups. Personal recovery links and all sharing/navigation retain the group code. Requests with unknown or malformed group codes return 404 rather than falling back to the original group. The original site-owner password is not a login password for new groups.

Only the authenticated site owner in the original group can create groups or see the list of groups. Group administrators cannot create or list other groups. Anyone holding a group's participant link can join it while open and see its participant names/status; submitted predictions become visible at closing. Links are invitation links, not verified membership or an account system.

Deployment: publish the new commit using the existing Vercel settings. First API use performs the idempotent v2 database upgrade within the existing advisory-lock transaction. The database role must have permission to alter existing app tables and create a sequence/indexes. No new environment variables are required. Keep the current Vercel framework preset **Other**.

## Your admin workflow

1. Go to `/admin` and sign in. Admin sessions expire after eight hours.
2. Before inviting anyone: configure the parties and deadline. Party names become fixed when the first participant joins; entries are never silently reset.
3. You can move the deadline while predictions remain open. Once closed, the deadline cannot be changed. You can manually reopen an early lock only before the deadline and before results publication. Reopening cannot undo the fact that friends may already have seen predictions.
4. After the election, wait for automatic closing or press **נעילה עכשיו**. Closing reveals submitted predictions.
5. Enter actual seats totaling 120, optionally add the results source / note, and press **פרסום תוצאות ודירוג**. Everyone can view the report at `/#ranking`.
6. If needed, return to `/admin` and publish corrected results. Predictions remain locked, rankings recalculate, and the correction is recorded in the database audit log.
7. Export CSV or use **הדפסה / שמירה כ-PDF** from the scoreboard.

## Participant workflow

Open the shared group link, choose a unique display name, allocate 120 seats, then press **שמירת התחזית בשרת**. Changing a number does **not** automatically submit it: the screen marks unsaved changes. Saving again before closing replaces only your own prediction.

Save your private link. On a returning session, **הצגת הקישור האישי** retrieves it again. A private link restores access without asking you for a password. Anyone holding it can act as that participant, so never share it in the group. The token is placed in the URL fragment (not query strings or server access logs), exchanged for an HttpOnly cookie, and removed from the address bar. If both the cookie and the saved link are lost, there is no email-based recovery in this version.

The displayed name and submission status are public within the shared group. Submitted predictions become public at closing. Unsubmitted edits exist only in the page's memory and disappear on a reload.

## Scoring

For each submitted prediction:

`score = 120 − (sum of absolute differences from actual seats) / 2`

Both vectors must total 120. A perfect prediction scores 120. Ties share the same competition rank (1, 1, 3). Names sort consistently within tied scores. No client-provided score or player ID is trusted for scoring or ownership.

## Data and operations

- Tables: `ballot_game`, `ballot_players`, `ballot_admin_sessions`, `ballot_rate_limits`, `ballot_audit`.
- Participant and admin session tokens are generated with 256 bits of randomness; only SHA-256 hashes are stored in the database. The admin password is checked with scrypt.
- Same-origin JSON mutation requests, HttpOnly / SameSite cookies, Secure cookies in production, password attempt limits persisted in PostgreSQL, escaped UI text, private API responses with `no-store`, and static security headers are included.
- Every prediction submission and admin state change takes the same game-row transaction lock, so a submission cannot race past an admin lock or results publication.
- The database is the source of truth. Vercel function memory, localStorage and browser-selected players are not used for shared data or permissions.
- Keep provider backups enabled as appropriate. CSV exports are reports, not database backups. Future schema changes should use reviewed additive migrations.
- Rotating `ADMIN_PASSWORD_HASH` changes the password for new logins. Existing admin sessions remain valid until expiration; to revoke immediately, clear `ballot_admin_sessions` through an authenticated database console.
- Participant cookies last one year. Their private recovery tokens remain valid until removed/replaced in the database. There is no automated email recovery or reset button. Each group manages its own election and keeps its own predictions and results.
- For a new election, create a new group to preserve previous predictions and reports. Do not repurpose a group with existing participants.

## Verification

```bash
npm run build
npm test
```

Nine automated tests cover the original lifecycle and multiple-group isolation. They cover the full lifecycle with real embedded PostgreSQL, two independent participant sessions, cross-device token recovery, deadline enforcement, unauthorized writes, private pre-close data, malformed submissions, ties, corrected results, failed-login rate limits, HTTP cookies / CSRF checks, concurrent locking, and the UI → API → database → shared report flow in separate simulated DOM clients.

`npm audit --omit=dev` reported zero vulnerabilities during preparation.

**Not yet verified:** a live Vercel build, the external PostgreSQL connection, production-domain/cookie behavior and a two-device public URL check. Those depend on workspace access and production provisioning. A Chromium visual check was attempted, but the available browser could not reach the local server; automated DOM tests are not a substitute for visual / mobile browser QA.

Original prototype: `docs/prototype.html`. Original README: `docs/README.original.md`. These are historical references, not the production entry point.

