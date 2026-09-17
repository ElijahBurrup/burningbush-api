/* What an admin report can honestly say about one account, read out of its progress blob.
   Kept apart from server.js so it can be tested without a database: everything here is pure.

   Two of these numbers depend on fields the app only started writing in v2.21.0. An account that
   has not been opened since has no lesson stamp and no monthly goal tally, so each falls back to
   the best the older data can give — the tail of doneSkills, which is append-only, and the fortnight
   the goal log keeps — and says so. A guess that reads as a measurement is worse than a blank. */
/* doneSkills holds more than lessons: a film marks itself done there (video:verse), and so do a
   couple of internal ids (numtest:73). Reading its tail blind reported a film as somebody's last
   lesson, so the fallback only accepts the kinds the learn path actually teaches. */
const LESSON_KINDS = /^(snd|num|book|peg|palace|story):/;

function readProgress(progJson) {
  const out = { lastLessonId: null, lastLessonAt: null, lastLessonEst: false,
                goalUnits: 0, goalUnitsEst: false, verses: 0, daysActive: 0 };
  let p;
  try { p = JSON.parse(progJson || '{}') || {}; } catch (e) { return out; }
  if (!p || typeof p !== 'object') return out;

  const last = p.lastLesson;
  if (last && last.id) {
    out.lastLessonId = String(last.id);
    out.lastLessonAt = Number(last.at) || null;
  } else if (Array.isArray(p.doneSkills)) {
    for (let i = p.doneSkills.length - 1; i >= 0; i--) {
      const id = String(p.doneSkills[i] || '');
      if (LESSON_KINDS.test(id)) {
        out.lastLessonId = id;
        out.lastLessonEst = true;                  // the order it was finished in, with no day attached
        break;
      }
    }
  }

  const stats = (p.stats && typeof p.stats === 'object') ? p.stats : {};
  Object.keys(stats).forEach(k => {
    const row = stats[k] || {};
    out.goalUnits += Number(row.g) || 0;
    out.daysActive += Number(row.d) || 0;
  });
  if (!out.goalUnits) {
    (Array.isArray(p.goalLog) ? p.goalLog : []).forEach(x => { out.goalUnits += Number(x && x.got) || 0; });
    out.goalUnits += Number(p.goalDay && p.goalDay.count) || 0;
    if (out.goalUnits) out.goalUnitsEst = true;    // a fortnight, standing in for a lifetime
  }

  out.verses = Array.isArray(p.memorized) ? p.memorized.length : 0;
  return out;
}

module.exports = { readProgress };
