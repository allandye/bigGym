// Pure data logic: suggestions, set counts, progression. No DOM, no storage.
// Loaded in the browser as window.Logic and in Node tests via require().
(function (root) {
  'use strict';

  const REST_MS = 90 * 1000;
  const DEFAULT_STEP = 5;
  const STEPS = [1, 2.5, 5, 10];

  function cleanName(s) {
    return String(s || '').trim().replace(/\s+/g, ' ');
  }

  // Loose key used to catch accidental duplicates: case, punctuation and simple plurals.
  function nameKey(s) {
    return cleanName(s).toLowerCase().replace(/[^a-z0-9 ]/g, '')
      .split(' ').filter(Boolean)
      .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) ? w.slice(0, -1) : w)
      .join(' ');
  }

  function findByName(list, name) {
    const k = nameKey(name);
    if (!k) return null;
    return list.find(x => nameKey(x.name) === k) || null;
  }

  function sameWeight(a, b) {
    return a != null && b != null && Math.abs(a - b) < 0.001;
  }

  function roundW(w) {
    return Math.round(w * 100) / 100;
  }

  // Step a weight up or down. A blank weight starts at 0 (going down) or one step (going up).
  function stepWeight(w, step, dir) {
    if (w == null || isNaN(w)) return dir > 0 ? step : 0;
    return Math.max(0, roundW(w + dir * step));
  }

  function stepReps(r, dir) {
    if (r == null || isNaN(r)) return dir > 0 ? 1 : 0;
    return Math.max(0, r + dir);
  }

  function parseNum(text, allowFraction) {
    const t = String(text).replace(',', '.').trim();
    if (t === '') return null;
    const n = allowFraction ? parseFloat(t) : parseInt(t, 10);
    if (isNaN(n) || n < 0) return undefined; // invalid
    return allowFraction ? roundW(n) : n;
  }

  function fmtWeight(w) {
    if (w == null) return '—';
    if (w === 0) return 'BW';
    return String(roundW(w));
  }

  function fmtWeightLb(w) {
    if (w == null) return '—';
    if (w === 0) return 'bodyweight';
    return roundW(w) + ' lb';
  }

  // --- session helpers ---------------------------------------------------

  function setsFor(session, exerciseId) {
    return (session.sets || []).filter(s => s.exerciseId === exerciseId)
      .sort((a, b) => a.setNumber - b.setNumber);
  }

  function nextSetNumber(session, exerciseId) {
    const sets = setsFor(session, exerciseId);
    return sets.length ? sets[sets.length - 1].setNumber + 1 : 1;
  }

  // Sessions that happened before `ref` (excluding ref itself), newest first, with at least one set.
  function priorSessions(sessions, ref) {
    return sessions
      .filter(s => s.id !== ref.id && s.startedAt < ref.startedAt && (s.sets || []).length)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  // Most recent confirmed set with the same exercise and set number, from earlier sessions.
  function lastCorresponding(sessions, ref, exerciseId, setNumber) {
    for (const s of priorSessions(sessions, ref)) {
      const hit = (s.sets || []).find(x => x.exerciseId === exerciseId &&
        x.setNumber === setNumber && x.status === 'confirmed');
      if (hit) return { set: hit, session: s };
    }
    return null;
  }

  // What to prefill on the set screen. Returns {weight, reps, source} or blanks.
  //  source 'history'  : the matching set from an earlier workout (confirmed only)
  //  source 'session'  : no history for this set number; repeat this workout's previous set
  //  source 'none'     : nothing known, user enters values
  function suggestion(sessions, session, exerciseId, setNumber) {
    const prev = lastCorresponding(sessions, session, exerciseId, setNumber);
    if (prev) return { weight: prev.set.weight, reps: prev.set.reps, source: 'history', from: prev };
    const mine = setsFor(session, exerciseId).filter(s => s.setNumber < setNumber);
    if (mine.length) {
      const last = mine[mine.length - 1];
      return { weight: last.weight, reps: last.reps, source: 'session', from: { set: last, session } };
    }
    return { weight: null, reps: null, source: 'none', from: null };
  }

  // "usually N sets": the most common set count over earlier workouts, shown only when
  // at least two earlier workouts agree on it.
  function usualSetCount(sessions, ref, exerciseId) {
    const counts = [];
    for (const s of priorSessions(sessions, ref)) {
      const n = (s.sets || []).filter(x => x.exerciseId === exerciseId).length;
      if (n) counts.push(n);
    }
    if (counts.length < 2) return null;
    const freq = new Map();
    counts.forEach(n => freq.set(n, (freq.get(n) || 0) + 1));
    let best = null, bestF = 0;
    for (const n of counts) { // newest first, so ties go to the most recent
      const f = freq.get(n);
      if (f > bestF) { best = n; bestF = f; }
    }
    return bestF >= 2 ? best : null;
  }

  // --- progression -------------------------------------------------------

  function confirmedSets(session, exerciseId) {
    return setsFor(session, exerciseId).filter(s => s.status === 'confirmed');
  }

  function maxWeight(sets) {
    return sets.reduce((m, s) => (s.weight != null && s.weight > m ? s.weight : m), -1);
  }

  // Compare one exercise in `session` with its most recent earlier workout (any workout type).
  // Only confirmed sets with the same set number AND the same weight are compared.
  // Extra reps are never counted. Additional sets with no counterpart are ignored.
  function compareExercise(sessions, session, exerciseId) {
    const cur = confirmedSets(session, exerciseId);
    const unconfirmed = setsFor(session, exerciseId).filter(s => s.status !== 'confirmed').length;
    if (!cur.length) return { kind: 'no-confirmed', unconfirmed };
    let prevSession = null, prev = [];
    for (const s of priorSessions(sessions, session)) {
      const c = confirmedSets(s, exerciseId);
      if (c.length) { prevSession = s; prev = c; break; }
    }
    if (!prevSession) return { kind: 'first', unconfirmed };
    let pairs = 0, repDiff = 0;
    const pairWeights = new Set();
    for (const c of cur) {
      const p = prev.find(x => x.setNumber === c.setNumber);
      if (p && sameWeight(p.weight, c.weight)) {
        pairs++;
        repDiff += c.reps - p.reps;
        pairWeights.add(roundW(c.weight));
      }
    }
    const topNow = maxWeight(cur), topBefore = maxWeight(prev);
    return {
      kind: 'compared', prevSession, pairs, repDiff,
      pairWeight: pairWeights.size === 1 ? [...pairWeights][0] : null,
      topNow, topBefore, weightUp: topNow > topBefore + 0.001, unconfirmed,
    };
  }

  function exerciseIdsInOrder(session) {
    const seen = [];
    for (const s of (session.sets || []).slice().sort((a, b) => a.createdAt - b.createdAt)) {
      if (!seen.includes(s.exerciseId)) seen.push(s.exerciseId);
    }
    return seen;
  }

  // The orange callout. Rep gains at matching weights win; otherwise a weight increase,
  // reported without any claim about reps. null when nothing supports a claim.
  function callout(sessions, session, nameOf) {
    let bestReps = null, bestWeight = null;
    for (const id of exerciseIdsInOrder(session)) {
      const c = compareExercise(sessions, session, id);
      if (c.kind !== 'compared') continue;
      if (c.pairs > 0 && c.repDiff > 0 && (!bestReps || c.repDiff > bestReps.c.repDiff)) bestReps = { id, c };
      if (c.weightUp && (!bestWeight || (c.topNow - c.topBefore) > (bestWeight.c.topNow - bestWeight.c.topBefore))) bestWeight = { id, c };
    }
    if (bestReps) {
      const c = bestReps.c;
      return {
        kind: 'reps',
        big: '+' + c.repDiff + ' main rep' + (c.repDiff === 1 ? '' : 's'),
        exerciseId: bestReps.id,
        name: nameOf(bestReps.id),
        weightText: c.pairWeight != null ? (c.pairWeight === 0 ? 'at bodyweight' : 'same weight') : 'same weights',
        date: c.prevSession.startedAt,
        pairs: c.pairs,
      };
    }
    if (bestWeight) {
      const c = bestWeight.c;
      return {
        kind: 'weight',
        big: 'Up to ' + roundW(c.topNow) + ' lb',
        exerciseId: bestWeight.id,
        name: nameOf(bestWeight.id),
        from: c.topBefore,
        date: c.prevSession.startedAt,
      };
    }
    return null;
  }

  const api = {
    REST_MS, DEFAULT_STEP, STEPS,
    cleanName, nameKey, findByName, sameWeight, roundW, stepWeight, stepReps, parseNum,
    fmtWeight, fmtWeightLb, setsFor, nextSetNumber, priorSessions, lastCorresponding,
    suggestion, usualSetCount, compareExercise, callout, exerciseIdsInOrder,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(this);
