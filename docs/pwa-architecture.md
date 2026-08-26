# PWA architecture

## Scope

The app uses a deliberately limited offline model:

- Cache same-origin static assets and successful public Bible API chapter responses.
- Use network-first navigation with the last successful app shell as an offline fallback.
- Never cache authentication, Supabase/NLC, rankings, member status, reminders, or admin responses.
- Queue reading-log mutations only when the browser is explicitly offline or a request fails at the network layer.
- Keep NLC and Supabase credentials outside IndexedDB and Cache Storage.
- Permit a previously verified user to enter a restricted offline-reading session for up to 30 days. This local identity is not accepted as server authentication.
- Store explicitly downloaded, public/open-licensed Bible packs in dedicated IndexedDB stores, separate from runtime HTTP caches.

## Modules

- `sw.js`: lifecycle and request-routing entry point only.
- `js/pwa/CacheManager.js`: cache strategies and version cleanup.
- `js/pwa/IndexedDbClient.js`: IndexedDB schema and transaction adapter.
- `js/pwa/OfflineQueueRepository.js`: persistent operation queue.
- `js/pwa/OfflineSyncManager.js`: retry, backoff, and status events.
- `js/pwa/ServiceWorkerRegistrar.js`: browser registration and SW messaging.
- `js/pwa/PwaCoordinator.js`: application integration for authenticated reading logs.
- `js/pwa/OfflineBibleRepository.js`: validates, installs, reads, and removes complete 1,189-chapter Bible packs.
- `js/pwa/OfflineBibleControls.js`: download progress and storage controls in profile preferences.

## Trusted offline reading

- A successful online NLC session stores a minimal `offline_trusted_identity` snapshot when the device preference is enabled.
- The snapshot expires 30 days after the last successful server verification.
- Offline mode restores cached plans and reading logs, hides management navigation, and never treats the local snapshot as an access token.
- Explicit logout or an authentication rejection removes the trusted identity. A transient network failure does not remove refresh credentials.
- Returning online revalidates the NLC session before restoring server-backed features and syncing queued reading logs.

## Offline Bible packs

- Online reading defaults to CUNP and continues to use the existing exact-version API path.
- Downloadable packs are currently OCCB Traditional (`CC BY-SA 4.0`) and WEB (`Public Domain`). Their source and attribution metadata travel with each pack.
- A pack is marked installed only after all 1,189 chapters have been parsed and committed to IndexedDB.
- Reader resolution order is installed IndexedDB chapter, exact online source, then the existing visible load-failure fallback.
- Bible packs contain public scripture text only and remain separate from private account caches.

## Data flow

1. Online reading updates continue through `db.logChapterRead()`.
2. Offline updates are applied to local state and written to `offline_operations`.
3. Repeated toggles for the same user/plan/chapter/round replace the queued payload, preserving only the final desired state.
4. `online`, Background Sync, or a SW `SYNC_REQUEST` triggers a flush in an open client.
5. The client uses its current authenticated data client; the Service Worker never stores tokens.
6. Permanent 4xx failures stop retrying. Network errors and retryable status codes use bounded exponential backoff.

## Cache routing

- Navigation: Network First; `/index.html` fallback.
- Same-origin scripts, CSS, fonts, images, and manifest: Cache First.
- Missing content-hashed CSS: retry the stable /index.css entry with a build-version query; deployment rewrites stale index.<hash>.css URLs to that stable entry.
- `bible-api.com` and `bolls.life`: Network First with runtime cache fallback.
- Non-GET and sensitive API traffic: bypass Service Worker handling.

## Versioning

Change the `VERSION` constant in `sw.js` whenever cache contents or routing behavior changes. Activation deletes only caches beginning with `newlife-bible-`; never delete unrelated origin caches.
