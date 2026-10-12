// End-to-end test in an iPhone-sized Chromium.
// Run from the workout-app folder:  python3 -m http.server 8123 &  node tests/e2e.mjs
import { chromium, devices } from 'playwright';
import assert from 'assert';

const URL = process.env.APP_URL || 'http://localhost:8123/';
const SHOTS = process.env.SHOTS || null;
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined });
const page = await ctx.newPage();
await page.clock.install({ time: new Date('2026-10-09T17:00:00') });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());

let shot = 0;
async function snap(name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
}
const btn = name => page.getByRole('button', { name, exact: false });
const screen = () => page.evaluate(() => window.__app.ui.screen);
const waitScreen = name => page.waitForFunction(n => window.__app && window.__app.ui.screen === n, name, { timeout: 5000 });
const data = () => page.evaluate(() => window.__app.Store.exportData());
const step = (field, dir) => page.locator(`[data-step="${field}"][data-dir="${dir}"]`).first().click();
const val = field => page.locator(`input[data-field="${field}"]`).inputValue();
async function ok(name, fn) { await fn(); console.log('ok -', name); }

await page.goto(URL);
await page.waitForSelector('h1');

await ok('create a workout type with only a name', async () => {
  await snap('home-empty');
  await btn('New workout type').click();
  await page.fill('input[name=name]', 'Triceps & biceps');
  await snap('new-type');
  await btn('Create workout').click();
  await waitScreen('type');
  await page.getByText('Setup saved · No sets logged').waitFor();
});

await ok('add exercises without duplicates', async () => {
  await btn('Add exercise').click();
  await btn('Create new exercise').click();
  await page.fill('input[name=name]', 'Cable tricep pushdown');
  await snap('new-exercise');
  await btn('Add to workout').click();
  await btn('Add exercise').click();
  await btn('Create new exercise').click();
  await page.fill('input[name=name]', 'Barbell curl');
  await btn('Add to workout').click();
  // try to create a near-duplicate
  await btn('Add exercise').click();
  await page.fill('[data-search]', 'push');
  await snap('add-exercise-search');
  await btn('Create new exercise').click();
  await page.fill('input[name=name]', 'cable tricep pushdowns');
  await btn('Add to workout').click();
  await page.getByText('You already have').waitFor();
  await btn('Add Cable tricep pushdown').click();
  const d = await data();
  assert.equal(d.exercises.length, 2);
  assert.equal(d.types[0].exerciseIds.length, 2);
  await snap('setup');
});

await ok('setup alone creates no history; empty started workout is discarded', async () => {
  await btn('Home').click();
  assert.equal((await data()).sessions.length, 0);
  await page.locator('.bigbtn', { hasText: 'Triceps & biceps' }).click();
  await btn('Start workout').click();
  assert.equal((await data()).sessions.length, 1);
  await btn('Home').click();
  assert.equal((await data()).sessions.length, 0);
  assert.equal(await btn('Resume workout').count(), 0);
});

let firstRestEnds;
await ok('new exercise: no invented values, user enters starting numbers', async () => {
  await page.locator('.bigbtn', { hasText: 'Triceps & biceps' }).click();
  await btn('Start workout').click();
  await page.getByText('Choose any exercise.').waitFor();
  await snap('session-start');
  await page.locator('.card', { hasText: 'Cable tricep pushdown' }).click();
  assert.equal(await val('weight'), '');
  assert.equal(await val('reps'), '');
  assert.ok(await btn('Set complete').isDisabled());
  for (let i = 0; i < 8; i++) await step('weight', 1);
  await page.fill('input[data-field=reps]', '12');
  await page.locator('input[data-field=reps]').blur();
  assert.equal(await val('weight'), '40');
  await snap('set-1-entered');
});

await ok('set complete starts rest once even with repeated taps', async () => {
  // three taps delivered before the app can react
  await page.evaluate(() => { const b = document.querySelector('[data-act=complete]'); b.click(); b.click(); b.click(); });
  await page.waitForSelector('[data-timerbox]');
  const d = await data();
  assert.equal(d.sessions[0].sets.length, 1);
  assert.equal(d.sessions[0].sets[0].status, 'confirmed'); // entered before completing = intentional
  firstRestEnds = (await page.evaluate(() => window.__app.Store.getMeta('rest'))).endsAt;
  assert.match(await page.locator('[data-timer]').innerText(), /^1:(30|29|28)$/);
  await page.getByText('Saved ✓').waitFor();
  await snap('rest-set1');
});

let restEnds;
await ok('next set prefills a suggestion; pending until confirmed; edits do not restart timer', async () => {
  await page.clock.runFor(20000);
  await btn('Next set').click();
  await waitScreen('set');
  assert.equal(await val('weight'), '40');
  assert.equal(await val('reps'), '12');
  await page.getByText('Suggested from your previous set').waitFor();
  await snap('set-2-suggested-with-restbar');
  await btn('Set complete').click();
  let s = (await data()).sessions[0].sets[1];
  assert.equal(s.status, 'pending');
  await page.getByText('Suggested values').waitFor();
  await snap('rest-pending');
  restEnds = (await page.evaluate(() => window.__app.Store.getMeta('rest'))).endsAt;
  await page.clock.runFor(5000);
  await step('reps', -1);
  await btn('Extra reps').click();
  await step('extra', 1); await step('extra', 1);
  s = (await data()).sessions[0].sets[1];
  assert.equal(s.status, 'confirmed');
  assert.equal(s.reps, 11);
  assert.equal(s.extra, 2);
  assert.equal((await page.evaluate(() => window.__app.Store.getMeta('rest'))).endsAt, restEnds);
  await page.getByText('Saved ✓').waitFor();
  await snap('rest-extra');
});

await ok('pending set and timer survive closing and reopening', async () => {
  await btn('Next set').click();
  await btn('Set complete').click();
  await page.getByText('Suggested values').waitFor();
  const ends = (await page.evaluate(() => window.__app.Store.getMeta('rest'))).endsAt;
  await page.clock.runFor(30000);
  await page.reload();
  await page.waitForSelector('[data-timerbox]');
  await waitScreen('rest');
  assert.equal((await data()).sessions[0].sets[2].status, 'pending');
  assert.equal((await page.evaluate(() => window.__app.Store.getMeta('rest'))).endsAt, ends);
  const t = await page.locator('[data-timer]').innerText();
  assert.match(t, /^1:0\d$|^0:59$/, 'timer kept counting from the real end time, got ' + t);
});

await ok('timer reaches Ready and does not auto-advance', async () => {
  await page.clock.runFor(70000);
  await page.getByText('Ready', { exact: true }).waitFor();
  await waitScreen('rest');
  await snap('rest-ready');
});

await ok('moving on without confirming keeps the set as unconfirmed', async () => {
  await btn('Exercise complete').click();
  await waitScreen('type');
  assert.equal((await data()).sessions[0].sets[2].status, 'unconfirmed');
  await page.locator('.card.done', { hasText: 'Cable tricep pushdown' }).waitFor();
  await snap('session-with-check');
});

await ok('resume after leaving mid-workout', async () => {
  await btn('Home').click();
  await btn('Resume workout').waitFor();
  await snap('home-resume');
  await btn('Resume workout').click();
  await page.getByText('Finish workout').waitFor();
});

await ok('finish shows compact summary with unconfirmed set marked', async () => {
  await btn('Finish workout').click();
  await waitScreen('summary');
  await page.getByText('Workout complete').waitFor();
  assert.equal(await page.locator('table.tbl tbody tr').count(), 3);
  assert.equal(await page.locator('tr.unconf').count(), 1);
  await page.getByText('No progress comparison yet').waitFor();
  await snap('summary-first');
  await btn('Done').click();
});

await ok('next workout: history prefill, Looks right, progression callout', async () => {
  await page.clock.setSystemTime(new Date('2026-10-11T17:00:00'));
  await page.locator('.bigbtn', { hasText: 'Triceps & biceps' }).click();
  await btn('Start workout').click();
  await page.locator('.card', { hasText: 'Cable tricep pushdown' }).click();
  await page.getByText('Last time · Set 1 · Oct 9').waitFor();
  assert.equal(await val('weight'), '40');
  assert.equal(await val('reps'), '12');
  await step('reps', 1); // 13, intentional
  await btn('Set complete').click();
  await btn('Next set').click();
  await page.getByText('Last time · Set 2 · Oct 9').waitFor();
  assert.equal(await val('reps'), '11');
  await btn('Set complete').click();
  await btn('Looks right').click();
  await btn('Next set').click();
  // set 3 last time was unconfirmed, so it is not a "last time" source
  await page.getByText('This workout · Set 2').waitFor();
  await snap('set-3-no-history');
  await step('reps', 1);
  await btn('Set complete').click();
  await btn('Exercise complete').click();
  await btn('Finish workout').click();
  await page.locator('.callout-big').waitFor();
  assert.equal(await page.locator('.callout-big').innerText(), '+1 main rep');
  assert.match(await page.locator('.callout-sub').innerText(), /Cable tricep pushdown · same weight as Oct 9/);
  await snap('summary-progress');
  await btn('Done').click();
});

await ok('history survives reload; newest first', async () => {
  await page.evaluate(() => window.__app.Store.flush());
  await page.reload();
  await page.waitForSelector('.row');
  const dates = await page.locator('.row-date').allInnerTexts();
  assert.deepEqual(dates, ['Oct 11', 'Oct 9']);
  await snap('home-history');
  await page.locator('.row').first().click();
  await page.getByText('Delete this workout').waitFor();
  await btn('Home').click();
});

await ok('backup export round-trips through import validation', async () => {
  const d = await data();
  const r = await page.evaluate(async (d) => { d.sessions[0].typeName += ''; return await window.__app.Store.importData(d); }, d);
  assert.equal(r.added, 0);
  await btn('Back up').click();
  await snap('backup');
});

await ok('works offline after first load', async () => {
  const c2 = await browser.newContext(devices['iPhone 13']);
  const p2 = await c2.newPage();
  await p2.goto(URL);
  await p2.evaluate(() => navigator.serviceWorker.ready);
  await p2.reload();
  await c2.setOffline(true);
  await p2.reload();
  await p2.getByText('Your workouts').waitFor();
  await c2.close();
});

assert.deepEqual(errors, []);
console.log('all e2e checks passed');
await browser.close();
