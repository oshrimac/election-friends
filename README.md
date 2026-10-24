# הקלפי — Election Friends

A Hebrew, right-to-left election prediction game with organizer accounts and independent groups of friends. This version replaces the browser-only prototype with a server, persistent PostgreSQL data, private participant access, an admin screen, and public results and rankings.

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

The password command asks for a new password in a terminal with hidden input. Use at least 4 characters. It prints a **password hash**, not your password. Create `.env.local` and store the hash as a single literal line:

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

## Organizer accounts and independent friend groups

Anyone can open the home URL, choose **הרשמה**, and create an organizer account with a unique username and a password of 4–256 characters. Username/password sign-in is implemented. Google/Gmail sign-in is not enabled and requires a separately configured OAuth integration.

1. Open `/`, register or sign in, and enter a group title under **פתיחת קבוצה**.
2. The group is owned by the signed-in account. Open **ניהול הקבוצה**; no separate group password is needed.
3. Set the party list and closing time before sharing the participant invitation link.
4. Friends open the invitation, enter a display name, and save their prediction. They do not need an account, and the invitation grants no administrator rights.
5. Return to `/` and sign in to find your groups on another device. An account lists only its own groups. Each group checks ownership server-side on every administrative action.

Participant URL: `/?group=<random-group-code>`
Admin URL: `/admin?group=<random-group-code>`
Scoreboard: `/?group=<random-group-code>#ranking`

An organizer may also join their group as a participant; the organizer account and the private participant session are separate. A different logged-in organizer remains an ordinary guest in groups they do not own. Account sign-out revokes that session across all owned groups; participant sessions remain separate. Account sessions last eight hours, use random 256-bit tokens stored as SHA-256 hashes, and are sent in HttpOnly / SameSite cookies (Secure in production). Passwords use salted scrypt hashes. Failed sign-ins and registration attempts have persisted rate limits. Password recovery, email verification, username changes and Google sign-in are not included. The registration screen tells users to retain their credentials.

Each group has its own party list, deadline, players, predictions, results, scoreboard and audit rows. Participant names need only be unique within a group. Cookies and server checks prevent participant sessions or legacy group-admin sessions from being reused across groups. Personal recovery links and sharing/navigation retain the group code. Anyone holding a group's invitation can join it while open and see participant names/status; submitted predictions become visible at closing. Invitations are not a verified-membership system.

### Existing groups and site-owner access

No group is selected automatically at the home URL. The original group remains at `/?group=default`; `/admin` retains the original site-owner password workflow. Existing data, per-group passwords, personal links and admin sessions remain valid. Old personal recovery links without a group code resolve to the original group. Old bare home/scoreboard links should be replaced by explicit group links.

The site owner's legacy group-creation screen remains available in `/admin` for compatibility. Those groups use their existing separate group-admin passwords; creating a new account does not claim a legacy group. Organizer-account groups use account ownership instead. The global `ADMIN_PASSWORD_HASH` remains for legacy site-owner login, not for new organizer accounts.

### Deployment

Publish the commit using the existing Vercel settings, framework preset **Other**. No new environment variables or packages are required. `DATABASE_URL` is required; existing `ADMIN_PASSWORD_HASH` remains unchanged for legacy access. Initial API use performs idempotent v2/v3 schema upgrades under the database advisory lock. They preserve existing groups and predictions while adding account/session tables and nullable group ownership. The database role needs table, sequence and index creation/alteration permissions. All group API calls require an explicit group code; account endpoints are intentionally independent of a group.

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

Ten automated tests cover organizer signup/signin/signout, group ownership, guest access, migration preservation, the original lifecycle and multiple-group isolation. They cover the full lifecycle with real embedded PostgreSQL, two independent participant sessions, cross-device token recovery, deadline enforcement, unauthorized writes, private pre-close data, malformed submissions, ties, corrected results, failed-login rate limits, HTTP cookies / CSRF checks, concurrent locking, and the UI → API → database → shared report flow in separate simulated DOM clients.

`npm audit --omit=dev` reported zero vulnerabilities during preparation.

**Not yet verified:** a live Vercel build, the external PostgreSQL connection, production-domain/cookie behavior and a two-device public URL check. Those depend on workspace access and production provisioning. A Chromium visual check was attempted, but the available browser could not reach the local server; automated DOM tests are not a substitute for visual / mobile browser QA.

Original prototype: `docs/prototype.html`. Original README: `docs/README.original.md`. These are historical references, not the production entry point.

