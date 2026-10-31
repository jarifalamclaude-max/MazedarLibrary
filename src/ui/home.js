import {
  html, useState, useMemo, ctx, bn, greeting, navigate, Icon, Lily, LilyBloom, FlowerAvatar, Petals, Cover, Empty,
  useDebounced, usePref, openSheet, toast,
} from './core.js';
import { searchLibrary, byName, byTitle, addAuthor, HUMAYUN_AUTHOR_ID } from './data.js';
import { SyncPill } from './sync-pill.js';
import { InstallHint } from './install.js';

export function BookRow({ book, lib, showAuthor = false, showSerial = false }) {
  const author = showAuthor ? lib.authorById.get(book.authorId) : null;
  const dup = lib.dupes.some((d) => d.a.id === book.id || d.b.id === book.id);
  const copies = Number(book.copies) || 1;
  return html`<a class="book" href=${`#/b/${book.id}`}>
    <${Cover} book=${book} />
    <div class="grow">
      <div class="t">${book.title}</div>
      <div class="m">
        ${author && html`<span>${author.name}</span>`}
        ${book.category && html`<span>${book.category}</span>`}
        ${copies > 1 && html`<span class="badge lilac">${bn(copies)} কপি</span>`}
        ${book.readStatus === 'read' && html`<span class="badge leaf"><${Icon} name="check" /> পড়া শেষ</span>`}
        ${book.readStatus === 'reading' && html`<span class="badge gold">পড়ছি</span>`}
        ${dup && html`<span class="badge gold"><${Icon} name="alert" /> দুবার আছে?</span>`}
      </div>
    </div>
    <div class="side">
      ${book.favorite && html`<span style="color:var(--rose)"><${Icon} name="heart-fill" size=${18} label="প্রিয়" /></span>`}
      ${showSerial && book.serial && html`<span class="serial">${bn(book.serial)}</span>`}
    </div>
  </a>`;
}

function FeatureCard({ author, st }) {
  const v = st.catalogTotal ? st.catalogOwned / st.catalogTotal : 0;
  return html`<a class="feature" href=${`#/a/${author.id}`}>
    <${LilyBloom} value=${v} label=${`সম্পূর্ণ তালিকার ${bn(Math.round(v * 100))} শতাংশ সংগ্রহে`} />
    <div class="who">
      <div class="name">${author.name}</div>
      <div class="lines">সংগ্রহে <b>${bn(st.books)}</b>টি বই · সম্পূর্ণ তালিকায় ${bn(st.catalogTotal)}টি</div>
      ${st.remaining > 0
        ? html`<div class="need"><${Icon} name="sparkle" size=${16} /><span>সব পেতে আরো লাগবে <b>${bn(st.remaining)}</b>টি</span></div>`
        : html`<div class="need" style="background:var(--leaf-soft)">🌸 তালিকার সব বই সংগ্রহে!</div>`}
      <div class="bar"><i style=${`width:${(v * 100).toFixed(1)}%`} /></div>
    </div>
  </a>`;
}

export function openAddAuthor(lib, { then } = {}) {
  let name = '';
  openSheet((close) => {
    const submit = async (e) => {
      e.preventDefault();
      try {
        const a = await addAuthor(lib, name);
        close();
        toast(`“${a.name}” ফোল্ডার তৈরি হয়েছে`, { type: 'ok' });
        if (then) then(a);
        else navigate(`/a/${a.id}`);
      } catch (err) {
        toast(err.message, { type: 'err' });
      }
    };
    return html`<form onSubmit=${submit}>
      <h3>নতুন লেখক</h3>
      <label class="field"><span>লেখকের নাম</span>
        <input class="input" autofocus required placeholder="যেমন: সমরেশ মজুমদার" onInput=${(e) => { name = e.target.value; }} />
      </label>
      <p class="hint">লেখকের নামে একটি ফোল্ডার তৈরি হবে, সেখানে তাঁর বইগুলো রাখবেন।</p>
      <div class="btn-row" style="margin-top:14px">
        <button type="button" class="btn ghost" onClick=${close}>বাতিল</button>
        <button class="btn primary" type="submit"><${Icon} name="plus" /> তৈরি করুন</button>
      </div>
    </form>`;
  });
}

function SearchResults({ lib, results, q }) {
  const none = !results.books.length && !results.authors.length && !results.missing.length;
  if (none) {
    return html`<${Empty} title="কিছু পাওয়া যায়নি">
      <p>“${q}” নামে আপনার সংগ্রহে কোনো বই নেই।</p>
      <div class="btn-row" style="justify-content:center;max-width:420px;margin:0 auto">
        <a class="btn primary" href=${`#/new?title=${encodeURIComponent(q)}`}><${Icon} name="plus" /> এই নামে বই যোগ করুন</a>
        <a class="btn soft" href="#/scan?mode=search"><${Icon} name="camera" /> ক্যামেরায় খুঁজুন</a>
      </div>
    <//>`;
  }
  return html`<div>
    ${results.books.length > 0 && html`<div class="section-head"><h2>আপনার বই <span class="count">${bn(results.books.length)}</span></h2></div>
      <div class="notice ok" style="margin-bottom:10px"><${Icon} name="check" /><div><b>হ্যাঁ, আছে!</b> নিচের বইগুলো আপনার সংগ্রহে আছে।</div></div>
      <div class="book-list">${results.books.map((r) => html`<${BookRow} key=${r.book.id} book=${r.book} lib=${lib} showAuthor />`)}</div>`}
    ${results.authors.length > 0 && html`<div class="section-head"><h2>লেখক</h2></div>
      <div class="authors">${results.authors.map(({ author }) => html`<a class="author-card" href=${`#/a/${author.id}`} key=${author.id}>
        <${FlowerAvatar} name=${author.name} /><div class="nm">${author.name}</div>
        <div class="ct"><b>${bn(lib.stats.get(author.id)?.books || 0)}</b>টি বই</div></a>`)}</div>`}
    ${results.missing.length > 0 && html`<div class="section-head"><h2>সংগ্রহে নেই <span class="count">${bn(results.missing.length)}</span></h2></div>
      <p class="faint" style="margin:-4px 4px 8px">এগুলো সম্পূর্ণ তালিকায় আছে, কিন্তু এখনো আপনার কাছে নেই।</p>
      ${results.missing.map(({ entry, author }) => html`<a class="missing-item" key=${entry.id} href=${`#/a/${entry.authorId}/missing?focus=${entry.id}`} style="text-decoration:none;color:inherit">
        <div class="grow"><div class=${`t${/[a-z]/i.test(entry.title) ? ' latin' : ''}`}>${entry.title}</div><div class="m">${author?.name || ''}</div></div>
        <span class="badge gold">নেই</span></a>`)}`}
  </div>`;
}

function useSessionText(key) {
  const [v, setV] = useState(() => {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
  });
  const set = (nv) => {
    setV(nv);
    try { sessionStorage.setItem(key, nv); } catch { /* ignore */ }
  };
  return [v, set];
}

export function HomePage({ lib, cloudState }) {
  const [q, setQ] = useSessionText('mazedar:homeQuery');
  const dq = useDebounced(q, 110);
  const results = useMemo(() => searchLibrary(lib, dq), [lib, dq]);
  const [sort, setSort] = usePref('authorSort', 'name');

  const featured = lib.authors
    .filter((a) => (lib.stats.get(a.id)?.catalogTotal || 0) > 0)
    .sort((a, b) => (a.id === HUMAYUN_AUTHOR_ID ? -1 : b.id === HUMAYUN_AUTHOR_ID ? 1 : byName(a, b)));

  const authors = useMemo(() => {
    const list = [...lib.authors];
    if (sort === 'count') list.sort((a, b) => (lib.stats.get(b.id)?.books || 0) - (lib.stats.get(a.id)?.books || 0) || byName(a, b));
    else if (sort === 'recent') list.sort((a, b) => (lib.stats.get(b.id)?.lastAdded || 0) - (lib.stats.get(a.id)?.lastAdded || 0) || byName(a, b));
    else if (sort === 'za') list.sort((a, b) => byName(b, a));
    else list.sort(byName);
    return list;
  }, [lib, sort]);

  const recent = useMemo(() => [...lib.books].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || byTitle(a, b)).slice(0, 5), [lib]);

  return html`<div class="page">
    <header class="topbar">
      <a class="brand" href="#/" aria-label="মাজেদার লাইব্রেরি — প্রথম পাতা">
        <${Lily} size=${34} />
        <span class="brand-name">মাজেদার <b>লাইব্রেরি</b></span>
      </a>
      <${SyncPill} state=${cloudState} />
      <a class="icon-btn" href="#/settings" aria-label="সেটিংস"><${Icon} name="settings" /></a>
    </header>

    <section class="hero">
      <${Petals} />
      <div class="hero-lily"><${Lily} size=${170} tone="white" /></div>
      <div class="greet">${greeting()} 🌸</div>
      <div class="big">${bn(lib.totals.books)}টি বই</div>
      <div class="sub">আপনার লাইব্রেরিতে</div>
      <div class="stats">
        <span class="stat"><b>${bn(lib.totals.authors)}</b>জন লেখক</span>
        ${lib.totals.favorites > 0 && html`<span class="stat"><b>${bn(lib.totals.favorites)}</b>টি প্রিয়</span>`}
        ${lib.totals.read > 0 && html`<span class="stat"><b>${bn(lib.totals.read)}</b>টি পড়া শেষ</span>`}
        ${lib.totals.copies !== lib.totals.books && html`<span class="stat"><b>${bn(lib.totals.copies)}</b>টি কপি</span>`}
      </div>
    </section>

    <div class="searchbar" role="search">
      <${Icon} name="search" className="lead" />
      <input type="search" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="বই বা লেখক খুঁজুন… (বাংলা বা English)"
        aria-label="বই বা লেখক খুঁজুন" enterkeyhint="search" />
      ${q && html`<button class="icon-btn" onClick=${() => setQ('')} aria-label="মুছুন"><${Icon} name="close" /></button>`}
      <a class="icon-btn scan-in" href="#/scan?mode=search" aria-label="ক্যামেরা দিয়ে খুঁজুন"><${Icon} name="camera" /></a>
    </div>

    ${results ? html`<${SearchResults} lib=${lib} results=${results} q=${dq} />` : html`<div>
      <${InstallHint} />
      ${lib.dupes.length > 0 && html`<a href="#/dupes" style="text-decoration:none;color:inherit;display:block;margin-bottom:12px">
        <div class="notice warn"><${Icon} name="alert" /><div><b>${bn(lib.dupes.length)}টি বই দুবার আছে বলে মনে হচ্ছে।</b> দেখে নিতে এখানে চাপুন।</div></div></a>`}

      ${featured.map((a) => html`<${FeatureCard} key=${a.id} author=${a} st=${lib.stats.get(a.id)} />`)}

      <div class="section-head">
        <h2><${Icon} name="folder" size=${20} /> লেখকেরা <span class="count">${bn(lib.authors.length)}</span></h2>
        <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)} aria-label="সাজানোর ধরন">
          <option value="name">নাম: অ → হ</option>
          <option value="za">নাম: হ → অ</option>
          <option value="count">বেশি বই আগে</option>
          <option value="recent">সাম্প্রতিক</option>
        </select>
      </div>
      <div class="authors">
        ${authors.map((a) => html`<a class="author-card" href=${`#/a/${a.id}`} key=${a.id}>
          <${FlowerAvatar} name=${a.name} />
          <div class="nm">${a.name}</div>
          <div class="ct"><b>${bn(lib.stats.get(a.id)?.books || 0)}</b>টি বই</div>
        </a>`)}
        <button class="author-card add" onClick=${() => openAddAuthor(lib)}><${Icon} name="plus" size=${28} /> নতুন লেখক</button>
      </div>

      ${recent.length > 0 && html`<div class="section-head"><h2><${Icon} name="history" size=${20} /> সাম্প্রতিক যোগ করা</h2></div>
        <div class="book-list">${recent.map((b) => html`<${BookRow} key=${b.id} book=${b} lib=${lib} showAuthor />`)}</div>`}
    </div>`}

    <a class="fab" href="#/new"><${Icon} name="plus" /> বই যোগ</a>
  </div>`;
}

export { ctx };
