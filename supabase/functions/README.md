# NLC Edge Functions

The app uses church Logto login, not Supabase Auth, in production.

Current flow:

1. Frontend completes Logto PKCE login.
2. Frontend calls `nlc-session` with the Logto access token.
3. `nlc-session` verifies Logto userinfo and upserts `profiles` / `user_identities` with the service role.
4. Frontend uses a small client shim that calls `nlc-data` for database reads/writes.
5. `nlc-data` verifies the Logto access token on each request, resolves the current profile, and applies server-side table/action restrictions before using the Supabase service role.

Required Supabase Edge Function secrets:

```bash
NLC_LOGTO_ISSUER=https://sso.newlife.org.tw/oidc
NLC_MEMBER_HUB_URL=https://member.newlife.org.tw
NLC_PLATFORM_API_URL=https://platform.newlife.org.tw/platform/v1
APP_ORIGIN=https://bible.newlife.org.tw
```

Supabase provides these default secrets automatically:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY
```

`NLC_SUPABASE_JWT_SECRET` is no longer required. The app no longer signs custom Supabase JWTs.

Both functions must have `verify_jwt = false` because the incoming bearer token is a Logto token, not a Supabase token.

## 每日小測驗生成 (`generate-daily-quizzes`)

This scheduled function resolves the current church-campaign chapters in
`Asia/Taipei`, fetches the scripture once, then generates variants A/B/C with
exactly one Gemini API request per variant. Database reservation is
atomic, so repeated scheduler invocations and duplicate button clicks cannot
produce duplicate Gemini requests. A pastor or administrator may manually
retry failed variants or replace generated-but-unapproved variants without a
fixed request cap. Approved or published variants are immutable.

Required Edge Function secrets:

```bash
GEMINI_API_KEY=<server-only Gemini API key>
GEMINI_QUIZ_MODEL=gemini-3.1-flash-lite
QUIZ_GENERATION_CRON_SECRET=<random shared secret>
```

Enter only the model ID as the `GEMINI_QUIZ_MODEL` value. Do not include
quotes, a `models/` prefix, or `GEMINI_QUIZ_MODEL=` in the value. The function
also normalizes these common formatting mistakes before calling Gemini.

Deploy without Supabase JWT verification because pg_cron authenticates with
the custom `x-cron-secret` header:

```bash
supabase functions deploy generate-daily-quizzes --no-verify-jwt
```

`--no-verify-jwt` is mandatory. If the function has no invocation log at all,
the Supabase gateway is usually rejecting the `pg_net` request before the
function starts. Redeploy with the command above and confirm **Enforce JWT
Verification** is disabled in Edge Functions → `generate-daily-quizzes` →
Settings. The function itself still validates `x-cron-secret`.

To inspect the asynchronous `pg_net` response after pressing manual update,
run this in the SQL Editor. A gateway problem appears here as HTTP 401 even
when the Edge Function log is empty:

```sql
select id, status_code, content, error_msg, created
from net._http_response
order by created desc
limit 20;
```

Migration `0085_schedule_daily_church_quizzes.sql` runs it daily at 00:05
Taipei time. Store the same cron secret in Vault once:

```sql
select vault.create_secret(
  'REPLACE_WITH_QUIZ_GENERATION_CRON_SECRET',
  'quiz_generation_cron_secret',
  'x-cron-secret sent to generate-daily-quizzes'
);
```

Generated questions remain `pending` until a pastor or administrator approves
them. Editing a question resets approval; a version already used by a published
quiz is immutable so members never see the content change while answering.

Manual retry/replacement requires migration
`0086_manual_daily_quiz_regeneration.sql` and redeploying both quiz-related
functions:

```bash
supabase functions deploy nlc-data --no-verify-jwt
supabase functions deploy generate-daily-quizzes --no-verify-jwt
```

Apply `0087_optimize_daily_quiz_dashboard.sql` as well. It replaces the
per-group member lookup loops with one set-based membership pass and only
builds member answer details for groups that already have a publication.

Apply `0088_daily_quiz_feature_flag.sql` to add the administrator-controlled
master switch. It defaults to off, preserves all quiz data, hides client entry
points, rejects quiz RPC calls in `nlc-data`, and makes the 00:05 scheduler and
generator return without sending any Gemini request while disabled. Redeploy
both `nlc-data` and `generate-daily-quizzes` after applying it.

Only pastors and administrators can request a retry. Duplicate clicks are
deduplicated by an atomic database status transition. A ready but unapproved
variant asks for confirmation before replacement; once approved, the database
trigger permanently blocks replacement, editing, and approval cancellation.

## 每日靈修影片自動抓取 (`sync-devotion-video`)

The church's YouTube channel (`@NewLifeChurch` by default) usually publishes
that day's devotion video around 07:00 Asia/Taipei. This scheduled function
runs shortly after, reads the channel's public Atom/RSS feed
(`youtube.com/feeds/videos.xml` — no login, no API key, no quota; the same
public data a browser or any RSS reader sees), and fills `video_url` /
`video_title` on today's row in `plan_devotion_days` for whichever devotional
plan (`plan_kind = 'devotional'`) is currently active.

It only writes when that day's `video_url` is still blank — if an
administrator already pasted a different link by hand, the sync never
overwrites it (see `sync_devotion_day_video` in the migration below, which
runs the update `WHERE video_url IS NULL`). It also refuses to backfill: if
the channel's latest video isn't actually published today, the row is left
alone rather than attaching an old video to today's date.

Required Edge Function secrets:

```bash
DEVOTION_VIDEO_SYNC_CRON_SECRET=<random shared secret>
DEVOTION_YOUTUBE_HANDLE=NewLifeChurch          # optional, this is the default
DEVOTION_YOUTUBE_CHANNEL_ID=<UCxxxxxxxx...>    # optional; skips the @handle → channel_id lookup when set
```

Deploy without Supabase JWT verification, same reason as the quiz generator —
pg_cron authenticates with the custom `x-cron-secret` header instead:

```bash
supabase functions deploy sync-devotion-video --no-verify-jwt
```

Migration `0155_devotion_video_sync.sql` runs it daily at 07:10 Taipei time
(23:10 UTC) and adds the blank-only write RPC. Store the same cron secret in
Vault once:

```sql
select vault.create_secret(
  'REPLACE_WITH_DEVOTION_VIDEO_SYNC_CRON_SECRET',
  'devotion_video_sync_cron_secret',
  'x-cron-secret sent to sync-devotion-video'
);
```

## issue-report-sheet-sync

Mirrors every new `public.issue_reports` row to an engineering-team Google
Sheet, exposing only `created_at` / `category` / `status` / `description` —
no `user_id`, `url`, `user_agent`, `metadata`, or report `id` ever leaves the
app. Fires once per new report; editing a report's status later in the admin
panel does **not** update the sheet row (by design — see the code comment in
`index.ts` if that ever needs to change).

This function also has `verify_jwt = false` — its caller carries no
Supabase/Logto token to verify at all. It's protected instead by a shared
secret checked against a custom header.

**The trigger is a SQL migration, not a Dashboard Database Webhook.** The
Dashboard's Database → Triggers UI only lets a trigger call a Postgres
function (no external URL field), and `/database/hooks` (the dedicated
Database Webhooks page on older Supabase Dashboard versions) 404s on this
project. So `supabase/migrations/0077_issue_report_sheet_sync_trigger.sql`
reproduces the same thing directly in Postgres with the `pg_net` extension:
an `AFTER INSERT` trigger on `issue_reports` that POSTs to this Edge
Function, built from the exact payload shape (`type`/`table`/`record`) a
Database Webhook would have sent — so `index.ts` didn't need to change when
the delivery mechanism did.

Required Supabase Edge Function secrets (in addition to the defaults above):

```bash
ISSUE_REPORT_WEBHOOK_SECRET=<random string you choose>        # checked against the pg_net trigger's x-webhook-secret header
ISSUE_REPORT_SHEET_WEBHOOK_URL=<Apps Script Web App /exec URL> # from step 3 below
ISSUE_REPORT_SHEET_WEBHOOK_SECRET=<random string you choose>   # checked by the Apps Script doPost, see apps-script.gs.txt
```

`ISSUE_REPORT_WEBHOOK_SECRET` must ALSO be stored in Supabase Vault under
the same value, so the SQL trigger function can read it at runtime (a
migration file is committed to git, so the actual secret value can never
live inside one) — see step 5 below.

### One-time setup (all done in your own Google/Supabase accounts — nothing here can be automated from this repo)

1. Pick two random secret strings (they can be the same value or different —
   just don't reuse a real password). One becomes
   `ISSUE_REPORT_WEBHOOK_SECRET`, the other `ISSUE_REPORT_SHEET_WEBHOOK_SECRET`.
2. Open the target Google Sheet → Extensions → Apps Script. Paste the contents
   of `apps-script.gs.txt` (same folder as this README), replace
   `SHARED_SECRET` with your `ISSUE_REPORT_SHEET_WEBHOOK_SECRET` value.
3. Deploy → New deployment → type "Web app". Execute as "Me", access "Anyone".
   Copy the deployment URL — that's `ISSUE_REPORT_SHEET_WEBHOOK_URL`.
4. Set all three secrets above via `supabase secrets set` (or the Dashboard),
   then deploy with JWT verification explicitly disabled:
   ```bash
   supabase functions deploy issue-report-sheet-sync --no-verify-jwt
   ```
   `--no-verify-jwt` is required here even though `config.toml` already sets
   `verify_jwt = false` for this function — deploying without the flag left
   the platform gateway enforcing JWT verification anyway, rejecting every
   pg_net request before it ever reached this function's code
   (`sb-error-code: UNAUTHORIZED_NO_AUTH_HEADER`, a 401 from Supabase itself,
   not from the shared-secret check inside `index.ts`). If it ever happens
   again, also check Edge Functions → issue-report-sheet-sync → Settings in
   the Dashboard for an "Enforce JWT Verification" toggle that can override
   `config.toml`. This repo does not auto-deploy Edge Functions either way,
   see the migrations note above for why that matters here too.
5. Run the pending migration (`supabase db push`, or paste
   `0077_issue_report_sheet_sync_trigger.sql` into the SQL Editor — migrations
   aren't auto-deployed either). Then, in the SQL Editor, run once (replacing
   the placeholder with your actual `ISSUE_REPORT_WEBHOOK_SECRET` value —
   this command itself is never committed anywhere):
   ```sql
   select vault.create_secret(
     'REPLACE_WITH_YOUR_ISSUE_REPORT_WEBHOOK_SECRET',
     'issue_report_webhook_secret',
     'x-webhook-secret sent to issue-report-sheet-sync'
   );
   ```

## 報名與註冊統計 → Google 試算表同步 (`nlc-data`'s `sync_registration_stats_sheet` action)

Unlike `issue-report-sheet-sync`, this is **not** a separate Edge Function or
a DB trigger — it's a new `action` inside `nlc-data` itself, called directly
by an authenticated admin clicking "更新到 Google 試算表" in 系統管理 →
報名與註冊統計. The client (`js/modules/admin.js`) builds the exact row shape
(including the pastoral-zone leader names, looked up from the same source as
組織架構權限總覽); `nlc-data` re-validates `isAdmin(profile)`, sanitizes the
shape, and forwards it — with a shared secret, not the caller's token — to a
Google Apps Script Web App bound to the church's shared "速讀報名統計" sheet.
It **overwrites** the sheet's whole table every time (not an append), so a
shorter region/zone list than last time doesn't leave stale rows.

Required Supabase Edge Function secrets on `nlc-data` (in addition to the
defaults above and its own existing `NLC_*` secrets):

```bash
REGISTRATION_STATS_SHEET_WEBHOOK_URL=<Apps Script Web App /exec URL>    # from step 2 below
REGISTRATION_STATS_SHEET_WEBHOOK_SECRET=<random string you choose>      # checked by the Apps Script doPost, see registration-stats-apps-script.gs.txt
```

### One-time setup

1. Pick a random secret string for `REGISTRATION_STATS_SHEET_WEBHOOK_SECRET`.
2. Open the target Google Sheet ("速讀報名統計") → Extensions → Apps Script.
   Paste the contents of `registration-stats-apps-script.gs.txt` (same folder
   as this README), replace `SHARED_SECRET` with the value from step 1. Then
   Deploy → New deployment → type "Web app", execute as "Me", access "Anyone".
   Copy the deployment URL — that's `REGISTRATION_STATS_SHEET_WEBHOOK_URL`.
3. Set both secrets above via `supabase secrets set` (or the Dashboard) and
   redeploy `nlc-data`:
   ```bash
   supabase functions deploy nlc-data --no-verify-jwt
   ```
   (`nlc-data` already needs `--no-verify-jwt` for the Logto-token reasons
   described at the top of this README — this isn't new for this feature,
   just a reminder it's still required after adding the two secrets above.)
4. No new migration and no Vault secret needed — this path never touches
   Postgres directly for delivery; it only calls the existing
   `get_admin_registration_statistics` RPC indirectly (via the admin panel
   already loading its data), then forwards what's already on screen.
