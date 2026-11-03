# 🌷 মাজেদার লাইব্রেরি

বইয়ের জন্য একটা ছোট্ট বাগান — নিজের সব বই এক জায়গায় রাখা, খোঁজা আর ক্যামেরা ধরে চেনার অ্যাপ।

**ঠিকানা:** `https://<PROJECT_ID>.web.app` (Firebase-এ একবার তোলার পর — [সেটআপ গাইড](docs/SETUP.md)), অথবা GitHub Pages: https://jarifalamclaude-max.github.io/MazedarLibrary/

<p align="center">
  <a href="docs/promo/mazedar-library-promo.mp4"><img src="docs/promo/teaser.webp" width="300" alt="মাজেদার লাইব্রেরি — প্রোমো ভিডিও (চাপ দিয়ে পুরোটা দেখুন)"></a><br>
  <b>🎬 <a href="docs/promo/mazedar-library-promo.mp4">প্রোমো ভিডিও দেখুন</a></b> (৩৬ সেকেন্ড, শব্দসহ)
</p>

<p align="center">
  <img src="docs/screenshots/1-home.jpg" width="190" alt="প্রথম পাতা">
  <img src="docs/screenshots/2-humayun.jpg" width="190" alt="হুমায়ূন আহমেদের ফোল্ডার ও কাউন্টার">
  <img src="docs/screenshots/3-missing.jpg" width="190" alt="সংগ্রহে নেই তালিকা">
  <img src="docs/screenshots/4-banglish-search.jpg" width="190" alt="Banglish-এ খোঁজা">
  <img src="docs/screenshots/5-book-dark.jpg" width="190" alt="বইয়ের পাতা, গাঢ় রঙে">
</p>

## কী কী করা যায়
- **লেখকের নামে ফোল্ডার** — প্রতিটি লেখকের বই আলাদা, প্রত্যেকের পাশে বইয়ের সংখ্যা।
- **হুমায়ূন আহমেদের কাউন্টার** — সংগ্রহে কয়টি আছে, আর সব বই পেতে **আরো কয়টি লাগবে** (সম্পূর্ণ তালিকা ২৩৬টি নাম, এখন ১২৪টি বাকি)। “সংগ্রহে নেই” তালিকা থেকে “পেয়েছি” চাপলেই যোগ হয়; নতুন নাম পেলে তালিকায় যোগ করা যায়। চাইলে যেকোনো লেখকের জন্যও এমন তালিকা বানানো যায়।
- **খোঁজা** — বাংলায় বা Banglish-এ (যেমন `himu`, `misir ali`, `jochona`); বানানের ছোটখাটো পার্থক্য (আলী/আলি, যাব/যাবো, ময়ুর/ময়ূর) নিজেই মিলিয়ে নেয়।
- **ক্যামেরা স্ক্যানার** — বইয়ের মলাট ধরলে বলে দেয় বইটা আছে কি না, অথবা নাম-লেখকসহ যোগ করার ফর্ম খুলে দেয়। ইন্টারনেট ছাড়াও চলে (ফোনের ভেতরের OCR); ইন্টারনেট থাকলে Google Gemini দিয়ে আরো নির্ভুল।
- **বাংলা বর্ণানুক্রমে সাজানো** (অ → হ, বাংলা একাডেমির অভিধানের ক্রমে), সাম্প্রতিক, তালিকার ক্রম, ধরন অনুযায়ী।
- **সবকিছু বদলানো যায়** — নাম, লেখক, ধরন, প্রকাশনী, ISBN, কপির সংখ্যা, পড়ার অবস্থা, প্রিয়, নোট, কভারের ছবি।
- **অফলাইন** — একবার খুললে ইন্টারনেট ছাড়াই পুরো অ্যাপ চলে (ফোনে ইনস্টল করা যায়)।
- **Google দিয়ে লগইন, দুই ফোনে একসাথে** — পাসওয়ার্ড লাগে না। লাইব্রেরির মালিক অন্যজনের Gmail যোগ করে দিলে দুজনে নিজের নিজের Google অ্যাকাউন্টে একই লাইব্রেরি পান। একজন বই যোগ করলে কয়েক সেকেন্ডে অন্যজনের ফোনে চলে আসে, অফলাইনে করা পরিবর্তনও পরে মিলে যায়।
- **তথ্য না হারানো** — প্রতিটি ফোনে পুরো কপি + ক্লাউড কপি, মুছলে আগে ট্র্যাশে যায়, প্রতিদিন স্বয়ংক্রিয় ব্যাকআপ, ব্যাকআপ ফাইল/এক্সেল/প্রিন্ট।
- **লিলি আর ফুলের সাজ** — হালকা আর গাঢ় দুই রঙেই।

## সেটআপ
[docs/SETUP.md](docs/SETUP.md) — একবারই, যে উপহার দিচ্ছে তার: Firebase প্রজেক্ট + অ্যাপ তোলা (১০ মিনিট, কম্পিউটার ছাড়াই ব্রাউজারে)। তারপর যে ব্যবহার করবে সে শুধু “Google দিয়ে লগইন” চাপবে। Gemini স্ক্যানার আরো ২ মিনিট। সবই ফ্রি।

## For developers
Static PWA, plain ES modules, no runtime build. Preact + htm UI, IndexedDB local store,
field-level last-writer-wins replication over Firestore (local-first; Firestore is only the
sync channel), Google sign-in with owner-managed sharing by verified email (rules in `firebase/firestore.rules`), tesseract.js (Bengali + English) offline OCR, Gemini REST for online OCR.

```
npm install          # dev tooling only (vendor/ output is committed)
npm run build        # rebuild vendor bundles + sw.js precache list
npm test             # unit tests (node:test)
npm run e2e          # browser tests (Playwright/Chromium)
npm run e2e:sync     # rules + two-phone sync + Google login/sharing on the Firebase emulators (needs Java)
npx firebase-tools deploy --project <id>   # hosting + Firestore rules
node tools/serve.mjs 8080       # serve locally
```
Architecture and module contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
Data provenance and decisions: [docs/DATA-NOTES.md](docs/DATA-NOTES.md)
