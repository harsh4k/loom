import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWeeklyReportJob, reportBlocks, staleReadmes } from '../src/jobs/weekly-report.mjs';
import { openLedger } from '../src/ledger.mjs';

const NOW = new Date('2026-10-18T13:30:00Z');
const json = (status, body) => new Response(JSON.stringify(body), { status });

test('flags READMEs untouched for 90 days while the code moved on', async () => {
  const github = { lastChanged: async (fullName) => ({ 'example-dev/old': '2026-05-01T00:00:00Z', 'example-dev/fresh': '2026-10-01T00:00:00Z' }[fullName] ?? null) };
  const repos = [
    { name: 'old', fullName: 'example-dev/old', pushedAt: '2026-10-10T00:00:00Z' },
    { name: 'fresh', fullName: 'example-dev/fresh', pushedAt: '2026-10-10T00:00:00Z' },
    { name: 'none', fullName: 'example-dev/none', pushedAt: '2026-10-10T00:00:00Z' },
    { name: 'quiet', fullName: 'example-dev/quiet', pushedAt: '2025-01-01T00:00:00Z' },
    { name: 'example-dev', fullName: 'example-dev/example-dev', pushedAt: '2026-10-10T00:00:00Z' },
  ];
  assert.deepEqual(await staleReadmes({ github, repos, now: NOW }), ['old: README last changed 2026-05-01, code pushed 2026-10-10', 'none: no README.md']);
});

test('the report lists failures first, then runs, changes and READMEs', () => {
  const blocks = reportBlocks({
    runs: [{ jobId: 'notion-projects', name: 'Notion projects', state: 'failed', date: '2026-10-12', summary: 'Notion can’t see it.' }],
    changes: [{ createdAt: '2026-10-12T04:00:00Z', label: 'Added Apexfr', state: 'applied' }, { createdAt: '2026-10-12T04:00:00Z', label: 'x', state: 'failed' }],
    problems: ['github: refused'], stale: [], from: '2026-10-11', to: '2026-10-18',
  });
  const lines = blocks.map((block) => block[block.type].rich_text?.[0]?.text.content);
  assert.deepEqual(lines.slice(1, 4), ['Needs your attention', 'github: refused', 'Notion projects failed on 2026-10-12: Notion can’t see it.']);
  assert.ok(lines.includes('2026-10-12 Added Apexfr'));
  assert.ok(!lines.includes('2026-10-12 x'), 'failed writes are not listed as changes');
});

test('writes one page a week under the report page and skips a second time', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-report-'));
  try {
    const created = [];
    const fetchImpl = async (url, init = {}) => {
      if (url.includes('api.github.com/users/')) return json(200, []);
      if (url === 'https://api.notion.com/v1/pages' && init.method === 'POST') { created.push(JSON.parse(init.body)); return json(200, { id: 'report-1', url: 'https://notion.so/report-1' }); }
      return json(404, {});
    };
    const job = createWeeklyReportJob({
      connections: () => ({ token: (provider) => (provider === 'notion' ? 'secret_notion_key_1234567890' : null), status: () => ({}) }),
      openLedger: () => openLedger(path.join(dir, 'hub.sqlite')),
      readRuns: () => [{ jobId: 'linkedin-draft', state: 'succeeded', date: '2026-10-15', summary: 'Posted.', updatedAt: '2026-10-15T03:00:00Z' }],
      fetch: fetchImpl, now: () => NOW,
    });
    assert.match((await job.run({ runId: 'w1', report: () => {} })).summary, /Weekly report written to Notion: 1 runs/);
    assert.equal(created.length, 1);
    assert.equal(created[0].parent.page_id, '66666666-7777-8888-9999-000000000000');
    assert.equal(created[0].properties.title.title[0].text.content, 'Hub report: week to 2026-10-18');
    assert.match((await job.run({ runId: 'w2', report: () => {} })).summary, /already in Notion/);
    assert.equal(created.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
