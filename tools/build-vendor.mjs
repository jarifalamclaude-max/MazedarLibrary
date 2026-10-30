// Builds everything under /vendor and /assets/fonts from node_modules so the
// app can be served as plain static files (GitHub Pages) and work fully offline.
// Run: npm run build   (vendor output is committed, so deploys need no build)
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = (...p) => join(root, ...p);

async function cp(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

await rm(out('vendor'), { recursive: true, force: true });
await mkdir(out('vendor'), { recursive: true });

// --- Preact + hooks + htm as one ES module --------------------------------
await build({
  stdin: {
    contents: `
      export { h, render, Fragment, createContext, createRef, toChildArray } from 'preact';
      export { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useReducer, useContext, useId } from 'preact/hooks';
      import { h } from 'preact';
      import htm from 'htm';
      export const html = htm.bind(h);
    `,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  outfile: out('vendor/preact-htm.js'),
  legalComments: 'eof',
});

// --- Firebase (app + auth + firestore), lazy-loaded only when cloud sync is set up
await build({
  stdin: {
    contents: `
      export { initializeApp, getApps, deleteApp } from 'firebase/app';
      export {
        initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
        signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
        onAuthStateChanged, sendPasswordResetEmail, connectAuthEmulator,
      } from 'firebase/auth';
      export {
        initializeFirestore, memoryLocalCache, collection, doc, query, where,
        onSnapshot, runTransaction, serverTimestamp, Timestamp, getDocs,
        connectFirestoreEmulator, terminate,
      } from 'firebase/firestore';
    `,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  platform: 'browser',
  outfile: out('vendor/firebase.js'),
  legalComments: 'eof',
});

// --- QR code generator (used to link a second device) ----------------------
await build({
  stdin: {
    contents: `import qrcode from 'qrcode-generator'; export default qrcode;`,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  outfile: out('vendor/qrcode.js'),
});

// --- Tesseract.js (offline OCR) ---------------------------------------------
const t = 'vendor/tesseract';
await cp(nm('tesseract.js/dist/tesseract.esm.min.js'), out(t, 'tesseract.esm.min.js'));
await cp(nm('tesseract.js/dist/worker.min.js'), out(t, 'worker.min.js'));
// LSTM-only cores; tesseract.js picks one at runtime from SIMD support.
for (const f of ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
  await cp(nm('tesseract.js-core', f), out(t, 'core', f));
}
await cp(nm('@tesseract.js-data/ben/4.0.0_best_int/ben.traineddata.gz'), out(t, 'lang', 'ben.traineddata.gz'));
await cp(nm('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), out(t, 'lang', 'eng.traineddata.gz'));

// --- Fonts -------------------------------------------------------------------
const BN = 'U+0951-0952,U+0964-0965,U+0980-09FE,U+1CD0,U+1CD2,U+1CD5-1CD6,U+1CD8,U+1CE1,U+1CEA,U+1CED,U+1CF2,U+1CF5-1CF7,U+200C-200D,U+20B9,U+25CC,U+A8F1';
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const faces = [];
async function font(pkg, family, file, weight, range) {
  await cp(nm('@fontsource', pkg, 'files', file), out('assets/fonts', file));
  faces.push(`@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${weight};src:url(./${file}) format('woff2');unicode-range:${range}}`);
}
await font('galada', 'Galada', 'galada-bengali-400-normal.woff2', 400, BN);
await font('galada', 'Galada', 'galada-latin-400-normal.woff2', 400, LATIN);
await font('tiro-bangla', 'Tiro Bangla', 'tiro-bangla-bengali-400-normal.woff2', 400, BN);
await font('tiro-bangla', 'Tiro Bangla', 'tiro-bangla-latin-400-normal.woff2', 400, LATIN);
for (const w of [400, 500, 600, 700]) {
  await font('hind-siliguri', 'Hind Siliguri', `hind-siliguri-bengali-${w}-normal.woff2`, w, BN);
  await font('hind-siliguri', 'Hind Siliguri', `hind-siliguri-latin-${w}-normal.woff2`, w, LATIN);
}
await writeFile(out('assets/fonts/fonts.css'), faces.join('\n') + '\n');

console.log('vendor + fonts built');
