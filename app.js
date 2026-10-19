// Screens, navigation and workout flow.
(function () {
  'use strict';
  const L = window.Logic;
  const S = window.Store;
  const app = document.getElementById('app');
  const APP_VERSION = '3'; // matches VERSION in sw.js

  let ui = { screen: 'home', params: {} };
  let busy = false;          // guards against double taps on actions that create records
  let audioCtx = null;
  let wakeLock = null;
  let flash = '';            // one-off message shown on the next render

  // ---------- small helpers ----------

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function shortDate(ts) {
    const d = new Date(ts);
    const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
    return MON[d.getMonth()] + ' ' + d.getDate() + y;
  }
  function longDate(ts) {
    const d = new Date(ts);
    return DAY[d.getDay()] + ', ' + shortDate(ts);
  }
  function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  const exercise = id => S.get('exercises', id);
  const exName = id => (exercise(id) || { name: 'Exercise' }).name;
  const exStep = id => (exercise(id) || {}).step || L.DEFAULT_STEP;
  const sessions = () => S.all('sessions');
  const types = () => S.all('types').sort((a, b) => a.createdAt - b.createdAt);
  function activeSession() {
    return sessions().filter(s => !s.finishedAt).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  }
  function getRest() { return S.getMeta('rest', null); }
  function settings() { return Object.assign({ sound: true, guard: true, lastExportAt: 0 }, S.getMeta('settings', {})); }

  // ---------- navigation ----------

  function go(screen, params) {
    leaveCurrent(screen, params || {});
    if (screen === 'set' && ui.screen !== 'set') guardPending = true;
    ui = { screen, params: params || {} };
    S.setMeta('ui', ui);
    render();
    window.scrollTo(0, 0);
  }

  // Housekeeping when leaving a screen.
  function leaveCurrent(nextScreen, nextParams) {
    // Moving on from the rest screen without confirming keeps the set, marked unconfirmed.
    if (ui.screen === 'rest') {
      const sess = S.get('sessions', ui.params.sessionId);
      const set = sess && sess.sets.find(x => x.id === ui.params.setId);
      if (set && set.status === 'pending' && !(nextScreen === 'rest' && nextParams.setId === set.id)) {
        set.status = 'unconfirmed';
        S.put('sessions', sess);
      }
    }
    // Leaving a started workout before recording any set leaves no history entry.
    if (nextScreen === 'home') {
      const a = activeSession();
      if (a && !a.sets.length) S.del('sessions', a.id);
    }
  }

  // ---------- rendering ----------

  function render() {
    const fn = screens[ui.screen] || screens.home;
    let html;
    try { html = fn(ui.params); } catch (e) { console.error(e); ui = { screen: 'home', params: {} }; html = screens.home({}); }
    const warn = S.volatile ? '<div class="warn">This browser is not letting the app save data. Workouts will be lost when it closes.</div>' :
      S.trouble ? TROUBLE : '';
    const msg = flash ? '<div class="flash" role="status">' + esc(flash) + '</div>' : '';
    flash = '';
    app.innerHTML = warn + msg + html;
    app.dataset.screen = ui.screen;
    fitNums();
    tick();
    manageWakeLock();
    guardAfterRender();
    if (ui.screen === 'data') showPersist();
  }

  const TROUBLE = '<div class="warn" data-trouble>The phone’s database didn’t accept the last change. A backup copy on the phone has it. Close the app fully and reopen it.</div>';

  // Show or clear the save warning without redrawing the screen (which would wipe typing).
  function showTrouble(on) {
    const el = app.querySelector('[data-trouble]');
    if (on && !el) app.insertAdjacentHTML('afterbegin', TROUBLE);
    if (!on && el) el.remove();
  }

  function back(label, screen, params) {
    return '<button class="back" data-go="' + screen + '" data-params=\'' + esc(JSON.stringify(params || {})) + '\'>' +
      '<span aria-hidden="true">‹</span> ' + esc(label) + '</button>';
  }

  function restBar() {
    const r = getRest();
    if (!r || r.endsAt - Date.now() < -60000) return '';
    return '<button class="restbar" data-act="toRest"><span>Rest</span> <b data-timer></b></button>';
  }

  function stepper(field, value, unit, opts) {
    const o = opts || {};
    const display = value == null ? '' : (field === 'weight' ? String(L.roundW(value)) : String(value));
    return '<div class="stepper ' + (o.compact ? 'compact' : '') + '">' +
      (o.label ? '<div class="stepper-label">' + o.label + '</div>' : '') +
      '<button class="round" data-step="' + field + '" data-dir="-1" aria-label="Decrease ' + field + '">−</button>' +
      '<label class="value"><input class="num" data-field="' + field + '" inputmode="' + (field === 'weight' ? 'decimal' : 'numeric') + '"' +
      ' value="' + esc(display) + '" placeholder="—" aria-label="' + field + '" autocomplete="off">' +
      (unit ? '<span class="unit">' + unit + '</span>' : '') + '</label>' +
      '<button class="round" data-step="' + field + '" data-dir="1" aria-label="Increase ' + field + '">+</button></div>';
  }

  const screens = {};

  // 1. Home
  screens.home = function () {
    const a = activeSession();
    let html = '<div class="ver">v' + APP_VERSION + '</div><h1>Your workouts</h1>';
    if (a && a.sets.length) {
      html += '<button class="resume" data-act="resume"><span class="resume-k">Resume workout</span>' +
        '<span class="resume-v">' + esc(a.typeName) + ' · ' + a.sets.length + ' set' + (a.sets.length === 1 ? '' : 's') + '</span></button>';
    }
    const ts = types();
    html += '<div class="label">Workout types</div>';
    if (!ts.length) html += '<p class="muted">Create a workout type, such as “Triceps & biceps”, then add the exercises you usually do.</p>';
    html += ts.map(t => '<button class="bigbtn" data-go="type" data-params=\'' + esc(JSON.stringify({ typeId: t.id })) + '\'><span>' + esc(t.name) + '</span><span class="chev">›</span></button>').join('');
    html += '<button class="outline" data-go="newType">+ New workout type</button>';

    const done = sessions().filter(s => s.finishedAt && s.sets.length).sort((x, y) => y.startedAt - x.startedAt);
    html += '<h2>Recent workouts</h2>';
    if (!done.length) html += '<p class="muted">Finished workouts will appear here.</p>';
    html += '<div class="list">' + done.map(s => {
      const nEx = new Set(s.sets.map(x => x.exerciseId)).size;
      return '<button class="row" data-go="summary" data-params=\'' + esc(JSON.stringify({ sessionId: s.id })) + '\'>' +
        '<span class="row-date">' + shortDate(s.startedAt) + '</span>' +
        '<span class="row-main"><b>' + esc(s.typeName) + '</b><small>' + nEx + ' exercise' + (nEx === 1 ? '' : 's') + ' · ' + s.sets.length + ' sets</small></span>' +
        '<span class="chev">›</span></button>';
    }).join('') + '</div>';
    const st = settings();
    const needBackup = done.length && Date.now() - (st.lastExportAt || 0) > 7 * 864e5;
    html += '<button class="linkbtn foot" data-go="data">' + (needBackup ? 'Back up your workout history' : 'Backup & settings') + '</button>';
    return html;
  };

  // 2. New workout type
  screens.newType = function () {
    return back('Home', 'home') +
      '<h1>New workout</h1><form data-form="newType">' +
      '<label class="field-label" for="nm">Workout name</label>' +
      '<input id="nm" class="text" name="name" maxlength="60" autocomplete="off" placeholder="e.g. Triceps & biceps">' +
      '<p class="hint">Choose a name that works for you.</p>' +
      '<div class="bottom"><button class="primary" type="submit">Create workout</button></div></form>';
  };

  // 3. Workout setup / active session
  screens.type = function (p) {
    const t = S.get('types', p.typeId);
    if (!t) return screens.home({});
    const a = activeSession();
    const active = a && a.typeId === t.id ? a : null;
    let html = back('Home', 'home');
    if (active) html += '<div class="kicker">' + esc(longDate(active.startedAt)) + '</div>';
    html += '<h1>' + esc(t.name) + '</h1>';
    html += '<p class="sub">' + (active ? 'Choose any exercise.' : 'Add your exercises. Start whenever you’re ready.') + '</p>';
    if (active) html += restBar();

    const ids = t.exerciseIds.slice();
    if (active) active.sets.forEach(s => { if (!ids.includes(s.exerciseId)) ids.push(s.exerciseId); });
    if (!ids.length) html += '<p class="muted">No exercises yet.</p>';
    html += ids.map(id => {
      let detail = '', check = false;
      if (active) {
        const sets = L.setsFor(active, id);
        check = (active.completed || []).includes(id);
        if (sets.length) {
          const last = sets[sets.length - 1];
          detail = sets.length + ' set' + (sets.length === 1 ? '' : 's') + ' logged · ' + L.fmtWeightLb(last.weight);
        } else {
          const u = L.usualSetCount(sessions(), active, id);
          detail = u ? 'Usually ' + u + ' sets' : '';
        }
      }
      const act = active ? 'data-act="openExercise" data-id="' + id + '"' :
        'data-go="exercise" data-params=\'' + esc(JSON.stringify({ exerciseId: id, typeId: t.id })) + '\'';
      return '<button class="card ' + (check ? 'done' : '') + '" ' + act + '>' +
        (active ? '<span class="check" aria-label="' + (check ? 'Completed' : '') + '">' + (check ? '✓' : '') + '</span>' : '') +
        '<span class="card-main"><b>' + esc(exName(id)) + '</b>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>' +
        '<span class="chev">›</span></button>';
    }).join('');
    html += '<button class="outline" data-go="addExercise" data-params=\'' + esc(JSON.stringify({ typeId: t.id })) + '\'>+ Add exercise</button>';
    if (active) {
      html += '<button class="primary" data-act="finish">Finish workout</button>';
    } else {
      html += '<button class="primary" data-act="start" data-id="' + t.id + '">Start workout</button>';
      html += '<p class="hint center">Setup saved · No sets logged</p>';
      html += '<button class="linkbtn danger" data-act="deleteType" data-id="' + t.id + '">Delete this workout type</button>';
    }
    return html;
  };

  // 4. Add exercise
  screens.addExercise = function (p) {
    const t = S.get('types', p.typeId);
    if (!t) return screens.home({});
    const q = p.q || '';
    const list = S.all('exercises').sort((a, b) => a.name.localeCompare(b.name));
    return back('Workout', 'type', { typeId: t.id }) +
      '<h1>Add exercise</h1>' +
      '<input class="search" data-search placeholder="Search exercises" value="' + esc(q) + '" autocomplete="off" aria-label="Search exercises">' +
      '<button class="outline" data-act="newExercise">+ Create new exercise</button>' +
      (list.length ? '<div class="label">Your exercises</div>' : '<p class="muted">You haven’t created any exercises yet.</p>') +
      '<div data-exlist>' + exerciseList(list, t, q) + '</div>' +
      (list.length ? '<p class="hint center">Tap an exercise to add it.</p>' : '');
  };

  function exerciseList(list, t, q) {
    const k = L.nameKey(q);
    const shown = list.filter(e => !k || L.nameKey(e.name).includes(k) || e.name.toLowerCase().includes(q.toLowerCase().trim()));
    if (!shown.length && q) return '<p class="muted">No match for “' + esc(q) + '”.</p>';
    return shown.map(e => {
      const inType = t.exerciseIds.includes(e.id);
      return '<button class="card add ' + (inType ? 'added' : '') + '" data-act="pickExercise" data-id="' + e.id + '"' + (inType ? ' disabled' : '') + '>' +
        '<span class="card-main"><b>' + esc(e.name) + '</b></span>' +
        '<span class="plus">' + (inType ? '✓' : '+') + '</span></button>';
    }).join('');
  }

  // 4b. New exercise (name only)
  screens.newExercise = function (p) {
    return back('Exercises', 'addExercise', { typeId: p.typeId }) +
      '<h1>New exercise</h1><form data-form="newExercise">' +
      '<label class="field-label" for="nm">Exercise name</label>' +
      '<input id="nm" class="text" name="name" maxlength="60" autocomplete="off" value="' + esc(p.name || '') + '">' +
      '<p class="hint">You can use this exercise in any workout.</p>' +
      (p.dupId ? '<div class="notice">You already have <b>' + esc(exName(p.dupId)) + '</b>.' +
        '<button class="primary" type="button" data-act="useExisting" data-id="' + p.dupId + '">Add ' + esc(exName(p.dupId)) + '</button>' +
        '<button class="linkbtn" type="button" data-act="createAnyway">Create a separate exercise anyway</button></div>' : '') +
      '<div class="bottom"><button class="primary" type="submit">Add to workout</button></div></form>';
  };

  // Exercise details (from setup): rename, weight step, remove, recent history.
  screens.exercise = function (p) {
    const e = exercise(p.exerciseId);
    if (!e) return screens.home({});
    const t = S.get('types', p.typeId);
    const hist = sessions().filter(s => s.sets.some(x => x.exerciseId === e.id))
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, 6);
    return back(t ? t.name : 'Home', t ? 'type' : 'home', t ? { typeId: t.id } : {}) +
      '<h1>' + esc(e.name) + '</h1>' +
      '<form data-form="rename"><label class="field-label" for="nm">Name</label>' +
      '<input id="nm" class="text" name="name" maxlength="60" value="' + esc(e.name) + '" autocomplete="off">' +
      '<button class="outline" type="submit">Save name</button></form>' +
      '<div class="label">Weight step</div><div class="seg">' +
      L.STEPS.map(s => '<button class="' + (s === exStep(e.id) ? 'on' : '') + '" data-act="setStep" data-v="' + s + '">' + s + ' lb</button>').join('') + '</div>' +
      '<div class="label">Recent</div>' +
      (hist.length ? '<div class="hist">' + hist.map(s => '<div><b>' + shortDate(s.startedAt) + '</b> ' +
        L.setsFor(s, e.id).map(x => '<span class="' + (x.status === 'confirmed' ? '' : 'unconf') + '">' + L.fmtWeight(x.weight) + '×' + x.reps + (x.extra ? '+' + x.extra : '') + '</span>').join(', ') +
        '</div>').join('') + '</div>' : '<p class="muted">No sets logged yet.</p>') +
      (t ? '<button class="linkbtn danger" data-act="removeFromType">Remove from ' + esc(t.name) + '</button>' +
        '<p class="hint">Removing keeps its history and keeps it in your exercise list.</p>' : '');
  };

  // 5. Set screen
  screens.set = function (p) {
    const sess = S.get('sessions', p.sessionId);
    if (!sess || sess.finishedAt) return screens.home({});
    const d = ensureDraft(p, sess);
    const usual = L.usualSetCount(sessions(), sess, d.exerciseId);
    const sug = d.sug;
    let last;
    if (sug.source === 'history') {
      last = '<div class="last"><div class="label">Last time · Set ' + d.setNumber + ' · ' + shortDate(sug.from.session.startedAt) + '</div>' +
        '<div class="last-v">' + esc(L.fmtWeightLb(sug.weight)) + ' × ' + sug.reps + ' reps</div></div>';
    } else if (sug.source === 'session') {
      last = '<div class="last"><div class="label">This workout · Set ' + sug.from.set.setNumber + '</div>' +
        '<div class="last-v">' + esc(L.fmtWeightLb(sug.weight)) + ' × ' + sug.reps + ' reps</div></div>';
    } else {
      last = '<div class="last"><div class="last-v small">First time logging this set. Enter your weight and reps.</div></div>';
    }
    let hint;
    if (!d.touched && sug.source !== 'none') hint = 'Suggested from ' + (sug.source === 'history' ? 'last time' : 'your previous set');
    else hint = d.touched ? 'Your entry' : '';
    const ready = d.weight != null && d.reps != null && d.reps > 0;
    return back('Workout', 'type', { typeId: sess.typeId }) +
      '<h1 class="exname">' + esc(exName(d.exerciseId)) + '</h1>' +
      '<p class="sub">Set ' + d.setNumber + (usual ? ' · usually ' + usual + ' sets' : '') + '</p>' +
      restBar() + last +
      '<div class="label">Weight</div>' + stepper('weight', d.weight, 'lb') +
      '<div class="under">' + (d.weight === 0 ? '<span>Bodyweight</span>' :
        (d.weight == null ? '<button class="chip" data-act="bodyweight">Bodyweight</button>' : '')) +
      '<button class="chip" data-act="cycleStep">Step ' + exStep(d.exerciseId) + ' lb</button></div>' +
      '<div class="label">Reps</div>' + stepper('reps', d.reps, '') +
      '<p class="hint center" data-hint>' + esc(hint) + '</p>' +
      '<button class="primary tall" data-act="complete"' + (ready ? '' : ' disabled') + '>Set complete<small>Start rest</small></button>' +
      '<p class="hint center">You can update reps during rest.</p>';
  };

  function ensureDraft(p, sess) {
    let d = p.draft;
    const used = d && sess.sets.some(x => x.id === d.id);
    if (!d || used || d.exerciseId !== p.exerciseId) {
      const setNumber = L.nextSetNumber(sess, p.exerciseId);
      const sug = L.suggestion(sessions(), sess, p.exerciseId, setNumber);
      d = { id: uid(), exerciseId: p.exerciseId, setNumber, weight: sug.weight, reps: sug.reps, touched: false,
        sug: { source: sug.source, weight: sug.weight, reps: sug.reps,
          from: sug.from ? { set: { setNumber: sug.from.set.setNumber }, session: { startedAt: sug.from.session.startedAt } } : null } };
      p.draft = d;
      S.setMeta('ui', ui);
    }
    return d;
  }

  // 6. Rest / record screen
  screens.rest = function (p) {
    const sess = S.get('sessions', p.sessionId);
    const set = sess && sess.sets.find(x => x.id === p.setId);
    if (!set) return sess ? screens.type({ typeId: sess.typeId }) : screens.home({});
    const usual = L.usualSetCount(sessions(), sess, set.exerciseId);
    const r = getRest();
    const timing = r && r.setId === set.id;
    let status;
    if (set.status === 'confirmed') status = '<span class="saved" data-saved>Saved ✓</span>';
    else if (set.status === 'pending') status = '<span class="pending">Suggested values</span>';
    else status = '<span class="pending">Unconfirmed</span>';
    return back('Workout', 'type', { typeId: sess.typeId }) +
      '<h1 class="exname sm">' + esc(exName(set.exerciseId)) + '</h1>' +
      '<p class="sub">Set ' + set.setNumber + (usual ? ' · usually ' + usual + ' sets' : '') + '</p>' +
      (timing ? '<div class="timer" data-timerbox><div class="timer-k" data-timerlabel>Rest</div>' +
        '<div class="timer-v" data-timer></div><div class="timer-of">of 1:30</div></div>' : '') +
      '<div class="rechead"><span class="label">Record set ' + set.setNumber + '</span>' + status + '</div>' +
      stepper('weight', set.weight, 'lb', { compact: true, label: 'Weight' }) +
      stepper('reps', set.reps, '', { compact: true, label: 'Reps' }) +
      (set.extraOpen ? stepper('extra', set.extra || 0, '', { compact: true, label: 'Extra<br>reps' }) :
        '<button class="outline slim" data-act="openExtra">+ Extra reps</button>') +
      (set.status !== 'confirmed' ? '<button class="confirm" data-act="looksRight">✓ Looks right</button>' +
        '<p class="hint center">Adjust anything that’s different, or tap Looks right. Otherwise this set is kept as unconfirmed.</p>' : '') +
      '<button class="primary" data-act="nextSet">Next set →</button>' +
      '<button class="linkbtn big" data-act="exerciseDone">Exercise complete</button>' +
      '<button class="linkbtn danger small" data-act="removeSet">Remove this set</button>';
  };

  // Summary
  screens.summary = function (p) {
    const sess = S.get('sessions', p.sessionId);
    if (!sess) return screens.home({});
    const all = sessions();
    const ids = L.exerciseIdsInOrder(sess);
    const co = L.callout(all, sess, exName);
    let html = back('Home', 'home') +
      '<div class="kicker">' + esc(longDate(sess.startedAt)) + '</div>' +
      '<h1 class="tight">' + (p.justFinished ? 'Workout complete' : 'Workout') + '</h1>' +
      '<h2 class="tname">' + esc(sess.typeName) + '</h2>' +
      '<p class="sub small">' + ids.length + ' exercise' + (ids.length === 1 ? '' : 's') + ' · ' + sess.sets.length + ' sets</p>';
    if (co && co.kind === 'reps') {
      html += '<div class="callout"><div class="callout-big">' + esc(co.big) + '</div>' +
        '<div class="callout-sub">' + esc(co.name) + ' · ' + esc(co.weightText) + ' as ' + shortDate(co.date) + '</div></div>';
    } else if (co && co.kind === 'weight') {
      html += '<div class="callout"><div class="callout-big">' + esc(co.big) + '</div>' +
        '<div class="callout-sub">' + esc(co.name) + ' · ' + (co.from === 0 ? 'bodyweight' : L.roundW(co.from) + ' lb') + ' on ' + shortDate(co.date) + '</div></div>';
    } else {
      html += '<div class="callout neutral">No progress comparison yet. It appears when confirmed sets match an earlier workout at the same weight.</div>';
    }
    let anyUnconf = false;
    for (const id of ids) {
      const sets = L.setsFor(sess, id);
      html += '<h3>' + esc(exName(id)) + '</h3><table class="tbl"><thead><tr><th>Set</th><th>Weight</th><th>Reps</th><th>Extra</th></tr></thead><tbody>' +
        sets.map(x => {
          const u = x.status !== 'confirmed';
          if (u) anyUnconf = true;
          return '<tr class="' + (u ? 'unconf' : '') + '"><td>' + x.setNumber + (u ? '<sup>?</sup>' : '') + '</td><td>' +
            (x.weight === 0 ? 'BW' : L.roundW(x.weight) + ' lb') + '</td><td>' + x.reps + '</td><td class="extra">' +
            (x.extra ? '+' + x.extra : '—') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="cmp">' + esc(compareLine(L.compareExercise(all, sess, id))) + '</p>';
    }
    if (anyUnconf) html += '<p class="hint"><b>?</b> Unconfirmed: suggested numbers that were never confirmed. Not counted in progress.</p>';
    html += '<button class="primary" data-go="home">Done</button>';
    if (p.justFinished && (settings().lastExportAt || 0) < sess.finishedAt) {
      html += '<button class="outline" data-act="export">Save a backup file</button>' +
        '<p class="hint center">Keeps a copy off this phone, in iCloud Drive or Files.</p>';
    }
    if (!p.justFinished) html += '<button class="linkbtn danger" data-act="deleteSession">Delete this workout</button>';
    return html;
  };

  function compareLine(c) {
    const unc = c.unconfirmed ? ' ' + c.unconfirmed + ' unconfirmed set' + (c.unconfirmed === 1 ? '' : 's') + ' not counted.' : '';
    if (c.kind === 'no-confirmed') return 'No confirmed sets to compare.' + unc;
    if (c.kind === 'first') return 'First time logged. Nothing to compare yet.' + unc;
    const d = shortDate(c.prevSession.startedAt);
    let s;
    if (!c.pairs) s = 'No sets at matching weights to compare with ' + d + '.';
    else if (c.repDiff > 0) s = '+' + c.repDiff + ' main rep' + (c.repDiff === 1 ? '' : 's') + ' vs ' + d + ' across ' + c.pairs + ' matching set' + (c.pairs === 1 ? '' : 's') + '.';
    else if (c.repDiff === 0) s = 'Same main reps as ' + d + ' at matching weights.';
    else s = (-c.repDiff) + ' fewer main reps than ' + d + ' at matching weights.';
    if (c.weightUp) s += ' Top weight ' + L.fmtWeightLb(c.topNow) + ' (was ' + L.fmtWeightLb(c.topBefore) + ').';
    return s + unc;
  }

  // Backup & settings
  screens.data = function () {
    const st = settings();
    const n = sessions().filter(s => s.sets.length).length;
    return back('Home', 'home') + '<h1>Backup</h1>' +
      '<p>Your history is stored on this phone, inside this app. Nothing is sent anywhere. ' + n + ' workout' + (n === 1 ? '' : 's') + ' saved.</p>' +
      '<p class="muted" data-persist>Checking storage…</p>' +
      '<button class="primary" data-act="export">Export backup file</button>' +
      '<p class="hint">' + (st.lastExportAt ? 'Last export: ' + shortDate(st.lastExportAt) + '.' : 'Not exported yet.') +
      ' Save the file to iCloud Drive or Files. Export every week or two.</p>' +
      '<label class="outline filebtn">Import backup file<input type="file" accept="application/json,.json" data-import hidden></label>' +
      '<p class="hint">Importing merges a backup into what’s here; it never deletes workouts.</p>' +
      '<div class="label">Rest timer</div>' +
      '<button class="outline" data-act="toggleSound">Sound at zero: ' + (st.sound ? 'On' : 'Off') + '</button>' +
      '<p class="hint">One soft chime when rest reaches zero, while the app is open. The iPhone silent switch can mute it.</p>' +
      '<div class="label">Pocket guard</div>' +
      '<button class="outline" data-act="toggleGuard">Pocket guard: ' + (st.guard ? 'On' : 'Off') + '</button>' +
      '<p class="hint">During a workout, a clear cover stops stray taps. It comes down when a set starts and after 10 seconds without a touch. Swipe up to lift it. Pull down the lock tab at the top right to bring it back.</p>' +
      '<p class="hint center">App version ' + APP_VERSION + '</p>';
  };

  // ---------- actions ----------

  async function startWorkout(typeId) {
    const a = activeSession();
    if (a && a.typeId !== typeId) {
      if (a.sets.length) {
        if (!confirm('You have an unfinished “' + a.typeName + '” workout with ' + a.sets.length + ' sets. Finish it and start this one?')) return;
        await finishSession(a);
      } else {
        await S.del('sessions', a.id);
      }
    }
    const t = S.get('types', typeId);
    const sess = { id: uid(), typeId, typeName: t.name, startedAt: Date.now(), finishedAt: null, sets: [], completed: [] };
    await S.put('sessions', sess);
    S.requestPersistence();
    unlockAudio();
    go('type', { typeId });
  }

  async function finishSession(sess) {
    sess.sets.forEach(x => { if (x.status === 'pending') x.status = 'unconfirmed'; });
    sess.finishedAt = Date.now();
    await S.put('sessions', sess);
    const r = getRest();
    if (r && r.sessionId === sess.id) await S.setMeta('rest', null);
  }

  async function completeSet() {
    if (busy) return;
    const p = ui.params;
    const sess = S.get('sessions', p.sessionId);
    const d = p.draft;
    if (!sess || !d || d.weight == null || !d.reps) return;
    busy = true;
    try {
      unlockAudio();
      if (!sess.sets.some(x => x.id === d.id)) { // same draft id can only be saved once
        sess.sets.push({
          id: d.id, exerciseId: d.exerciseId, setNumber: L.nextSetNumber(sess, d.exerciseId),
          weight: d.weight, reps: d.reps, extra: null, extraOpen: false,
          status: d.touched ? 'confirmed' : 'pending',
          suggested: { weight: d.sug.weight, reps: d.sug.reps },
          createdAt: Date.now(),
        });
        await S.put('sessions', sess);
        await S.setMeta('rest', { setId: d.id, sessionId: sess.id, endsAt: Date.now() + L.REST_MS, notified: false });
        S.requestPersistence();
      }
      go('rest', { sessionId: sess.id, setId: d.id });
    } finally { busy = false; }
  }

  function currentRestSet() {
    const sess = S.get('sessions', ui.params.sessionId);
    return { sess, set: sess && sess.sets.find(x => x.id === ui.params.setId) };
  }

  function applyValue(field, value) {
    if (ui.screen === 'set') {
      const d = ui.params.draft;
      d[field] = value; d.touched = true;
      S.setMeta('ui', ui);
      return;
    }
    if (ui.screen === 'rest') {
      const { sess, set } = currentRestSet();
      if (!set) return;
      set[field] = value;
      set.status = 'confirmed';
      S.put('sessions', sess).then(ok => showSaved(ok));
    }
  }

  function showSaved(ok) {
    const el = app.querySelector('.rechead');
    if (!el) return;
    const st = el.querySelector('.saved,.pending');
    if (st) { st.className = 'saved'; st.textContent = ok ? 'Saved ✓' : 'Not saved!'; }
    const c = app.querySelector('[data-act="looksRight"]');
    if (c) { c.nextElementSibling && c.nextElementSibling.remove(); c.remove(); }
  }

  const actions = {
    resume() {
      const a = activeSession();
      if (a) go('type', { typeId: a.typeId });
    },
    start(el) { if (!busy) startWorkout(el.dataset.id); },
    async finish() {
      const a = activeSession();
      if (!a) return;
      if (!a.sets.length) {
        await S.del('sessions', a.id);
        flash = 'No sets were recorded, so nothing was added to your history.';
        go('home');
        return;
      }
      await finishSession(a);
      go('summary', { sessionId: a.id, justFinished: true });
    },
    openExercise(el) {
      const a = activeSession();
      go('set', { sessionId: a.id, exerciseId: el.dataset.id });
    },
    toRest() {
      const r = getRest();
      if (r) go('rest', { sessionId: r.sessionId, setId: r.setId });
    },
    newExercise() {
      const q = app.querySelector('[data-search]');
      go('newExercise', { typeId: ui.params.typeId, name: q ? q.value : '' });
    },
    pickExercise(el) { addToType(ui.params.typeId, el.dataset.id); },
    useExisting(el) { addToType(ui.params.typeId, el.dataset.id); },
    createAnyway() {
      const name = L.cleanName(app.querySelector('input[name=name]').value);
      if (name) createExercise(name, true);
    },
    async deleteType(el) {
      const t = S.get('types', el.dataset.id);
      if (!confirm('Delete the workout type “' + t.name + '”? Past workouts and exercises stay in your history.')) return;
      await S.del('types', t.id);
      go('home');
    },
    async removeFromType() {
      const t = S.get('types', ui.params.typeId);
      t.exerciseIds = t.exerciseIds.filter(x => x !== ui.params.exerciseId);
      await S.put('types', t);
      go('type', { typeId: t.id });
    },
    async setStep(el) {
      const e = exercise(ui.params.exerciseId);
      e.step = parseFloat(el.dataset.v);
      await S.put('exercises', e);
      render();
    },
    async cycleStep() {
      const e = exercise(ui.params.draft.exerciseId);
      const i = L.STEPS.indexOf(exStep(e.id));
      e.step = L.STEPS[(i + 1) % L.STEPS.length];
      await S.put('exercises', e);
      render();
    },
    bodyweight() { applyValue('weight', 0); render(); },
    complete() { completeSet(); },
    async looksRight() {
      const { sess, set } = currentRestSet();
      if (!set) return;
      set.status = 'confirmed';
      await S.put('sessions', sess);
      render();
    },
    async openExtra() {
      const { sess, set } = currentRestSet();
      set.extraOpen = true;
      if (set.extra == null) set.extra = 0;
      await S.put('sessions', sess);
      render();
    },
    nextSet() {
      const { sess, set } = currentRestSet();
      go('set', { sessionId: sess.id, exerciseId: set.exerciseId });
    },
    async exerciseDone() {
      const { sess, set } = currentRestSet();
      if (!sess.completed.includes(set.exerciseId)) sess.completed.push(set.exerciseId);
      await S.put('sessions', sess);
      go('type', { typeId: sess.typeId });
    },
    async removeSet() {
      const { sess, set } = currentRestSet();
      if (!set || !confirm('Remove set ' + set.setNumber + '? Use this if you tapped Set complete by mistake.')) return;
      const later = sess.sets.some(x => x.exerciseId === set.exerciseId && x.setNumber > set.setNumber);
      sess.sets = sess.sets.filter(x => x.id !== set.id);
      if (later) sess.sets.filter(x => x.exerciseId === set.exerciseId && x.setNumber > set.setNumber).forEach(x => x.setNumber--);
      await S.put('sessions', sess);
      const r = getRest();
      if (r && r.setId === set.id) await S.setMeta('rest', null);
      ui.screen = 'removed'; // skip the "unconfirmed" bookkeeping for a set that no longer exists
      go('set', { sessionId: sess.id, exerciseId: set.exerciseId });
    },
    async deleteSession() {
      const sess = S.get('sessions', ui.params.sessionId);
      if (!confirm('Delete this ' + sess.typeName + ' workout from ' + shortDate(sess.startedAt) + '? This cannot be undone.')) return;
      await S.del('sessions', sess.id);
      go('home');
    },
    async export() {
      const data = JSON.stringify(S.exportData(), null, 1);
      const d = new Date();
      const name = 'workouts-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.json';
      const file = new File([data], name, { type: 'application/json' });
      let ok = false;
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          ok = true;
        }
      } catch (e) { if (e.name === 'AbortError') return; }
      if (!ok) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      await S.setMeta('settings', Object.assign(settings(), { lastExportAt: Date.now() }));
      flash = 'Backup exported.';
      render();
    },
    async toggleGuard() {
      const st = settings();
      st.guard = !st.guard;
      await S.setMeta('settings', st);
      render();
    },
    async toggleSound() {
      const st = settings();
      st.sound = !st.sound;
      await S.setMeta('settings', st);
      render();
    },
  };

  async function addToType(typeId, exerciseId) {
    const t = S.get('types', typeId);
    if (!t.exerciseIds.includes(exerciseId)) {
      t.exerciseIds.push(exerciseId);
      await S.put('types', t);
    }
    go('type', { typeId });
  }

  async function createExercise(name, force) {
    if (busy) return;
    const dup = L.findByName(S.all('exercises'), name);
    if (dup && !force) {
      ui.params.name = name; ui.params.dupId = dup.id;
      S.setMeta('ui', ui);
      render();
      return;
    }
    busy = true;
    try {
      const e = { id: uid(), name, step: L.DEFAULT_STEP, createdAt: Date.now() };
      await S.put('exercises', e);
      await addToType(ui.params.typeId, e.id);
    } finally { busy = false; }
  }

  const forms = {
    async newType(f) {
      const name = L.cleanName(f.name.value);
      if (!name || busy) return;
      const existing = L.findByName(types(), name);
      if (existing && confirm('You already have “' + existing.name + '”. Open it instead?')) return go('type', { typeId: existing.id });
      busy = true;
      try {
        const t = { id: uid(), name, exerciseIds: [], createdAt: Date.now() };
        await S.put('types', t);
        go('type', { typeId: t.id });
      } finally { busy = false; }
    },
    newExercise(f) {
      const name = L.cleanName(f.name.value);
      if (name) createExercise(name, false);
    },
    async rename(f) {
      const name = L.cleanName(f.name.value);
      const e = exercise(ui.params.exerciseId);
      if (!name || name === e.name) return;
      const dup = L.findByName(S.all('exercises').filter(x => x.id !== e.id), name);
      if (dup && !confirm('You already have “' + dup.name + '”. Rename anyway?')) return;
      e.name = name;
      await S.put('exercises', e);
      flash = 'Name saved.';
      render();
    },
  };

  // ---------- events ----------

  app.addEventListener('click', e => {
    const el = e.target.closest('button');
    if (!el || el.disabled) return;
    if (el.dataset.go) {
      go(el.dataset.go, el.dataset.params ? JSON.parse(el.dataset.params) : {});
    } else if (el.dataset.step) {
      stepValue(el.dataset.step, parseInt(el.dataset.dir, 10));
    } else if (el.dataset.act && actions[el.dataset.act]) {
      actions[el.dataset.act](el);
    }
  });

  function currentValue(field) {
    if (ui.screen === 'set') return ui.params.draft[field];
    const { set } = currentRestSet();
    return set ? set[field] : null;
  }
  function currentExerciseId() {
    if (ui.screen === 'set') return ui.params.draft.exerciseId;
    const { set } = currentRestSet();
    return set && set.exerciseId;
  }

  function stepValue(field, dir) {
    const v = currentValue(field);
    const nv = field === 'weight' ? L.stepWeight(v, exStep(currentExerciseId()), dir) : L.stepReps(v, dir);
    if (nv === v) return;
    applyValue(field, nv);
    render();
  }

  app.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.search !== undefined) {
      ui.params.q = t.value;
      const tp = S.get('types', ui.params.typeId);
      app.querySelector('[data-exlist]').innerHTML = exerciseList(S.all('exercises').sort((a, b) => a.name.localeCompare(b.name)), tp, t.value);
      return;
    }
    if (t.dataset.field) {
      const v = L.parseNum(t.value, t.dataset.field === 'weight');
      if (v === undefined) return fitNum(t);
      if (v === null && (t.dataset.field !== 'weight' || ui.screen === 'rest')) return;
      applyValue(t.dataset.field, v);
      fitNum(t);
      if (ui.screen === 'set') {
        const d = ui.params.draft;
        const btn = app.querySelector('[data-act="complete"]');
        if (btn) btn.disabled = !(d.weight != null && d.reps > 0);
        const h = app.querySelector('[data-hint]');
        if (h) h.textContent = 'Your entry';
      }
    }
  });

  app.addEventListener('focusin', e => {
    if (e.target.dataset && e.target.dataset.field) setTimeout(() => e.target.select(), 0);
  });
  app.addEventListener('change', e => {
    if (e.target.dataset && e.target.dataset.field) render();
    if (e.target.dataset && e.target.dataset.import !== undefined) importFile(e.target.files[0]);
  });

  app.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    if (forms[f.dataset.form]) forms[f.dataset.form](f);
  });

  async function importFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      S.validate(data);
      const n = data.sessions.filter(s => (s.sets || []).length).length;
      if (!confirm('Import backup with ' + n + ' workouts? It will be merged with what is here.')) return;
      const c = await S.importData(data);
      flash = 'Imported: ' + c.added + ' new, ' + c.updated + ' updated records.';
    } catch (err) {
      flash = 'Could not import: ' + err.message;
    }
    render();
  }

  // ---------- timer ----------

  function tick() {
    const r = getRest();
    if (!r) return;
    const left = r.endsAt - Date.now();
    app.querySelectorAll('[data-timer]').forEach(el => { el.textContent = left > 0 ? clock(left) : 'Ready'; });
    const box = app.querySelector('[data-timerbox]');
    if (box) {
      box.classList.toggle('ready', left <= 0);
      const lbl = box.querySelector('[data-timerlabel]');
      if (lbl) lbl.textContent = left > 0 ? 'Rest' : 'Rest over';
    }
    const bar = app.querySelector('.restbar');
    if (bar) bar.classList.toggle('ready', left <= 0);
    if (left <= 0 && !r.notified) {
      r.notified = true;
      S.setMeta('rest', r);
      // Only chime if we are here at (or within a few seconds of) zero; never later, never repeating.
      if (left > -3000 && document.visibilityState === 'visible') notifyReady();
    }
  }

  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio */ }
  }

  function notifyReady() {
    if (navigator.vibrate) navigator.vibrate(150); // not supported on iPhone; works on Android
    if (!settings().sound || !audioCtx) return;
    try {
      const t = audioCtx.currentTime;
      [[660, 0], [880, 0.18]].forEach(([f, dt]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + dt);
        g.gain.linearRampToValueAtTime(0.18, t + dt + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.6);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + dt); o.stop(t + dt + 0.65);
      });
    } catch (e) { /* ignore */ }
  }

  setInterval(tick, 250);

  // Keep the screen awake during a workout, where the browser supports it.
  async function manageWakeLock() {
    const want = ['set', 'rest'].includes(ui.screen) || (ui.screen === 'type' && activeSession());
    try {
      if (want && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch (e) { wakeLock = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { tick(); manageWakeLock(); }
  });

  // ---------- number fields: shrink long numbers to fit ----------

  const measure = document.createElement('canvas').getContext('2d');
  function fitNum(el) {
    if (!el.dataset.base) el.dataset.base = parseFloat(getComputedStyle(el).fontSize);
    const base = +el.dataset.base;
    const cs = getComputedStyle(el);
    measure.font = cs.fontWeight + ' ' + base + 'px ' + cs.fontFamily;
    const w = measure.measureText(el.value || el.placeholder || '').width * 1.06 + 6;
    const avail = el.clientWidth;
    el.style.fontSize = (avail && w > avail ? Math.max(22, Math.floor(base * avail / w)) : base) + 'px';
  }
  function fitNums() { app.querySelectorAll('input.num').forEach(fitNum); }
  window.addEventListener('resize', fitNums);

  // ---------- pocket guard ----------
  // A clear cover over the screen during a workout, so a phone set down or pocketed
  // doesn't press buttons. Swipe up to lift it; pull down the tab at the top right to lower it.

  const GUARD_IDLE_MS = 10000;
  let guardOn = false;
  let guardPending = false; // a set just started: lower the guard after this render
  let idleTimer = null;
  const LOCK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="currentColor"/>' +
    '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';
  const guard = document.createElement('div');
  guard.className = 'guard';
  guard.hidden = true;
  guard.setAttribute('role', 'dialog');
  guard.setAttribute('aria-label', 'Screen locked. Swipe up to unlock.');
  guard.innerHTML = '<div class="guard-top">' + LOCK_SVG + ' Locked</div>' +
    '<div class="guard-hint"><span class="guard-arrow" aria-hidden="true">︿</span>Swipe up to unlock</div>';
  const tab = document.createElement('button');
  tab.className = 'guard-tab';
  tab.hidden = true;
  tab.setAttribute('aria-label', 'Lock screen');
  tab.innerHTML = LOCK_SVG + '<span class="guard-grip" aria-hidden="true"></span>';
  document.body.append(guard, tab);

  function guardEnabled() { return settings().guard !== false; }
  function guardScreen() { return ['set', 'rest'].includes(ui.screen) || (ui.screen === 'type' && !!activeSession()); }

  function setGuard(on) {
    guardOn = on;
    guard.hidden = !on;
    guard.style.transform = '';
    guard.classList.remove('lifting');
    tab.hidden = on || !(guardEnabled() && guardScreen());
    if (on && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    resetIdle();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (guardOn || !guardEnabled() || !['set', 'rest'].includes(ui.screen)) return;
    idleTimer = setTimeout(() => { if (['set', 'rest'].includes(ui.screen)) setGuard(true); }, GUARD_IDLE_MS);
  }

  function guardAfterRender() {
    const lower = guardPending && ui.screen === 'set' && guardEnabled();
    guardPending = false;
    if (!guardEnabled() || !guardScreen()) setGuard(false);
    else setGuard(lower || guardOn);
  }

  // Any touch on the app counts as activity.
  ['pointerdown', 'keydown', 'input'].forEach(t => app.addEventListener(t, resetIdle, true));

  // Swipe up on the cover to lift it. It follows the finger and needs a deliberate distance.
  let gy = null;
  guard.addEventListener('pointerdown', e => {
    gy = e.clientY;
    guard.setPointerCapture(e.pointerId);
    guard.classList.add('lifting');
  });
  guard.addEventListener('pointermove', e => {
    if (gy == null) return;
    const dy = Math.min(0, e.clientY - gy);
    guard.style.transform = 'translateY(' + dy + 'px)';
  });
  function guardRelease(e) {
    if (gy == null) return;
    const dy = gy - e.clientY;
    gy = null;
    guard.classList.remove('lifting');
    if (e.type === 'pointerup' && dy > Math.max(110, window.innerHeight * 0.2)) {
      guard.style.transform = 'translateY(-100%)';
      setTimeout(() => setGuard(false), 180);
    } else {
      guard.style.transform = '';
    }
  }
  guard.addEventListener('pointerup', guardRelease);
  guard.addEventListener('pointercancel', guardRelease);
  guard.addEventListener('contextmenu', e => e.preventDefault());

  // Pull the tab down (or tap it) to lower the cover.
  let ty = null;
  tab.addEventListener('pointerdown', e => { ty = e.clientY; tab.setPointerCapture(e.pointerId); });
  tab.addEventListener('pointermove', e => {
    if (ty == null) return;
    const dy = Math.max(0, Math.min(60, e.clientY - ty));
    tab.style.transform = 'translateY(' + dy + 'px)';
    if (dy >= 40) { ty = null; tab.style.transform = ''; setGuard(true); }
  });
  tab.addEventListener('pointerup', () => {
    if (ty == null) return;
    ty = null;
    tab.style.transform = '';
    setGuard(true);
  });
  tab.addEventListener('pointercancel', () => { ty = null; tab.style.transform = ''; });

  // ---------- start ----------

  async function boot() {
    S.onTrouble = showTrouble;
    await S.load();
    S.requestPersistence();
    const saved = S.getMeta('ui', null);
    if (saved && saved.screen) ui = saved;
    // Drop a started workout with no sets unless we are still inside it.
    const a = activeSession();
    const inside = a && ['type', 'set', 'rest', 'addExercise', 'newExercise', 'exercise'].includes(ui.screen) &&
      (ui.params.sessionId === a.id || ui.params.typeId === a.typeId);
    if (a && !a.sets.length && !inside) await S.del('sessions', a.id);
    render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      const updating = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').then(reg => {
        // Home Screen apps are usually resumed, not relaunched, so check for an update on resume.
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      }).catch(() => {});
      // A new version took over: reload into it, but not while a number is being typed.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!updating) return;
        const reload = () => location.reload();
        const el = document.activeElement;
        if (el && el.tagName === 'INPUT') el.addEventListener('blur', () => S.flush().then(reload), { once: true });
        else S.flush().then(reload);
      });
    }
  }

  async function showPersist() {
    const el = app.querySelector('[data-persist]');
    if (!el) return;
    const p = await S.isPersisted();
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    el.textContent = (p ? 'Storage is marked persistent.' : 'Storage is not marked persistent by the browser.') +
      (standalone ? ' Running as a Home Screen app.' : ' Tip: add this app to your Home Screen so iOS keeps its data.');
  }
  // Test hook (used by automated tests only).
  window.__app = { get ui() { return ui; }, get guardOn() { return guardOn; }, Store: S };

  boot();
})();
