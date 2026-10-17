import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIONS, missingSetup } from '../src/automations.mjs';
import { latestSlot } from '../src/scheduler.mjs';
import { localDate } from '../src/dates.mjs';
import { getProfile, need, normalizeProfile } from '../src/profile.mjs';

test('tests read the made-up profile, never a real one', () => {
  assert.equal(getProfile().github.user, 'example-dev');
});

test('an empty profile gets safe defaults and every automation reports what it needs', () => {
  const empty = normalizeProfile({ timeZone: 'Not/AZone' });
  assert.ok(empty.timeZone && empty.timeZone !== 'Not/AZone');
  assert.ok(empty.linkedin.folder.endsWith('linkedin'));
  for (const automation of AUTOMATIONS.filter((item) => item.needs?.length)) assert.ok(missingSetup(automation, empty).length > 0, automation.id);
  assert.deepEqual(missingSetup(AUTOMATIONS.find((item) => item.id === 'notion-projects')), []);
  assert.throws(() => need('', 'github.user'), /Set github\.user in config\/profile\.json/);
});

test('schedules follow the profile time zone, daylight saving included', () => {
  const weekdays8 = { days: [1, 2, 3, 4, 5], time: '08:00' };
  // New York: 08:00 is 12:00 UTC in summer (EDT) and 13:00 UTC in winter (EST).
  assert.equal(latestSlot(weekdays8, new Date('2026-07-07T15:00:00Z'), 'America/New_York').at.toISOString(), '2026-07-07T12:00:00.000Z');
  assert.equal(latestSlot(weekdays8, new Date('2026-12-08T15:00:00Z'), 'America/New_York').at.toISOString(), '2026-12-08T13:00:00.000Z');
  // Just after midnight UTC on a Saturday is still Friday evening in New York.
  assert.deepEqual(latestSlot(weekdays8, new Date('2026-12-12T01:00:00Z'), 'America/New_York').date, '2026-12-11');
  assert.equal(localDate(new Date('2026-12-12T01:00:00Z'), 'America/New_York'), '2026-12-11');
  assert.equal(localDate(new Date('2026-12-11T20:00:00Z'), 'Asia/Kolkata'), '2026-12-12');
});
