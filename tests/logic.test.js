// Run: node tests/logic.test.js
const assert = require('assert');
const L = require('../logic.js');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

const DAY = 864e5;
function sess(id, day, sets) {
  return { id, typeId: 't', typeName: 'T', startedAt: day * DAY, finishedAt: day * DAY + 3600e3,
    sets: sets.map((s, i) => Object.assign({ id: id + i, createdAt: day * DAY + i, extra: null, status: 'confirmed' }, s)) };
}
const set = (ex, setNumber, weight, reps, extra) => ({ exerciseId: ex, setNumber, weight, reps, extra: extra || null });

test('duplicate exercise names are detected loosely', () => {
  const list = [{ id: '1', name: 'Barbell Curl' }];
  assert.equal(L.findByName(list, '  barbell   curls ').id, '1');
  assert.equal(L.findByName(list, 'Barbell curl!').id, '1');
  assert.equal(L.findByName(list, 'Hammer curl'), null);
});

test('weight stepping allows fractions and bodyweight', () => {
  assert.equal(L.stepWeight(null, 5, 1), 5);
  assert.equal(L.stepWeight(null, 5, -1), 0);
  assert.equal(L.stepWeight(2.5, 5, -1), 0);
  assert.equal(L.stepWeight(41, 2.5, 1), 43.5);
  assert.equal(L.parseNum('42,5', true), 42.5);
  assert.equal(L.parseNum('-3', true), undefined);
  assert.equal(L.stepReps(0, -1), 0);
});

test('suggestion comes from the latest confirmed corresponding set', () => {
  const s1 = sess('a', 1, [set('pd', 1, 40, 12), set('pd', 2, 40, 11)]);
  const s2 = sess('b', 3, [set('pd', 1, 45, 8)]);
  s2.sets[0].status = 'unconfirmed';
  const now = sess('c', 5, []);
  const all = [s1, s2, now];
  const g = L.suggestion(all, now, 'pd', 1);
  assert.equal(g.source, 'history');
  assert.equal(g.weight, 40); // the unconfirmed 45 lb set is skipped
  assert.equal(g.reps, 12);
  assert.equal(g.from.session.id, 'a');
});

test('new exercises get no invented values', () => {
  const now = sess('c', 5, []);
  const g = L.suggestion([now], now, 'new', 1);
  assert.equal(g.source, 'none');
  assert.equal(g.weight, null);
  assert.equal(g.reps, null);
});

test('a set beyond history repeats this workout\'s previous set', () => {
  const s1 = sess('a', 1, [set('pd', 1, 40, 12)]);
  const now = sess('c', 5, [set('pd', 1, 45, 10)]);
  const g = L.suggestion([s1, now], now, 'pd', 2);
  assert.equal(g.source, 'session');
  assert.equal(g.weight, 45);
});

test('"usually N sets" needs two agreeing earlier workouts', () => {
  const four = d => sess('s' + d, d, [1, 2, 3, 4].map(i => set('pd', i, 40, 10)));
  const three = d => sess('s' + d, d, [1, 2, 3].map(i => set('pd', i, 40, 10)));
  const now = sess('now', 10, []);
  assert.equal(L.usualSetCount([four(1), now], now, 'pd'), null);
  assert.equal(L.usualSetCount([four(1), three(2), now], now, 'pd'), null);
  assert.equal(L.usualSetCount([four(1), three(2), four(3), now], now, 'pd'), 4);
});

test('progression: same weight, more reps', () => {
  const prev = sess('a', 9, [set('pd', 1, 40, 11), set('pd', 2, 40, 10), set('pd', 3, 40, 9)]);
  const cur = sess('b', 11, [set('pd', 1, 40, 12, 3), set('pd', 2, 40, 11, 2), set('pd', 3, 40, 10)]);
  const c = L.compareExercise([prev, cur], cur, 'pd');
  assert.equal(c.pairs, 3);
  assert.equal(c.repDiff, 3); // extra reps (+5) are not counted
  const co = L.callout([prev, cur], cur, () => 'Pushdown');
  assert.equal(co.kind, 'reps');
  assert.equal(co.big, '+3 main reps');
  assert.equal(co.weightText, 'same weight');
  assert.equal(co.date, prev.startedAt);
});

test('progression: an additional set alone is not "more reps"', () => {
  const prev = sess('a', 9, [set('pd', 1, 40, 12), set('pd', 2, 40, 11)]);
  const cur = sess('b', 11, [set('pd', 1, 40, 12), set('pd', 2, 40, 11), set('pd', 3, 40, 10)]);
  const c = L.compareExercise([prev, cur], cur, 'pd');
  assert.equal(c.repDiff, 0);
  assert.equal(L.callout([prev, cur], cur, () => 'x'), null);
});

test('progression: weight change is reported without a rep claim', () => {
  const prev = sess('a', 9, [set('pd', 1, 40, 12), set('pd', 2, 40, 11)]);
  const cur = sess('b', 11, [set('pd', 1, 45, 9), set('pd', 2, 45, 8)]);
  const c = L.compareExercise([prev, cur], cur, 'pd');
  assert.equal(c.pairs, 0);
  assert.equal(c.weightUp, true);
  const co = L.callout([prev, cur], cur, () => 'Pushdown');
  assert.equal(co.kind, 'weight');
  assert.equal(co.big, 'Up to 45 lb');
});

test('progression: mixed weights only compare the matching sets', () => {
  const prev = sess('a', 9, [set('pd', 1, 40, 10), set('pd', 2, 40, 10)]);
  const cur = sess('b', 11, [set('pd', 1, 40, 12), set('pd', 2, 45, 6)]);
  const c = L.compareExercise([prev, cur], cur, 'pd');
  assert.equal(c.pairs, 1);
  assert.equal(c.repDiff, 2);
});

test('progression: unconfirmed sets are excluded on both sides', () => {
  const prev = sess('a', 9, [set('pd', 1, 40, 10)]);
  const cur = sess('b', 11, [set('pd', 1, 40, 15)]);
  cur.sets[0].status = 'unconfirmed';
  const c = L.compareExercise([prev, cur], cur, 'pd');
  assert.equal(c.kind, 'no-confirmed');
  assert.equal(c.unconfirmed, 1);
  assert.equal(L.callout([prev, cur], cur, () => 'x'), null);
});

test('progression follows an exercise across workout types and bodyweight', () => {
  const prev = sess('a', 9, [set('pu', 1, 0, 8)]);
  prev.typeId = 'back';
  const cur = sess('b', 11, [set('pu', 1, 0, 10)]);
  const co = L.callout([prev, cur], cur, () => 'Pull-up');
  assert.equal(co.big, '+2 main reps');
  assert.equal(co.weightText, 'at bodyweight');
});

test('first time logged gives neutral result', () => {
  const cur = sess('b', 11, [set('pd', 1, 40, 12)]);
  assert.equal(L.compareExercise([cur], cur, 'pd').kind, 'first');
  assert.equal(L.callout([cur], cur, () => 'x'), null);
});

console.log(n + ' logic tests passed');
