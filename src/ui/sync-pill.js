import { html, bn, Icon } from './core.js';

/** Small status pill: where the data lives right now and whether it is synced. */
export function SyncPill({ state }) {
  const s = state || {};
  let cls = '';
  let icon = 'storage';
  let text = 'এই ডিভাইসে';
  if (!s.configured || s.phase === 'off') {
    // local mode
  } else if (s.phase === 'loading' || s.phase === 'busy') {
    cls = 'busy'; icon = 'refresh'; text = 'সংযোগ হচ্ছে…';
  } else if (s.phase === 'signed-out') {
    cls = 'off'; icon = 'user'; text = 'লগইন করুন';
  } else if (s.phase === 'needs-switch' || s.phase === 'error') {
    cls = 'err'; icon = 'alert'; text = 'সমস্যা';
  } else if (s.phase === 'signed-in') {
    const sync = s.sync || {};
    if (sync.state === 'synced') { cls = 'ok'; icon = 'cloud'; text = 'সিঙ্ক হয়েছে'; }
    else if (sync.state === 'offline') {
      cls = 'off'; icon = 'cloudOff';
      text = sync.pending ? `অফলাইন · ${bn(sync.pending)}টি জমা` : 'অফলাইন';
    } else if (sync.state === 'error') { cls = 'err'; icon = 'alert'; text = 'সিঙ্ক সমস্যা'; }
    else { cls = 'busy'; icon = 'refresh'; text = 'সিঙ্ক হচ্ছে…'; }
  }
  return html`<a class=${`sync ${cls}`} href="#/settings" aria-label=${`ক্লাউড: ${text}`}>
    <${Icon} name=${icon} className=${icon === 'refresh' ? 'spin' : ''} /><span>${text}</span>
  </a>`;
}
