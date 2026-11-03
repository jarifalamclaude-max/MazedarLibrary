# মাজেদার লাইব্রেরি — Architecture & module contracts

Offline-first personal library. Static files only (GitHub Pages), no build step at
runtime. Every device keeps the full library locally (IndexedDB); Firebase
Firestore is used purely as a sync channel between devices signed in to the same
account. The app works with no cloud configured at all ("local mode").

```
index.html ── src/app.js (Preact + htm UI, hash routes)
                 │
                 ├── src/lib/store.js      LocalStore: IndexedDB records/covers/outbox/meta/snapshots
                 │      └── merge.js, clock.js   field-level LWW merge, hybrid logical clock
                 ├── src/lib/sync.js       Firestore <-> LocalStore replication (outbox push, listener pull)
                 ├── src/lib/cloud.js      lazy Firebase init + auth (vendor/firebase.js)
                 ├── src/lib/bangla.js     Bengali normalisation, collation, transliteration, fuzzy match
                 ├── src/lib/matcher.js    OCR/search text -> ranked book/catalog candidates
                 ├── src/lib/ocr.js        offline OCR (tesseract.js, Bengali+English) + preprocessing
                 ├── src/lib/gemini.js     online OCR via Gemini REST API (user's API key)
                 ├── src/lib/camera.js     getUserMedia, torch, frame capture, BarcodeDetector
                 └── src/data/humayun.js   ideal list (219 from PDF + 17) and 113 owned books
sw.js  service worker: precache app shell, cache-first vendor/fonts, OCR assets cached on first use
```

Code style: plain ES modules, no TypeScript, no bundler at runtime, 2-space indent,
single quotes, semicolons, small focused functions, JSDoc on exported functions.
Everything in `src/lib` except camera/ocr/gemini/cloud must run unchanged in Node 22
(for `node --test`) and in the browser.

## Records (synced data)

All synced data are records: `{ id, kind, ...fields, _v: { field: stamp } }` (see
`merge.js`). Kinds stored in the `records` collection:

| kind | fields |
|------|--------|
| `author` | `name`, `note`, `deleted` |
| `book` | `title`, `authorId`, `category`, `publisher`, `isbn`, `copies` (int ≥1), `notes`, `favorite` (bool), `readStatus` (`''`/`reading`/`read`), `catalogId` (or null), `serial` (int, owner's list no.), `originalEntry`, `addedVia` (`seed`/`manual`/`scan`/`import`), `hasCover` (bool), `createdAt` (ms), `deleted`, `deletedAt` |
| `catalog` | ideal-list entry: `authorId`, `title`, `group`, `year`, `yearDisputed`, `note`, `order`, `deleted` |
| `settings` | single record id `settings`: `geminiApiKey`, `geminiModel`, `autoSaveExact` |

Covers live in a separate `covers` collection: `{ id: <bookId>, kind: 'cover', data: <jpeg dataURL ≤ ~120 KB>, _v }`.

IDs: `[a-z0-9_]+`, never `/`. Seeds are deterministic (`a_humayun`, `b_h001`…`b_h113`,
`hc001`…`hc182`, `hp01`…`hp37`, `hx01`…`hx17`) and stamped with `SEED_STAMP`, so the
seed is identical on every device and any user edit wins. New records use
`<prefix>_<16 random [0-9a-z]>`.

Nothing is ever hard-deleted: deletion sets `deleted: true` (trash, restorable).
"Delete forever" sets `purged: true` (hidden even from trash) but keeps the tombstone
so a seed or an offline device can never resurrect it.

## LocalStore interface (implemented by `src/lib/store.js` over IndexedDB;
## `tests/helpers/memory-store.js` implements the same for tests)

```js
// collections: 'records' | 'covers'
getManyRaw(collection, ids)        -> Promise<(record|undefined)[]>
outboxList(collection, limit)      -> Promise<string[]>   // ids whose local version may not be on the server yet, oldest first
applyRemote(collection, records)   -> Promise<void>
   // For each incoming record r: local' = mergeRecords(local, r); write local' if it changed;
   // then if recordsEqual(local', r)  -> server already has everything we have: remove id from outbox
   //      else                         -> ensure id is in outbox (we hold newer fields)
   // Emits change events for changed records. Never stamps anything.
getMeta(key) -> Promise<any>;  setMeta(key, value) -> Promise<void>
onLocalWrite(cb) -> unsubscribe     // cb() after every local user edit (sync schedules a push)
```

Local user edits go through `store.put(collection, changes)` which stamps the changed
fields with `clock.now()`, merges, writes and adds the id to the outbox in one IDB
transaction.

## Sync engine contract (`src/lib/sync.js`)

```js
createSyncEngine({
  fs,          // Firestore function bag: { collection, doc, query, where, onSnapshot, runTransaction, serverTimestamp, Timestamp }
  db,          // Firestore instance
  uid,         // signed-in user id
  store,       // LocalStore
  clock,       // createClock(...) — observe() every remote stamp
  collections = ['records', 'covers'],
  isOnline = () => globalThis.navigator?.onLine ?? true,
  subscribeOnline = (cb) => unsubscribe,   // fires when connectivity returns
  batchSize = 100, pushDebounceMs = 400, overlapMs = 120000, logger = console,
}) -> {
  start(), stop(): Promise<void>, syncNow(): Promise<void>, fullResync(): Promise<void>,
  getStatus(): { state: 'starting'|'synced'|'syncing'|'offline'|'error', pending: number, lastSyncedAt: number|null, error: string|null },
  onStatus(cb) -> unsubscribe,
  notifyLocalWrite()
}
```

Firestore layout: `libraries/{uid}/{collection}/{id}` → the record plus `_srv:
serverTimestamp()`. Push: take ≤ batchSize outbox ids, read local, in one
`runTransaction` read the remote docs, write `mergeRecords(remote, local)` + `_srv`,
then `store.applyRemote(collection, mergedList)` (which clears the outbox exactly when
the server now has everything). Pull: `onSnapshot(query(coll, where('_srv', '>',
Timestamp.fromMillis(since - overlapMs))))`, strip `_srv`, `clock.observe(maxStamp)`,
`store.applyRemote`, advance `since` (meta `sync:<uid>:<collection>:since`) to the max
`_srv` seen. Snapshots with `metadata.hasPendingWrites` are skipped. Status `synced`
= listener has a server (non-cache) snapshot and outbox is empty.

(`uid` here is the *library* id: the owner's account id. A member's engine runs
on the owner's id.)

Security rules (`firebase/firestore.rules`): the library card
`libraries/{libId}` = `{ owner, ownerEmail, ownerName, members: [email…≤10], createdAt }`
can be created and updated only by the owner (`request.auth.uid == libId`). Books,
folders and covers under it can be read and written by the owner and by any account
whose **Google-verified** email (`email_verified == true`, lowercased) is in `members`.
Members can also list the cards that name them (`where('members','array-contains',email)`).
Nothing is ever deleted. `tests/emulator/sharing.test.js` checks all of this against
the real rules engine.

## Accounts and libraries (`src/lib/cloud.js`)

- Config, in order: `config.js` → this device (pasted, localStorage) → Firebase
  Hosting's `/__/firebase/init.json`. The last is fetched only on `*.web.app`,
  `*.firebaseapp.com`, or when `config.js` sets `hosting: true`, and is remembered for
  offline starts. On the project's own Hosting address, `authDomain` becomes that
  origin, so Google sign-in needs no third-party storage.
- Google sign-in: a popup in browser tabs and installed Android apps. An installed app
  on the same origin as `authDomain` uses a redirect. An iPhone home-screen app on
  another origin cannot finish Google sign-in (iOS), so that mode is reported as
  `unavailable` and the UI points to the `web.app` address or to email/password.
  `popupRedirectResolver` is not given to `initializeAuth`, so a signed-in phone
  never loads Google's helper frame at start. It is preloaded only while signed out.
- Device binding meta: `boundLibrary` (library id), `boundUser` (account that bound it;
  legacy installs have only `boundUid`). Phases:
  `off | loading | signed-out | busy | resolving | invite | signed-in | needs-switch | removed | error`.
  - Same account as last time: carry on, offline too.
  - Another account: allowed if it may use the bound library; otherwise `needs-switch`
    (take this device's books along, or wipe after a snapshot).
  - Fresh device: list the cards that name this email. None means the account's own
    library. Otherwise `invite` (join one, or use the account's own library).
  - Joining or switching merges this device's real edits into the new library
    (`store.enqueueAll()`), or replaces them (wipe, then reseed).
  - A member who is removed gets `removed`. The books stay on the phone and can become
    the account's own library.

## Text contract (`src/lib/bangla.js`) — pure functions

```js
nfc(s), cleanTitle(s)           // display-safe cleanup (NFC, trim, collapse spaces, keep the ZWJ in র‍্য)
searchKey(s)                    // aggressive match key (variants folded, no spaces/punct)
compareBn(a, b), sortKey(s)     // Bengali dictionary order; Latin after Bengali; digits first
toBnDigits(x), toAsciiDigits(s)
translit(s)                     // Bengali -> lowercase Latin (Banglish)
similarity(a, b) -> 0..1        // title vs title, script-agnostic (Bengali vs Banglish OK)
searchScore(query, text) -> 0..1  // search-as-you-type
```

`src/lib/matcher.js`:
```js
matchText(text, { books, catalog, authors }, { limit = 5 }) ->
  { candidates: [{ kind: 'book'|'catalog', id, title, authorName, score }], best, level: 'exact'|'strong'|'possible'|'none' }
// text = OCR output (multi-line, noisy: may include author/publisher names) or a typed query
```

## OCR contract

```js
// src/lib/ocr.js (browser)
ocrOffline(canvas, { onProgress }) -> { text, lines: [{ text, confidence }], ms }
warmupOffline({ onProgress }) -> void      // download + cache worker, core, ben/eng data
preprocessVariants(canvas) -> [{ name, canvas }]
// src/lib/gemini.js (browser, online)
listModels(apiKey) -> [{ name, displayName, methods }]
pickModel(models) -> string               // best fast multimodal model available to the key
readCover(imageDataUrl, { apiKey, model, signal }) -> { title, author, otherLines: [], ms, model }
// src/lib/camera.js (browser)
openCamera(video, opts) -> { stop(), capture(cropRatio) -> canvas, setTorch(on), hasTorch }
detectBarcodes(source) -> [{ rawValue, format }]   // [] when BarcodeDetector is missing
```
