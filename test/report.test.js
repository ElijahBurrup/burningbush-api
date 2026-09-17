/* What the reader report makes of a progress blob. Pure: no database, no server, no network.
   Run with: node test/report.test.js */
const { readProgress } = require('../report');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('  FAIL ' + m); } };
const J = o => JSON.stringify(o);

// ── an account written by v2.21.0 or later: everything is the real thing ─────────────────────────
const now = Date.UTC(2026, 8, 16, 14, 30);
const modern = readProgress(J({
  lastLesson: { id: 'book:40', at: now },
  stats: { '2026-08': { g: 12, d: 9, v: 3 }, '2026-09': { g: 7, d: 5 } },
  goalLog: [{ d: '2026-9-15', got: 4 }], goalDay: { date: '2026-9-16', count: 2 },
  memorized: ['40:6:33', '19:23:1'], doneSkills: ['snd:0-4', 'book:1']
}));
ok(modern.lastLessonId === 'book:40' && modern.lastLessonAt === now, 'the stamped lesson is used');
ok(modern.lastLessonEst === false, 'a stamped lesson is not an estimate');
ok(modern.goalUnits === 19, 'goal units are the months added up, not the fortnight');
ok(modern.goalUnitsEst === false, 'a real tally is not an estimate');
ok(modern.verses === 2 && modern.daysActive === 14, 'verses and active days come off the same blob');

// ── an account last opened before the fields existed: fall back, and say so ──────────────────────
const old = readProgress(J({
  doneSkills: ['snd:0-4', 'snd:5-9', 'book:5'],
  goalLog: [{ d: '2026-9-14', got: 3 }, { d: '2026-9-15', got: 2 }],
  goalDay: { date: '2026-9-16', count: 1 },
  memorized: []
}));
ok(old.lastLessonId === 'book:5' && old.lastLessonAt === null, 'the tail of doneSkills stands in, with no day');
ok(old.lastLessonEst === true, 'a lesson read from the order it was finished in is flagged');
ok(old.goalUnits === 6 && old.goalUnitsEst === true, 'the fortnight plus today stands in, and is flagged');

// A stamped lesson wins even when doneSkills has something later in it: the stamp is the record of
// what was last DONE, and doneSkills never records a repeat at all.
const both = readProgress(J({ lastLesson: { id: 'snd:5-9', at: now }, doneSkills: ['book:1', 'book:2'] }));
ok(both.lastLessonId === 'snd:5-9' && both.lastLessonEst === false, 'the stamp beats the list');

// ── nothing, and nonsense ───────────────────────────────────────────────────────────────────────
const empty = readProgress(null);
ok(empty.lastLessonId === null && empty.goalUnits === 0 && empty.goalUnitsEst === false, 'an account with no progress reads as empty');
ok(readProgress('not json at all').goalUnits === 0, 'a corrupt blob does not throw');
ok(readProgress(J({ stats: null, goalLog: 'nope', doneSkills: 'nope' })).goalUnits === 0, 'wrong types do not throw');
ok(readProgress(J({ goalLog: [{ got: 'x' }, null], goalDay: { count: 3 } })).goalUnits === 3, 'junk rows in the log are skipped');
// Zero is zero, not "estimated zero": an account that has done nothing must not be flagged as a guess.
ok(readProgress(J({ goalLog: [], goalDay: null })).goalUnitsEst === false, 'no work at all is not an estimate');

console.log(`report: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
