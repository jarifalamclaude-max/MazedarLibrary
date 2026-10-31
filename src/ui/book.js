import {
  html, useState, useMemo, useRef, useEffect, ctx, bn, bnDate, navigate, goBack, Icon, Cover, Empty, TopBar, Notice,
  openSheet, toast, confirmDialog, burst,
} from './core.js';
import {
  useLib, getLib, byName, addAuthor, addBook, updateRecord, trashRecord, restoreRecord, addCatalogEntry, findSimilarBooks, suggestCatalog,
  groupById, HUMAYUN_AUTHOR_ID, categoryForCatalogEntry, isbnDigits,
} from './data.js';
import { canonical } from '../lib/merge.js';
import { similarity } from '../lib/bangla.js';
import { LEVELS } from '../lib/matcher.js';
import { imageFileToCanvas, canvasToJpegDataUrl } from '../lib/camera.js';

const READ = [['', 'পড়া হয়নি'], ['reading', 'পড়ছি'], ['read', 'পড়া শেষ']];
const CATEGORY_SUGGESTIONS = ['উপন্যাস', 'গল্পগ্রন্থ', 'কবিতা', 'সায়েন্স ফিকশন', 'থ্রিলার', 'রহস্য', 'শিশু-কিশোর', 'আত্মজীবনী', 'ভ্রমণ', 'প্রবন্ধ', 'ইতিহাস', 'ধর্ম', 'অনুবাদ', 'নাটক'];

function cleanText(s) {
  return String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** The editable fields of the form, normalised the way they are saved (for change detection). */
function formFields(f) {
  return {
    title: cleanText(f.title),
    category: cleanText(f.category),
    publisher: cleanText(f.publisher),
    isbn: isbnDigits(f.isbn),
    copies: Math.max(1, Math.min(99, Number(f.copies) || 1)),
    notes: String(f.notes || '').trim(),
    favorite: !!f.favorite,
    readStatus: f.readStatus || '',
  };
}

/** Ask what to do when the book already exists. Resolves 'copy' | 'separate' | null. */
function askDuplicate(existing, authorName) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => {
      if (!done) { done = true; resolve(v); }
      close?.();
    };
    openSheet((close) => html`<div>
      <h3>এই বইটি আগে থেকেই আছে</h3>
      <div class="book" style="margin-bottom:12px"><${Cover} book=${existing} /><div class="grow"><div class="t">${existing.title}</div><div class="m">${authorName}${(existing.copies || 1) > 1 ? ` · ${bn(existing.copies)} কপি` : ''}</div></div></div>
      <p class="muted" style="margin-top:0">আরেকটি কপি পেয়েছেন? তাহলে কপির সংখ্যা বাড়ানোই ভালো — বই দুবার দেখাবে না।</p>
      <div class="stack">
        <button class="btn primary block" onClick=${() => finish('copy', close)}><${Icon} name="plus" /> কপি সংখ্যা ১ বাড়ান</button>
        <button class="btn soft block" onClick=${() => finish('separate', close)}>আলাদা বই হিসেবেই যোগ করুন</button>
        <button class="btn ghost block" onClick=${() => finish(null, close)}>বাতিল</button>
      </div>
    </div>`, { onClose: () => finish(null) });
  });
}

function BookEditor({ init, close }) {
  const lib = useLib();
  const editing = init.book || null;
  const [f, setF] = useState(() => ({
    title: editing?.title ?? init.title ?? '',
    authorId: editing?.authorId ?? (init.authorId || (init.authorName ? '__new' : '')),
    newAuthor: init.authorName || '',
    category: editing?.category ?? init.category ?? '',
    publisher: editing?.publisher ?? '',
    isbn: editing?.isbn ?? init.isbn ?? '',
    copies: Number(editing?.copies) || 1,
    notes: editing?.notes ?? '',
    favorite: !!editing?.favorite,
    readStatus: editing?.readStatus ?? '',
    catalogId: editing ? editing.catalogId ?? null : init.catalogId ?? null,
    addToList: !editing,
    keepCover: !!init.coverDataUrl,
    pickList: false,
  }));
  const [busy, setBusy] = useState(false);
  const initialForm = useRef(f); // what the sheet showed when it opened
  const set = (patch) => setF((p) => ({ ...p, ...patch }));

  const authors = useMemo(() => [...lib.authors].sort(byName), [lib]);
  const authorId = f.authorId === '__new' ? null : f.authorId;
  const entries = authorId ? lib.catalogByAuthor.get(authorId) || [] : [];
  const linked = f.catalogId ? lib.catalogById.get(f.catalogId) : null;
  const suggestion = useMemo(() => (!f.catalogId && authorId && entries.length ? suggestCatalog(lib, authorId, f.title) : null), [lib, authorId, f.title, f.catalogId]);
  const similar = useMemo(() => findSimilarBooks(lib, { authorId, title: f.title, catalogId: f.catalogId, excludeId: editing?.id }), [lib, authorId, f.title, f.catalogId]);
  const categories = useMemo(() => [...new Set([...lib.books.map((b) => b.category).filter(Boolean), ...CATEGORY_SUGGESTIONS])], [lib]);
  // An exact match with an unowned list entry links itself (the user can still change it).
  useEffect(() => {
    if (!editing && !f.catalogId && !f.unlinked && suggestion?.level === 'exact') set({ catalogId: suggestion.entry.id, autoLinked: true });
  }, [suggestion?.entry?.id, suggestion?.level]);
  // ...and unlinks itself again if the title is then changed into a different book.
  const onTitle = (title) => {
    const patch = { title };
    if (f.autoLinked && linked && similarity(title, linked.title) < LEVELS.strong) Object.assign(patch, { catalogId: null, autoLinked: false });
    set(patch);
  };
  const pickable = useMemo(() => {
    if (!f.pickList) return [];
    return entries.map((e) => ({ e, s: similarity(f.title || '', e.title) })).sort((a, b) => b.s - a.s).slice(0, 40);
  }, [f.pickList, entries, f.title]);

  const save = async (ev) => {
    ev?.preventDefault();
    if (busy) return;
    const title = cleanText(f.title);
    if (!title) return toast('বইয়ের নাম লিখুন', { type: 'err' });
    if (!f.authorId || (f.authorId === '__new' && !cleanText(f.newAuthor))) return toast('লেখক বেছে নিন বা নতুন লেখকের নাম লিখুন', { type: 'err' });
    setBusy(true);
    try {
      let aid = f.authorId;
      if (aid === '__new') aid = (await addAuthor(lib, f.newAuthor)).id;
      const authorName = lib.authorById.get(aid)?.name || cleanText(f.newAuthor);

      if (!editing) {
        const dup = findSimilarBooks(getFreshLib(), { authorId: aid, title, catalogId: f.catalogId }).find((d) => d.score >= 0.93 || (f.catalogId && d.book.catalogId === f.catalogId));
        if (dup) {
          const choice = await askDuplicate(dup.book, authorName);
          if (!choice) return;
          if (choice === 'copy') {
            await updateRecord(dup.book.id, { copies: (Number(dup.book.copies) || 1) + 1 });
            close();
            toast(`“${dup.book.title}” — এখন ${bn((Number(dup.book.copies) || 1) + 1)} কপি`, { type: 'ok' });
            init.onSaved?.(dup.book);
            return;
          }
        }
      }

      let catalogId = f.catalogId;
      const authorEntries = getFreshLib().catalogByAuthor.get(aid) || [];
      if (!catalogId && !editing && authorEntries.length) {
        // The exact title is already on the list (perhaps owned: a second copy or edition): link, never duplicate.
        const same = suggestCatalog(getFreshLib(), aid, title, { includeOwned: true });
        if (same?.level === 'exact') catalogId = same.entry.id;
      }
      // A new list entry only when the user saw the tick-box (not while a "এটি কি…?" question is shown).
      if (!catalogId && !editing && f.addToList && !suggestion && authorEntries.length) {
        const created = await addCatalogEntry({ authorId: aid, title, group: aid === HUMAYUN_AUTHOR_ID ? 'g13' : '' });
        catalogId = created.id;
      }
      const entry = catalogId ? getFreshLib().catalogById.get(catalogId) : null;
      const fields = {
        title,
        authorId: aid,
        category: cleanText(f.category) || (!editing && entry ? categoryForCatalogEntry(entry) : ''),
        publisher: cleanText(f.publisher),
        isbn: isbnDigits(f.isbn),
        copies: Math.max(1, Math.min(99, Number(f.copies) || 1)),
        notes: String(f.notes || '').trim(),
        favorite: !!f.favorite,
        readStatus: f.readStatus,
        catalogId: catalogId || null,
      };
      let book;
      if (editing) {
        // Send only what was changed in this sheet, so a field edited meanwhile on
        // the other phone (or tab) is not overwritten with the value shown at opening.
        const before = formFields(initialForm.current);
        const now = formFields(f);
        const changed = {};
        for (const k of Object.keys(now)) if (canonical(now[k]) !== canonical(before[k])) changed[k] = fields[k];
        if (aid !== editing.authorId) changed.authorId = aid;
        if ((catalogId || null) !== (editing.catalogId || null)) changed.catalogId = catalogId || null;
        book = Object.keys(changed).length ? await updateRecord(editing.id, changed) : editing;
      } else {
        book = await addBook({ ...fields, addedVia: init.addedVia || 'manual' });
        if (init.coverDataUrl && f.keepCover) await ctx.store.setCover(book.id, init.coverDataUrl);
        burst();
      }
      close();
      toast(editing ? 'সংরক্ষণ হয়েছে' : `“${title}” যোগ হলো 🌸`, {
        type: 'ok',
        action: editing ? null : { label: 'দেখুন', run: () => navigate(`/b/${book.id}`) },
      });
      init.onSaved?.(book);
    } catch (err) {
      toast(err.message || String(err), { type: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return html`<form onSubmit=${save}>
    <h3>${editing ? 'বইয়ের তথ্য সম্পাদনা' : 'নতুন বই যোগ'}</h3>
    ${init.coverDataUrl && html`<div class="row" style="margin-bottom:12px">
      <img src=${init.coverDataUrl} alt="তোলা ছবি" style="width:64px;height:90px;object-fit:cover;border-radius:10px" />
      <label class="switch grow"><input type="checkbox" checked=${f.keepCover} onChange=${(e) => set({ keepCover: e.target.checked })} /> এই ছবিটা কভার হিসেবে রাখুন</label>
    </div>`}

    <label class="field"><span>বইয়ের নাম</span>
      <div class="row">
        <input class="input book-font grow" required value=${f.title} onInput=${(e) => onTitle(e.target.value)} autofocus=${!f.title} placeholder="যেমন: দেয়াল" />
        ${!editing && html`<a class="icon-btn" style="background:var(--rose-soft);color:var(--rose)" href=${`#/scan?mode=add${authorId ? `&author=${authorId}` : ''}`} onClick=${close} aria-label="ক্যামেরা দিয়ে নাম পড়ুন"><${Icon} name="camera" /></a>`}
      </div>
      ${init.latinHint && html`<div class="hint">তালিকায় নামটি ইংরেজি বানানে আছে — চাইলে বাংলায় লিখে দিন।</div>`}
    </label>

    ${similar.length > 0 && html`<div style="margin:-6px 0 12px"><${Notice} kind="warn" icon="alert">
      <b>সাবধান — প্রায় একই নামের বই আগে থেকেই আছে:</b>
      ${similar.map((s) => html`<div><a href=${`#/b/${s.book.id}`} onClick=${close}>${s.book.title}</a> · ${lib.authorById.get(s.book.authorId)?.name || ''}</div>`)}
    <//></div>`}

    <label class="field"><span>লেখক</span>
      <select class="select" style="width:100%" value=${f.authorId} onChange=${(e) => set({ authorId: e.target.value, catalogId: null, pickList: false })} required>
        <option value="" disabled>লেখক বেছে নিন…</option>
        ${authors.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
        <option value="__new">+ নতুন লেখক…</option>
      </select>
    </label>
    ${f.authorId === '__new' && html`<label class="field"><span>নতুন লেখকের নাম</span>
      <input class="input" value=${f.newAuthor} onInput=${(e) => set({ newAuthor: e.target.value })} placeholder="যেমন: সমরেশ মজুমদার" /></label>`}

    ${entries.length > 0 && html`<div class="card pad" style="margin-bottom:14px;background:var(--surface-2)">
      <div class="faint" style="margin-bottom:6px">সম্পূর্ণ তালিকার সাথে মিল (গণনা ঠিক রাখতে)</div>
      ${linked ? html`<div class="row wrap">
          <span class="badge leaf"><${Icon} name="check" /> যুক্ত</span>
          <span class="grow" style="font-family:var(--font-book);font-size:17px">${linked.title}</span>
          <button type="button" class="btn ghost sm" onClick=${() => set({ catalogId: null, pickList: true, unlinked: true, autoLinked: false })}>বদলান</button>
        </div>
        <div class="hint">${groupById.get(linked.group)?.name || ''}</div>`
      : suggestion ? html`<div class="row wrap">
          <span class="grow">এটি কি তালিকার <b style="font-family:var(--font-book)">“${suggestion.entry.title}”</b>?</span>
          <button type="button" class="btn leaf sm" onClick=${() => set({ catalogId: suggestion.entry.id, pickList: false, autoLinked: false })}>হ্যাঁ</button>
          <button type="button" class="btn ghost sm" onClick=${() => set({ pickList: true })}>অন্যটা</button>
        </div>`
      : html`<div>
          ${!editing && html`<label class="switch"><input type="checkbox" checked=${f.addToList} onChange=${(e) => set({ addToList: e.target.checked })} />
            তালিকায় নেই — সম্পূর্ণ তালিকায়ও যোগ করুন</label>`}
          <button type="button" class="btn ghost sm" onClick=${() => set({ pickList: !f.pickList })}>তালিকা থেকে বেছে নিন</button>
        </div>`}
      ${f.pickList && !linked && html`<select class="select" style="width:100%;margin-top:8px" onChange=${(e) => e.target.value && set({ catalogId: e.target.value, pickList: false })}>
        <option value="">তালিকার নাম বেছে নিন…</option>
        ${pickable.map(({ e }) => html`<option value=${e.id}>${e.title}${lib.ownedByCatalog.has(e.id) ? ' ✓' : ''}</option>`)}
      </select>`}
    </div>`}

    <label class="field"><span>ধরন</span>
      <input class="input" list="cat-suggestions" value=${f.category} onInput=${(e) => set({ category: e.target.value })} placeholder="যেমন: উপন্যাস" />
      <datalist id="cat-suggestions">${categories.map((c) => html`<option value=${c} />`)}</datalist>
    </label>

    <div class="field"><span style="display:block;font-size:14px;font-weight:600;color:var(--ink-2);margin-bottom:5px">পড়ার অবস্থা</span>
      <div class="seg">${READ.map(([v, label]) => html`<button type="button" class=${f.readStatus === v ? 'on' : ''} onClick=${() => set({ readStatus: v })}>${label}</button>`)}</div>
    </div>

    <div class="row wrap" style="margin-bottom:12px">
      <div class="grow">
        <span style="display:block;font-size:14px;font-weight:600;color:var(--ink-2);margin-bottom:5px">কপি</span>
        <div class="stepper">
          <button type="button" onClick=${() => set({ copies: Math.max(1, f.copies - 1) })} aria-label="কমান">−</button>
          <output>${bn(f.copies)}</output>
          <button type="button" onClick=${() => set({ copies: Math.min(99, f.copies + 1) })} aria-label="বাড়ান">+</button>
        </div>
      </div>
      <label class="switch"><input type="checkbox" checked=${f.favorite} onChange=${(e) => set({ favorite: e.target.checked })} /> প্রিয় বই ❤</label>
    </div>

    <details style="margin-bottom:12px">
      <summary class="faint" style="cursor:pointer;margin-bottom:10px">আরো তথ্য (প্রকাশনী, ISBN, নোট)</summary>
      <label class="field"><span>প্রকাশনী</span><input class="input" value=${f.publisher} onInput=${(e) => set({ publisher: e.target.value })} placeholder="যেমন: অন্যপ্রকাশ" /></label>
      <label class="field"><span>ISBN</span><input class="input" inputmode="numeric" value=${f.isbn} onInput=${(e) => set({ isbn: e.target.value })} /></label>
      <label class="field"><span>নোট</span><textarea class="textarea" value=${f.notes} onInput=${(e) => set({ notes: e.target.value })} placeholder="কে উপহার দিয়েছে, কোথা থেকে কেনা…" /></label>
    </details>

    <div class="btn-row">
      <button type="button" class="btn ghost" onClick=${close}>বাতিল</button>
      <button class="btn primary" type="submit" disabled=${busy}><${Icon} name="check" /> ${editing ? 'সংরক্ষণ' : 'যোগ করুন'}</button>
    </div>
  </form>`;
}

// After an await the store may have changed (e.g. a new author was created).
const getFreshLib = getLib;

/**
 * Open the add/edit book sheet.
 * init: { book?, authorId?, authorName?, title?, catalogId?, category?, isbn?, coverDataUrl?, addedVia?, latinHint?, onSaved? }
 */
export function openBookEditor(_lib, init = {}) {
  return openSheet((close) => html`<${BookEditor} init=${init} close=${close} />`);
}

function CoverActions({ book }) {
  const input = useRef();
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const canvas = await imageFileToCanvas(file, 2000);
      const data = canvasToJpegDataUrl(canvas, 900, 0.82);
      await ctx.store.setCover(book.id, data);
      toast('কভারের ছবি রাখা হলো', { type: 'ok' });
    } catch (err) {
      toast(`ছবিটি নেওয়া যায়নি: ${err.message || err}`, { type: 'err' });
    }
  };
  return html`<div class="row wrap" style="gap:8px">
    <input ref=${input} type="file" accept="image/*" class="sr-only" onChange=${pick} />
    <button class="btn soft sm" onClick=${() => input.current.click()}><${Icon} name="camera" /> ${book.hasCover ? 'ছবি বদলান' : 'কভারের ছবি'}</button>
    ${book.hasCover && html`<button class="btn ghost sm" onClick=${async () => { await ctx.store.setCover(book.id, null); toast('ছবি সরানো হলো'); }}>ছবি সরান</button>`}
  </div>`;
}

export function BookPage({ lib, id }) {
  const book = lib.records.get(id);
  if (!book || book.kind !== 'book' || book.purged) {
    return html`<div class="page"><${TopBar} title="বই" /><${Empty} title="বইটি পাওয়া যায়নি" /></div>`;
  }
  const author = lib.records.get(book.authorId);
  const entry = book.catalogId ? lib.catalogById.get(book.catalogId) : null;
  const dup = lib.dupes.find((d) => d.a.id === id || d.b.id === id);

  const quick = (changes, msg) => updateRecord(id, changes).then(() => msg && toast(msg, { type: 'ok' }));
  const remove = async () => {
    const ok = await confirmDialog({ title: 'বইটি মুছে ফেলবেন?', body: 'মুছে ফেলা জিনিসের তালিকা থেকে পরে ফেরত আনা যাবে।', ok: 'মুছুন', danger: true });
    if (!ok) return;
    await trashRecord(lib, book);
    goBack(`/a/${book.authorId}`);
    toast(`“${book.title}” মুছে ফেলা হয়েছে`, { action: { label: 'ফিরিয়ে আনুন', run: () => restoreRecord(lib, book) } });
  };

  return html`<div class="page">
    <${TopBar} title=${book.title} bookTitle backTo=${`/a/${book.authorId}`}
      right=${!book.deleted && html`<button class="icon-btn" onClick=${() => openBookEditor(lib, { book })} aria-label="সম্পাদনা"><${Icon} name="edit" /></button>`} />

    ${book.deleted && html`<div style="margin-top:12px"><${Notice} kind="warn" icon="trash">
      এই বইটি মুছে ফেলা হয়েছে। <button class="btn soft sm" onClick=${() => restoreRecord(lib, book)}>ফিরিয়ে আনুন</button><//></div>`}

    <div class="detail-head">
      <${Cover} book=${book} large />
      <div class="grow">
        <div class="t">${book.title}</div>
        ${author && html`<a class="a" href=${`#/a/${author.id}`}>${author.name}</a>`}
        <div class="row wrap" style="margin-top:8px;gap:6px">
          ${book.category && html`<span class="badge rose">${book.category}</span>`}
          ${(Number(book.copies) || 1) > 1 && html`<span class="badge lilac">${bn(book.copies)} কপি</span>`}
          ${entry && html`<span class="badge leaf"><${Icon} name="check" /> তালিকায় আছে</span>`}
        </div>
      </div>
    </div>

    ${dup && html`<div style="margin-bottom:12px"><a href="#/dupes" style="text-decoration:none;color:inherit"><${Notice} kind="warn" icon="alert">
      এই বইটি দুবার আছে বলে মনে হচ্ছে — <b>${(dup.a.id === id ? dup.b : dup.a).title}</b>। দেখতে চাপুন।<//></a></div>`}

    ${!book.deleted && html`<div class="card pad stack">
      <div class="row wrap" style="justify-content:space-between">
        <div class="seg" role="group" aria-label="পড়ার অবস্থা">${READ.map(([v, label]) => html`<button class=${(book.readStatus || '') === v ? 'on' : ''} onClick=${() => quick({ readStatus: v })}>${label}</button>`)}</div>
        <button class=${`btn sm ${book.favorite ? 'primary' : 'soft'}`} onClick=${() => quick({ favorite: !book.favorite }, book.favorite ? '' : 'প্রিয় তালিকায় রাখা হলো ❤')}>
          <${Icon} name=${book.favorite ? 'heart-fill' : 'heart'} /> প্রিয়</button>
      </div>
      <${CoverActions} book=${book} />
    </div>`}

    <div class="card pad" style="margin-top:12px">
      <dl class="kv">
        ${entry && html`<dt>সম্পূর্ণ তালিকায়</dt><dd style="font-family:var(--font-book)">${entry.title}<div class="faint">${groupById.get(entry.group)?.name || ''}${entry.year ? ` · ${bn(entry.year)}` : ''}</div></dd>`}
        ${book.publisher && html`<dt>প্রকাশনী</dt><dd>${book.publisher}</dd>`}
        ${book.isbn && html`<dt>ISBN</dt><dd>${bn(book.isbn)}</dd>`}
        ${book.notes && html`<dt>নোট</dt><dd style="white-space:pre-wrap">${book.notes}</dd>`}
        <dt>যোগ করা হয়েছে</dt><dd>${bnDate(book.createdAt)}${book.addedVia === 'scan' ? ' · স্ক্যান করে' : ''}</dd>
        ${book.serial && html`<dt>প্রথম তালিকার ক্রম</dt><dd>${bn(book.serial)}</dd>`}
        ${book.originalEntry && book.originalEntry.normalize('NFC') !== book.title.normalize('NFC') && html`<dt>প্রথম তালিকায় লেখা ছিল</dt><dd>${book.originalEntry}</dd>`}
      </dl>
    </div>

    ${!book.deleted && html`<div class="btn-row" style="margin-top:16px">
      <button class="btn soft" onClick=${() => openBookEditor(lib, { book })}><${Icon} name="edit" /> সম্পাদনা</button>
      <button class="btn danger" onClick=${remove}><${Icon} name="trash" /> মুছে ফেলুন</button>
    </div>`}
  </div>`;
}

/** Route #/new?author=&title= opens the editor over the previous page. */
export function NewBookRoute({ lib, query }) {
  const opened = useRef(false);
  if (!opened.current) {
    opened.current = true;
    setTimeout(() => {
      navigate(query.author ? `/a/${query.author}` : '/', { replace: true });
      openBookEditor(lib, { authorId: query.author || '', title: query.title || '' });
    }, 0);
  }
  return null;
}

export { similarity };
