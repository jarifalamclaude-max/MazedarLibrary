import {
  html, useState, useMemo, useEffect, ctx, bn, navigate, Icon, LilyBloom, Empty, TopBar, usePref, useDebounced,
  openSheet, toast, confirmDialog, burst,
} from './core.js';
import {
  byTitle, groupById, GROUPS, LATER_GROUP, trashRecord, updateRecord, acquireEntry, addCatalogEntry, findAuthorByName, sortKeyOf,
} from './data.js';
import { searchScore, SEARCH_THRESHOLD } from '../lib/bangla.js';
import { canonical } from '../lib/merge.js';
import { BookRow } from './home.js';
import { openBookEditor } from './book.js';

const isLatin = (s) => /[a-z]/i.test(s || '') && !/[ঀ-৿]/.test(s || '');

function sortBooks(list, sort) {
  const out = [...list];
  if (sort === 'za') out.sort((a, b) => byTitle(b, a));
  else if (sort === 'serial') out.sort((a, b) => (a.serial ?? 1e9) - (b.serial ?? 1e9) || (a.createdAt || 0) - (b.createdAt || 0) || byTitle(a, b));
  else if (sort === 'recent') out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || byTitle(a, b));
  else if (sort === 'category') out.sort((a, b) => (sortKeyOf(a.category || '~') < sortKeyOf(b.category || '~') ? -1 : sortKeyOf(a.category || '~') > sortKeyOf(b.category || '~') ? 1 : byTitle(a, b)));
  else out.sort(byTitle);
  return out;
}

function matches(q, ...texts) {
  if (!q) return true;
  return texts.some((t) => t && searchScore(q, t) >= SEARCH_THRESHOLD);
}

function BooksTab({ lib, author, books }) {
  const [sort, setSort] = usePref('bookSort', 'az');
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 100);
  const cats = useMemo(() => {
    const m = new Map();
    for (const b of books) if (b.category) m.set(b.category, (m.get(b.category) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || (sortKeyOf(a[0]) < sortKeyOf(b[0]) ? -1 : 1));
  }, [books]);
  const favCount = books.filter((b) => b.favorite).length;
  const shown = useMemo(() => sortBooks(books.filter((b) => (
    (!cat || (cat === '♥' ? b.favorite : b.category === cat)) && matches(dq, b.title, b.originalEntry, b.notes, b.category)
  )), sort), [books, sort, cat, dq]);

  if (!books.length) {
    return html`<${Empty} title="এখনো কোনো বই নেই">
      <p>“${author.name}” ফোল্ডারে প্রথম বইটি যোগ করুন।</p>
      <div class="btn-row" style="max-width:420px;margin:0 auto">
        <button class="btn primary" onClick=${() => openBookEditor(lib, { authorId: author.id })}><${Icon} name="plus" /> বই যোগ</button>
        <a class="btn soft" href=${`#/scan?mode=add&author=${author.id}`}><${Icon} name="camera" /> ছবি তুলে যোগ</a>
      </div>
    <//>`;
  }
  return html`<div>
    <div class="toolbar">
      <label class="filter"><${Icon} name="search" />
        <input type="search" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="এই ফোল্ডারে খুঁজুন" aria-label="এই ফোল্ডারে খুঁজুন" />
      </label>
      <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)} aria-label="সাজানোর ধরন">
        <option value="az">অ → হ</option>
        <option value="za">হ → অ</option>
        <option value="serial">তালিকার ক্রমে</option>
        <option value="recent">সাম্প্রতিক</option>
        <option value="category">ধরন অনুযায়ী</option>
      </select>
    </div>
    ${(cats.length > 1 || favCount > 0) && html`<div class="chips" role="tablist">
      <button class=${`chip${!cat ? ' on' : ''}`} onClick=${() => setCat('')}>সব<span class="n">${bn(books.length)}</span></button>
      ${favCount > 0 && html`<button class=${`chip${cat === '♥' ? ' on' : ''}`} onClick=${() => setCat('♥')}>প্রিয়<span class="n">${bn(favCount)}</span></button>`}
      ${cats.map(([c, n]) => html`<button class=${`chip${cat === c ? ' on' : ''}`} onClick=${() => setCat(c)}>${c}<span class="n">${bn(n)}</span></button>`)}
    </div>`}
    ${shown.length === 0 && html`<p class="faint center">এই খোঁজে কোনো বই নেই।</p>`}
    <div class="book-list">${shown.map((b) => html`<${BookRow} key=${b.id} book=${b} lib=${lib} showSerial=${sort === 'serial'} />`)}</div>
  </div>`;
}

async function acquire(lib, entry, ev) {
  if (isLatin(entry.title)) {
    openBookEditor(lib, { authorId: entry.authorId, title: entry.title, catalogId: entry.id, latinHint: true });
    return;
  }
  const rect = ev?.currentTarget?.getBoundingClientRect?.();
  const book = await acquireEntry(entry);
  if (rect) burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
  toast(`“${entry.title}” সংগ্রহে যোগ হলো 🌸`, {
    type: 'ok',
    action: { label: 'ফিরিয়ে নিন', run: () => updateRecord(book.id, { deleted: true, deletedAt: Date.now(), purged: true }) },
  });
}

export function openCatalogEditor(lib, { entry = null, authorId }) {
  const isHumayun = (lib.catalogByAuthor.get(authorId) || []).some((e) => e.group);
  const st = { title: entry?.title || '', group: entry?.group ?? (isHumayun ? LATER_GROUP.id : ''), year: entry?.year ?? '', note: entry?.note || '', owned: false };
  const initial = { title: (entry?.title || '').normalize('NFC').trim(), group: entry?.group ?? '', year: entry?.year ?? null, note: (entry?.note || '').trim() };
  openSheet((close) => {
    const save = async (e) => {
      e.preventDefault();
      try {
        const year = String(st.year).replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).trim();
        const fields = { title: st.title.normalize('NFC').trim(), group: st.group, year: year ? Number(year) || null : null, note: st.note.trim() };
        if (!fields.title) throw new Error('বইয়ের নাম লিখুন');
        if (entry) {
          // only what changed in this sheet (an edit made meanwhile on the other phone survives)
          const changed = {};
          for (const k of Object.keys(fields)) if (canonical(fields[k]) !== canonical(initial[k])) changed[k] = fields[k];
          if (Object.keys(changed).length) await updateRecord(entry.id, changed);
          toast('তালিকা হালনাগাদ হলো', { type: 'ok' });
        } else {
          const created = await addCatalogEntry({ authorId, ...fields });
          if (st.owned) await acquireEntry(created);
          toast(st.owned ? 'তালিকায় ও সংগ্রহে যোগ হলো 🌸' : 'তালিকায় যোগ হলো — বাকির সংখ্যা ১ বাড়ল', { type: 'ok' });
        }
        close();
      } catch (err) {
        toast(err.message, { type: 'err' });
      }
    };
    const remove = async () => {
      const linked = lib.ownedByCatalog.get(entry.id) || [];
      const ok = await confirmDialog({
        title: 'তালিকা থেকে সরাবেন?',
        body: linked.length ? 'এই নামের বইটি আপনার সংগ্রহে আছে; বইটি থাকবে, শুধু সম্পূর্ণ তালিকা থেকে নামটি সরবে।' : 'নামটি সম্পূর্ণ তালিকা থেকে সরে যাবে (মুছে ফেলা জিনিসের তালিকা থেকে ফেরত আনা যাবে)।',
        ok: 'সরান', danger: true,
      });
      if (!ok) return;
      await trashRecord(lib, entry);
      close();
      toast('তালিকা থেকে সরানো হলো', { action: { label: 'ফিরিয়ে আনুন', run: () => updateRecord(entry.id, { deleted: false, deletedAt: null }) } });
    };
    return html`<form onSubmit=${save}>
      <h3>${entry ? 'তালিকার নাম সম্পাদনা' : 'সম্পূর্ণ তালিকায় নতুন বই'}</h3>
      <label class="field"><span>বইয়ের নাম</span>
        <input class="input book-font" required value=${st.title} onInput=${(e) => { st.title = e.target.value; }} autofocus />
      </label>
      ${isHumayun && html`<label class="field"><span>বিভাগ</span>
        <select class="select" style="width:100%" value=${st.group} onChange=${(e) => { st.group = e.target.value; }}>
          ${GROUPS.map((g) => html`<option value=${g.id}>${g.name}</option>`)}
        </select></label>`}
      <div class="row">
        <label class="field grow"><span>প্রকাশের সাল (ঐচ্ছিক)</span>
          <input class="input" inputmode="numeric" value=${st.year ? bn(st.year) : ''} onInput=${(e) => { st.year = e.target.value; }} />
        </label>
      </div>
      <label class="field"><span>টীকা (ঐচ্ছিক)</span>
        <input class="input" value=${st.note} onInput=${(e) => { st.note = e.target.value; }} />
      </label>
      ${!entry && html`<label class="switch"><input type="checkbox" onChange=${(e) => { st.owned = e.target.checked; }} /> এই বইটি আমার সংগ্রহেও আছে</label>`}
      <div class="btn-row" style="margin-top:12px">
        ${entry ? html`<button type="button" class="btn danger" onClick=${remove}><${Icon} name="trash" /> সরান</button>` : html`<button type="button" class="btn ghost" onClick=${close}>বাতিল</button>`}
        <button class="btn primary" type="submit"><${Icon} name="check" /> সংরক্ষণ</button>
      </div>
    </form>`;
  });
}

function groupEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    const g = e.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  return [...groups].sort((a, b) => (groupById.get(a[0])?.order ?? 99) - (groupById.get(b[0])?.order ?? 99))
    .map(([g, list]) => [g, list.sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || byTitle(x, y))]);
}

function EntryRow({ lib, e, focus }) {
  const owned = lib.ownedByCatalog.get(e.id);
  const meta = [e.year ? `${bn(e.year)}${e.yearDisputed ? '*' : ''}` : '', e.note].filter(Boolean).join(' · ');
  return html`<div class=${`missing-item${owned ? ' owned' : ''}`} id=${`e-${e.id}`} style=${focus ? 'outline:3px solid var(--rose-2)' : ''}>
    <span class=${`check${owned ? ' on' : ''}`}><${Icon} name=${owned ? 'check' : 'book'} /></span>
    <div class="grow" onClick=${() => (owned ? navigate(`/b/${owned[0].id}`) : openCatalogEditor(lib, { entry: e, authorId: e.authorId }))}>
      <div class=${`t${isLatin(e.title) ? ' latin' : ''}`}>${e.title}</div>
      ${(meta || owned) && html`<div class="m">${owned ? `সংগ্রহে আছে${owned.length > 1 ? ` (${bn(owned.length)}টি)` : ''}` : ''}${owned && meta ? ' · ' : ''}${meta}</div>`}
    </div>
    ${owned
      ? html`<button class="icon-btn" onClick=${() => openCatalogEditor(lib, { entry: e, authorId: e.authorId })} aria-label="তালিকার নাম সম্পাদনা"><${Icon} name="edit" /></button>`
      : html`<button class="btn leaf sm" onClick=${(ev) => acquire(lib, e, ev)}><${Icon} name="check" /> পেয়েছি</button>`}
  </div>`;
}

function CatalogTab({ lib, author, entries, onlyMissing, focus }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 100);
  const list = entries.filter((e) => (!onlyMissing || !lib.ownedByCatalog.has(e.id)) && matches(dq, e.title, e.note));
  const grouped = groupEntries(list);
  useEffect(() => {
    if (focus) setTimeout(() => document.getElementById(`e-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
  }, [focus]);
  return html`<div>
    <div class="toolbar">
      <label class="filter"><${Icon} name="search" />
        <input type="search" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="তালিকায় খুঁজুন" aria-label="তালিকায় খুঁজুন" />
      </label>
      <button class="btn soft sm" onClick=${() => openCatalogEditor(lib, { authorId: author.id })}><${Icon} name="plus" /> নতুন নাম</button>
    </div>
    ${onlyMissing && !list.length && !dq && html`<${Empty} title="সব বই সংগ্রহে আছে! 🌸"><p>সম্পূর্ণ তালিকার প্রতিটি বই আপনার কাছে আছে।</p><//>`}
    ${grouped.map(([g, items]) => html`<div class="group" key=${g}>
      <div class="group-h">${groupById.get(g)?.name || 'তালিকা'} <span class="n">${bn(items.length)}টি</span></div>
      ${items.map((e) => html`<${EntryRow} key=${e.id} lib=${lib} e=${e} focus=${focus === e.id} />`)}
    </div>`)}
  </div>`;
}

function openAuthorMenu(lib, author) {
  const hasCatalog = (lib.catalogByAuthor.get(author.id) || []).length > 0;
  openSheet((close) => html`<div>
    <h3>${author.name}</h3>
    <div class="card">
      <button class="set-item" onClick=${() => { close(); renameAuthor(lib, author); }}>
        <span class="ic"><${Icon} name="edit" /></span><span class="tx"><b>নাম বদলান</b></span></button>
      ${!hasCatalog && html`<button class="set-item" onClick=${() => { close(); openCatalogEditor(lib, { authorId: author.id }); }}>
        <span class="ic"><${Icon} name="list" /></span><span class="tx"><b>সম্পূর্ণ তালিকা শুরু করুন</b>
        <small>লেখকের সব বইয়ের নাম রাখুন — কোনগুলো এখনো নেই তা গুনে দেখাবে</small></span></button>`}
      <button class="set-item" onClick=${async () => {
        close();
        const n = (lib.booksByAuthor.get(author.id) || []).length;
        const ok = await confirmDialog({ title: `“${author.name}” ফোল্ডার মুছবেন?`, body: n ? `ফোল্ডারের ${bn(n)}টি বইও মুছে ফেলা জিনিসের তালিকায় যাবে। পরে ফেরত আনা যাবে।` : 'পরে ফেরত আনা যাবে।', ok: 'মুছুন', danger: true });
        if (!ok) return;
        await trashRecord(lib, author);
        navigate('/', { replace: true });
        toast('ফোল্ডার মুছে ফেলা হয়েছে', { action: { label: 'ফিরিয়ে আনুন', run: () => navigate('/trash') } });
      }}><span class="ic" style="background:var(--danger-soft);color:var(--danger)"><${Icon} name="trash" /></span><span class="tx"><b>ফোল্ডার মুছুন</b></span></button>
    </div>
  </div>`);
}

function renameAuthor(lib, author) {
  let name = author.name;
  openSheet((close) => html`<form onSubmit=${async (e) => {
    e.preventDefault();
    const clean = name.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    const other = findAuthorByName(lib, clean);
    if (other && other.id !== author.id) {
      toast(`“${other.name}” নামে আরেকটি ফোল্ডার আগে থেকেই আছে`, { type: 'err' });
      return;
    }
    await updateRecord(author.id, { name: clean });
    close();
    toast('নাম বদলানো হলো', { type: 'ok' });
  }}>
    <h3>লেখকের নাম বদলান</h3>
    <label class="field"><span>নাম</span><input class="input" value=${name} onInput=${(e) => { name = e.target.value; }} autofocus /></label>
    <div class="btn-row"><button type="button" class="btn ghost" onClick=${close}>বাতিল</button><button class="btn primary">সংরক্ষণ</button></div>
  </form>`);
}

export function AuthorPage({ lib, id, tab = 'books', query = {} }) {
  const author = lib.authorById.get(id);
  if (!author) {
    return html`<div class="page"><${TopBar} title="লেখক" /><${Empty} title="এই লেখক পাওয়া যায়নি"><p>হয়তো ফোল্ডারটি মুছে ফেলা হয়েছে। <a href="#/trash">মুছে ফেলা জিনিস দেখুন</a></p><//></div>`;
  }
  const books = lib.booksByAuthor.get(id) || [];
  const entries = lib.catalogByAuthor.get(id) || [];
  const st = lib.stats.get(id);
  const hasCatalog = entries.length > 0;
  const current = hasCatalog ? tab : 'books';
  const v = st.catalogTotal ? st.catalogOwned / st.catalogTotal : 0;

  return html`<div class="page">
    <${TopBar} title=${author.name} bookTitle right=${html`<button class="icon-btn" onClick=${() => openAuthorMenu(lib, author)} aria-label="আরো"><${Icon} name="more" /></button>`} />

    ${hasCatalog ? html`<div class="feature" style="margin-top:14px">
      <${LilyBloom} value=${v} label=${`সম্পূর্ণ তালিকার ${bn(Math.round(v * 100))} শতাংশ সংগ্রহে`} />
      <div class="who">
        <div class="lines">সংগ্রহে <b>${bn(st.books)}</b>টি বই${st.copies !== st.books ? ` (${bn(st.copies)} কপি)` : ''}</div>
        <div class="lines">সম্পূর্ণ তালিকার <b>${bn(st.catalogOwned)}</b> / ${bn(st.catalogTotal)}টি আছে</div>
        ${st.remaining > 0
          ? html`<div class="need"><${Icon} name="sparkle" size=${16} /><span>সব পেতে আরো লাগবে <b>${bn(st.remaining)}</b>টি</span></div>`
          : html`<div class="need" style="background:var(--leaf-soft)">🌸 সম্পূর্ণ সংগ্রহ!</div>`}
        <div class="bar"><i style=${`width:${(v * 100).toFixed(1)}%`} /></div>
      </div>
    </div>` : html`<div class="row" style="margin:14px 2px 4px">
      <span class="badge rose" style="font-size:14px;padding:4px 12px">${bn(st.books)}টি বই</span>
      ${st.copies !== st.books && html`<span class="badge lilac" style="font-size:14px;padding:4px 12px">${bn(st.copies)} কপি</span>`}
    </div>`}

    ${hasCatalog && html`<div class="tabs" role="tablist">
      <button class=${`tab${current === 'books' ? ' on' : ''}`} onClick=${() => navigate(`/a/${id}`, { replace: true })} role="tab">আমার বই<small>${bn(st.books)}টি</small></button>
      <button class=${`tab${current === 'missing' ? ' on' : ''}`} onClick=${() => navigate(`/a/${id}/missing`, { replace: true })} role="tab">সংগ্রহে নেই<small>${bn(st.remaining)}টি</small></button>
      <button class=${`tab${current === 'list' ? ' on' : ''}`} onClick=${() => navigate(`/a/${id}/list`, { replace: true })} role="tab">সম্পূর্ণ তালিকা<small>${bn(st.catalogTotal)}টি</small></button>
    </div>`}

    ${current === 'books' && html`<${BooksTab} lib=${lib} author=${author} books=${books} />`}
    ${current === 'missing' && html`<${CatalogTab} lib=${lib} author=${author} entries=${entries} onlyMissing focus=${query.focus} />`}
    ${current === 'list' && html`<${CatalogTab} lib=${lib} author=${author} entries=${entries} focus=${query.focus} />`}

    <button class="fab" onClick=${() => openBookEditor(lib, { authorId: id })}><${Icon} name="plus" /> বই যোগ</button>
  </div>`;
}

export { ctx };
