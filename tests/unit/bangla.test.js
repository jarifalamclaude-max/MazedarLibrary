import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../../src/lib/bangla.js';
import { HUMAYUN_CATALOG } from '../../src/data/humayun.js';

const sorted = (list) => [...list].sort((a, b) => (B.sortKey(a) < B.sortKey(b) ? -1 : B.sortKey(a) > B.sortKey(b) ? 1 : 0));

test('cleanTitle keeps the র‍্য ZWJ but drops stray joiners and spaces', () => {
  assert.equal(B.cleanTitle('  হলুদ হিমু   কালো র‍্যাব  '), 'হলুদ হিমু কালো র‍্যাব');
  assert.equal(B.cleanTitle('আনন্দ বেদনার কাব‍্য'), 'আনন্দ বেদনার কাব্য');
  assert.equal(B.cleanTitle('মিসির আলি! আপনি কোথায়?'), 'মিসির আলি! আপনি কোথায়?');
});

test('searchKey folds spellings readers treat as the same title', () => {
  for (const [a, b] of [
    ['রংপেন্সিল', 'রংপেনসিল'], ['বৃষ্টি বিলাস', 'বৃষ্টিবিলাস'], ['ময়ুরাক্ষী', 'ময়ূরাক্ষী'],
    ['মিসির আলীর চশমা', 'মিসির আলির চশমা'], ['একজন হিমু কয়েকটি ঝিঁ ঝিঁ পোকা', 'একজন হিমু কয়েকটি ঝিঁঝিঁ পোকা'],
    ['ড়', 'ড়'], ['১৯৭১', '1971'],
  ]) assert.equal(B.searchKey(a), B.searchKey(b), `${a} vs ${b}`);
});

test('Bengali dictionary order: vowels, consonants, kar order, conjuncts, ড়/য়/ৎ, digits first, Latin last', () => {
  const want = ['১৯৭১', 'অপেক্ষা', 'আকাশ', 'ইরিনা', 'কলম', 'কাল', 'কৌশল', 'ক্লাস', 'ডাক', 'ড়াল', 'ঢোল', 'তৎসম', 'তলা', 'থালা',
    'মেঘ বলেছে যাবো যাবো', 'মেঘের ছায়া', 'যম', 'য়াম', 'Aami'];
  assert.deepEqual(sorted([...want].reverse()), want);
  assert.ok(B.compareBn('কলম', 'কাল') < 0 && B.compareBn('কাল', 'কলম') > 0 && B.compareBn('কলম', 'কলম') === 0);
  // precomposed and decomposed nukta letters sort identically
  assert.equal(B.sortKey('ড়া'), B.sortKey('ড়া'));
});

test('digits convert both ways', () => {
  assert.equal(B.toBnDigits(2026), '২০২৬');
  assert.equal(B.toAsciiDigits('২০২৬'), '2026');
});

test('same book, different spelling: similarity ≥ 0.85 (Bengali and Banglish)', () => {
  for (const [a, b] of [
    ['মিসির আলি unsolved', 'মিসির আলি আনসলভ'], ['হিমুর মধ্য দুপুর', 'হিমুর মধ্যদুপুর'],
    ['নিউইয়র্কের নীল আকাশে ঝকঝকে রোদ', 'নিউইয়র্কের নীলাকাশে ঝকঝকে রোদ'],
    ['হিমুর একান্ত সাক্ষাৎকার এবং অন্যান্য', 'হিমুর একান্ত সাক্ষাৎকার ও অন্যান্য'],
    ['হিমুর দিত্বিয় প্রহর', 'হিমুর দ্বিতীয় প্রহর'], ['মেঘ বলেছে যাব যাব', 'মেঘ বলেছে যাবো যাবো'],
    ['আমাদের শাদা বাড়ি', 'Amader Shada Bari'], ['বৃষ্টি ও মেঘমালা', 'Brishti O Meghmala'], ['কালো জাদুকর', 'Kalo Jadukar'],
    ['নীল মানুষ', 'Neel Manush'], ['কুহুরানী', 'Kuhurani'],
  ]) assert.ok(B.similarity(a, b) >= 0.85, `${a} | ${b}: ${B.similarity(a, b)}`);
});

test('different books that share words stay below 0.75', () => {
  for (const [a, b] of [
    ['শুভ্র গেছে বনে', 'সবাই গেছে বনে'], ['হিমু', 'হিমু মামা'], ['হিমু', 'এবং হিমু'], ['মৃন্ময়ী', 'মৃন্ময়ীর মন ভালো নেই'],
    ['রূপা', 'রূপার পালঙ্ক'], ['রূপালী দ্বীপ', 'দারুচিনি দ্বীপ'], ['জল জোছনা', 'জলপদ্ম'], ['মেঘের ছায়া', 'মেঘের ওপর বাড়ি'],
    ['তারা তিন জন', 'তিনি ও সে'], ['প্রথম প্রহর', 'হিমুর দ্বিতীয় প্রহর'], ['এলেবেলে - প্রথম পর্ব', 'এলেবেলে - দ্বিতীয় পর্ব'],
    ['উপন্যাস সমগ্র - প্রথম খন্ড', 'উপন্যাস সমগ্র - দ্বিতীয় খন্ড'], ['কিছুক্ষণ', 'Kichhu Shaushob'], ['তিনি ও সে', 'Tin Purush'],
  ]) assert.ok(B.similarity(a, b) < 0.75, `${a} | ${b}: ${B.similarity(a, b)}`);
});

test('no two distinct ideal-list titles look like the same book', () => {
  const T = HUMAYUN_CATALOG.map((c) => c.title);
  let worst = [0];
  for (let i = 0; i < T.length; i += 1) {
    for (let j = i + 1; j < T.length; j += 1) {
      const s = B.similarity(T[i], T[j]);
      if (s > worst[0]) worst = [s, T[i], T[j]];
    }
  }
  assert.ok(worst[0] < 0.8, `${worst[1]} | ${worst[2]}: ${worst[0]}`);
});

test('search finds Bengali and Banglish queries, and nothing for unrelated ones', () => {
  for (const [q, t] of [
    ['himu', 'হিমু মামা'], ['misir ali', 'মিসির আলির চশমা'], ['jochona', 'জোছনা ও জননীর গল্প'], ['josna', 'তেঁতুল বনে জোছনা'],
    ['jyotsna', 'জল জোছনা'], ['badshah namdar', 'বাদশাহ নামদার'], ['nondito noroke', 'নন্দিত নরকে'], ['kothao keu nei', 'কোথাও কেউ নেই'],
    ['deyal', 'দেয়াল'], ['moyurakkhi', 'ময়ূরাক্ষী'], ['mayurakshi', 'ময়ূরাক্ষী'], ['brishti bilash', 'বৃষ্টিবিলাস'],
    ['megher opor bari', 'মেঘের ওপর বাড়ি'], ['aaj himur biye', 'আজ হিমুর বিয়ে'], ['irina', 'ইরিনা'], ['humayun ahmed', 'হুমায়ূন আহমেদ'],
    ['shonkhonil karagar', 'শঙ্খনীল কারাগার'], ['হিমু', 'হিমুর মধ্য দুপুর'], ['মধ্যদুপুর', 'হিমুর মধ্য দুপুর'], ['himur moddho dupur', 'হিমুর মধ্যদুপুর'],
    ['shunno', 'শূন্য'], ['omega point', 'ওমেগা পয়েন্ট'], ['darchini dip', 'দারুচিনি দ্বীপ'], ['nil oporajita', 'নীল অপরাজিতা'], ['debi', 'দেবী'],
  ]) assert.ok(B.searchScore(q, t) >= B.SEARCH_THRESHOLD, `${q} → ${t}: ${B.searchScore(q, t)}`);
  for (const [q, t] of [['himu', 'মিসির আলির চশমা'], ['misir', 'হিমু মামা'], ['deyal', 'দেবী'], ['xyz', 'হিমু'], ['', 'হিমু']]) {
    assert.equal(B.searchScore(q, t), 0, `${q} → ${t}`);
  }
});
