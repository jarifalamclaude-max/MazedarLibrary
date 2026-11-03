// Security rules for shared libraries, checked against the real rules engine
// (Firestore + Auth emulators). Run via:  bash tests/e2e/run-sync.sh
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider, createUserWithEmailAndPassword,
} from 'firebase/auth';
import {
  initializeFirestore, connectFirestoreEmulator, doc, collection, query, where, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, runTransaction, serverTimestamp, arrayUnion, arrayRemove, terminate,
} from 'firebase/firestore';

const RUN = !!process.env.FIRESTORE_EMULATOR_HOST;
const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const tag = `${process.pid}`;
const apps = [];

async function client(name) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-mazedar', authDomain: 'demo-mazedar.firebaseapp.com' }, `${name}-${tag}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const db = initializeFirestore(app, {});
  connectFirestoreEmulator(db, fsHost, Number(fsPort));
  return { app, auth, db };
}

async function googleUser(name, email) {
  const c = await client(name);
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub: `${name}-${tag}`, email, email_verified: true, name }));
  const { user } = await signInWithCredential(c.auth, cred);
  return { ...c, uid: user.uid, email };
}

const denied = async (p) => assert.rejects(p, (e) => /permission|PERMISSION_DENIED|insufficient/i.test(`${e.code} ${e.message}`));
const rec = (id, extra = {}) => ({ id, kind: 'book', title: 'বই', _v: { title: '0mh2k3x1a.0000.dev' }, _srv: serverTimestamp(), ...extra });

let owner; let member; let stranger; let pending;
const OWNER = `lily${tag}@gmail.com`;
const MEMBER = `jarif${tag}@gmail.com`;
const STRANGER = `someone${tag}@gmail.com`;
const PENDING = `pending${tag}@gmail.com`;

before(async () => {
  if (!RUN) return;
  owner = await googleUser('owner', OWNER);
  member = await googleUser('member', MEMBER);
  stranger = await googleUser('stranger', STRANGER);
  // Same address as a listed member, but a password account nobody verified.
  pending = await client('pending');
  const { user } = await createUserWithEmailAndPassword(pending.auth, PENDING, 'lily-123456');
  pending.uid = user.uid;
});
after(async () => {
  for (const c of [owner, member, stranger, pending]) if (c?.db) await terminate(c.db).catch(() => {});
  for (const a of apps) await deleteApp(a).catch(() => {});
});

const skip = !RUN && 'needs the Firebase emulators (bash tests/e2e/run-sync.sh)';

test('library card: only the owner creates and edits it, with a well-formed member list', { skip }, async () => {
  const card = doc(owner.db, 'libraries', owner.uid);
  await denied(setDoc(doc(stranger.db, 'libraries', owner.uid), { owner: owner.uid, members: [STRANGER] }));
  await denied(setDoc(card, { owner: stranger.uid, members: [] }));
  await denied(setDoc(card, { owner: owner.uid, members: [], extra: 1 }));
  await runTransaction(owner.db, async (tx) => {
    const snap = await tx.get(card);
    assert.equal(snap.exists(), false);
    tx.set(card, { owner: owner.uid, ownerEmail: OWNER, ownerName: 'Lily', members: [], createdAt: serverTimestamp() });
  });
  await updateDoc(card, { members: arrayUnion(MEMBER, PENDING) });
  await denied(updateDoc(card, { members: Array.from({ length: 11 }, (_, i) => `x${i}@gmail.com`) }));
  await denied(updateDoc(card, { owner: stranger.uid }));
  await denied(deleteDoc(card));
  assert.deepEqual((await getDoc(card)).data().members, [MEMBER, PENDING]);
});

test('owner reads and writes books; books are never deleted', { skip }, async () => {
  await setDoc(doc(owner.db, 'libraries', owner.uid, 'records', 'b_1'), rec('b_1'));
  await denied(setDoc(doc(owner.db, 'libraries', owner.uid, 'records', 'b_2'), { ...rec('b_2'), _srv: new Date() }));
  await denied(setDoc(doc(owner.db, 'libraries', owner.uid, 'other', 'x'), rec('x')));
  await denied(deleteDoc(doc(owner.db, 'libraries', owner.uid, 'records', 'b_1')));
  assert.equal((await getDoc(doc(owner.db, 'libraries', owner.uid, 'records', 'b_1'))).data().title, 'বই');
});

test('a member finds the shared library and reads/writes its books, in big transactions too', { skip }, async () => {
  const found = await getDocs(query(collection(member.db, 'libraries'), where('members', 'array-contains', MEMBER)));
  assert.deepEqual(found.docs.map((d) => d.id), [owner.uid]);
  assert.equal(found.docs[0].data().ownerEmail, OWNER);
  assert.equal((await getDoc(doc(member.db, 'libraries', owner.uid))).data().owner, owner.uid);
  const books = await getDocs(collection(member.db, 'libraries', owner.uid, 'records'));
  assert.ok(books.docs.some((d) => d.id === 'b_1'));
  await setDoc(doc(member.db, 'libraries', owner.uid, 'records', 'b_m'), rec('b_m'));
  // The sync engine pushes up to 100 documents per transaction.
  await runTransaction(member.db, async (tx) => {
    const refs = Array.from({ length: 100 }, (_, i) => doc(member.db, 'libraries', owner.uid, 'records', `b_t${i}`));
    for (const r of refs) await tx.get(r);
    for (const r of refs) tx.set(r, rec(r.id));
  });
  assert.equal((await getDocs(collection(owner.db, 'libraries', owner.uid, 'records'))).size, 102);
  // A member cannot change who the library is shared with.
  await denied(updateDoc(doc(member.db, 'libraries', owner.uid), { members: arrayUnion(STRANGER) }));
  await denied(updateDoc(doc(member.db, 'libraries', owner.uid), { members: arrayRemove(PENDING) }));
});

test('strangers and unverified look-alike accounts see nothing', { skip }, async () => {
  for (const c of [stranger, pending]) {
    await denied(getDoc(doc(c.db, 'libraries', owner.uid)));
    await denied(getDocs(collection(c.db, 'libraries', owner.uid, 'records')));
    await denied(getDoc(doc(c.db, 'libraries', owner.uid, 'records', 'b_1')));
    await denied(setDoc(doc(c.db, 'libraries', owner.uid, 'records', 'b_x'), rec('b_x')));
    await denied(getDocs(query(collection(c.db, 'libraries'), where('members', 'array-contains', MEMBER))));
    await denied(getDocs(collection(c.db, 'libraries')));
  }
  const none = await getDocs(query(collection(stranger.db, 'libraries'), where('members', 'array-contains', STRANGER)));
  assert.equal(none.size, 0);
  await denied(getDocs(query(collection(pending.db, 'libraries'), where('members', 'array-contains', PENDING))));
});

test('removing a member cuts their access at once', { skip }, async () => {
  await updateDoc(doc(owner.db, 'libraries', owner.uid), { members: arrayRemove(MEMBER) });
  await denied(getDoc(doc(member.db, 'libraries', owner.uid)));
  await denied(getDocs(collection(member.db, 'libraries', owner.uid, 'records')));
  await denied(setDoc(doc(member.db, 'libraries', owner.uid, 'records', 'b_m'), rec('b_m')));
  const found = await getDocs(query(collection(member.db, 'libraries'), where('members', 'array-contains', MEMBER)));
  assert.equal(found.size, 0);
  // Their own library is still theirs.
  await setDoc(doc(member.db, 'libraries', member.uid, 'records', 'b_own'), rec('b_own'));
});
