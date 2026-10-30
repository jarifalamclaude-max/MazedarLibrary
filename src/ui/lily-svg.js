// Static SVG markup of the lily (no DOM needed) for icons, the splash screen
// and the favicon. Mirrors the <Lily> component in core.js.
const PETAL = 'M0 2 C -12 -10, -17 -30, -3.5 -52 Q 0 -57, 3.5 -52 C 17 -30, 12 -10, 0 2 Z';
const PETAL_BACK = 'M0 2 C -10 -12, -14 -30, -3 -48 Q 0 -52, 3 -48 C 14 -30, 10 -12, 0 2 Z';

export function lilyMarkup({ id = 'l', tone = 'pink' } = {}) {
  const front = tone === 'white' ? ['#ffffff', '#fff3f7', '#f7c6d8'] : ['#fff6fa', '#ffc4da', '#e34f86'];
  const back = tone === 'white' ? ['#ffffff', '#fbe9f0', '#f0b7cb'] : ['#fff9fb', '#ffd9e7', '#ee86ab'];
  const spots = [[-3, -16], [2.5, -21], [-1.5, -27], [3, -11], [-4, -23]];
  return `<defs>
<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="-54" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${front[2]}"/><stop offset="0.45" stop-color="${front[1]}"/><stop offset="1" stop-color="${front[0]}"/></linearGradient>
<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="-50" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${back[2]}"/><stop offset="0.5" stop-color="${back[1]}"/><stop offset="1" stop-color="${back[0]}"/></linearGradient>
</defs>
${[30, 150, 270].map((a) => `<path d="${PETAL_BACK}" fill="url(#${id}b)" stroke="#e98fb2" stroke-width="0.6" transform="rotate(${a}) scale(0.94)"/>`).join('')}
${[90, 210, 330].map((a) => `<g transform="rotate(${a})"><path d="${PETAL}" fill="url(#${id}f)" stroke="#e47ba2" stroke-width="0.7"/><path d="M0 0 L0 -44" stroke="#f4a3c1" stroke-width="1" fill="none" opacity="0.8"/>${spots.map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1" ry="1.5" fill="#c2306a" opacity="0.55"/>`).join('')}</g>`).join('')}
${[15, 75, 135, 195, 255, 315].map((a) => `<g transform="rotate(${a})"><path d="M0 0 Q 2 -12 0 -22" stroke="#c9d98b" stroke-width="1.3" fill="none"/><ellipse cx="0" cy="-23" rx="2" ry="4" fill="#c8742a"/></g>`).join('')}
<circle r="4.2" fill="#a9cf86"/><circle r="2" fill="#e9f3cf"/>`;
}

/** A standalone square SVG: lily on a soft blush/lavender disc (app icon). */
export function iconSvg({ size = 512, padding = 0.08, maskable = false } = {}) {
  const r = maskable ? 0 : size * 0.22;
  const scale = (size * (1 - padding * 2)) / 124 * (maskable ? 0.78 : 0.92);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe1ec"/><stop offset="0.55" stop-color="#f7c3da"/><stop offset="1" stop-color="#d9c6f5"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
<rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
<circle cx="${size / 2}" cy="${size * 0.47}" r="${size * 0.36}" fill="url(#glow)"/>
<g transform="translate(${size / 2} ${size * 0.5}) scale(${scale.toFixed(4)})">${lilyMarkup({ id: 'ic' })}</g>
</svg>`;
}
