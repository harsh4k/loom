import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBrand } from '../src/eval/copy-score.mjs';

test('input snapshots freeze brand and benchmark settings, with explicit environment override', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-copy-inputs-'));
  try {
    await mkdir(path.join(root, 'history'));
    await writeFile(path.join(root, 'story-bank.md'), '- Alpha: local assistant.');
    await writeFile(path.join(root, 'history', 'one.md'), '# Draft\n\n- Project: Alpha\n\n---\n\nAlpha is local.');
    await writeFile(path.join(root, 'inputs.json'), JSON.stringify({ profile: { linkedin: { topics: ['Alpha'] } }, brand: { ...loadBrand(), version: 77 }, benchmark: { humanRatings: ['Frozen rating'] } }));
    const run = (out, env = {}) => spawnSync(process.execPath, ['scripts/eval-copy.mjs', '--inputs', root, '--out', path.join(root, out)], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LOOM_BRAND: '', ...env }, timeout: 20_000 });
    const frozen = run('frozen');
    assert.equal(frozen.status, 0, frozen.stderr);
    assert.equal(JSON.parse(await readFile(path.join(root, 'frozen', 'results.json'), 'utf8')).brandVersion, 77);
    assert.match(await readFile(path.join(root, 'frozen', 'scorecard.md'), 'utf8'), /Frozen rating/);
    const override = path.join(root, 'override.json');
    await writeFile(override, JSON.stringify({ ...loadBrand(), version: 88 }));
    const custom = run('custom', { LOOM_BRAND: override });
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(JSON.parse(await readFile(path.join(root, 'custom', 'results.json'), 'utf8')).brandVersion, 88);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('raw response tracing preserves malformed model text without consuming the response', async () => {
  const { createTracedFetch } = await import('../src/eval/copy-trace.mjs').catch(() => ({}));
  assert.equal(typeof createTracedFetch, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'loom-copy-trace-'));
  try {
    const fetch = createTracedFetch({ directory: root, fetch: async () => new Response('{"message":{"content":"{broken"}}') });
    const response = await fetch('http://127.0.0.1:11434/api/chat', { body: '{"model":"local"}' });
    assert.equal((await response.json()).message.content, '{broken');
    const trace = JSON.parse(await readFile(path.join(root, '0001.json'), 'utf8'));
    assert.match(trace.response, /broken/);
    assert.equal(trace.request.model, 'local');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the PowerShell runner keeps the selected repository and writes one-attempt traces as an array', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-copy-powershell-'));
  try {
    await mkdir(path.join(root, 'drafts'));
    await writeFile(path.join(root, 'story-bank.md'), '- Alpha (github.com/demo/alpha): local assistant. Beta (github.com/demo/beta): remote helper.');
    const profileFile = path.join(root, 'profile.json');
    const brandFile = path.join(root, 'brand.json');
    const attemptsFile = path.join(root, 'attempts.json');
    await writeFile(profileFile, JSON.stringify({ linkedin: { folder: root, topics: ['Alpha', 'Beta'] } }));
    const brand = loadBrand();
    await writeFile(brandFile, JSON.stringify({ ...brand, copy: { ...brand.copy, minChars: 20 } }));
    const runner = path.resolve('scripts/linkedin-local-draft.ps1').replace(/'/g, "''");
    // Replace only the external Ollama boundary; execute the actual runner and Node adapter.
    const command = `function global:Invoke-RestMethod { return @{ done_reason='stop'; message=@{content=(@{topic='Beta';formula='Concrete';post='Beta is a remote helper.'}|ConvertTo-Json -Compress)} } }; & '${runner}' -DryRun -Topic Beta`;
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, LOOM_PROFILE: profileFile, LOOM_BRAND: brandFile, LOOM_COPY_ATTEMPTS: attemptsFile, LOOM_COPY_STORY: '', LOOM_COPY_HISTORY: '' } });
    assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stderr}\n${child.stdout.slice(-3000)}`);
    assert.match(child.stdout, /First comment: github\.com\/demo\/beta/);
    assert.doesNotMatch(child.stdout, /First comment: github\.com\/demo\/alpha/);
    const attempts = JSON.parse((await readFile(attemptsFile, 'utf8')).replace(/^\uFEFF/, ''));
    assert.ok(Array.isArray(attempts));
    assert.equal(attempts.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy benchmark runners receive frozen story and history files plus the effective brand', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-copy-legacy-'));
  try {
    await mkdir(path.join(root, 'history'));
    await writeFile(path.join(root, 'story-bank.md'), '- Alpha: local assistant.');
    await writeFile(path.join(root, 'history', 'one.md'), '# Draft\n\n---\n\nEarlier opening about memory.');
    await writeFile(path.join(root, 'inputs.json'), JSON.stringify({ profile: { linkedin: { topics: ['Alpha'] } }, brand: { ...loadBrand(), version: 77 }, benchmark: { runsPerTopic: 1 } }));
    const runner = path.join(root, 'old-runner.ps1');
    await writeFile(runner, `param([switch]$DryRun,[string]$Topic)
$profile=Get-Content $env:LOOM_PROFILE -Raw|ConvertFrom-Json
$folder=$profile.linkedin.folder
$story=Get-Content (Join-Path $folder 'story-bank.md') -Raw
$history=@(Get-ChildItem (Join-Path $folder 'drafts') -Filter '*.md')
$brand=Get-Content $env:LOOM_BRAND -Raw|ConvertFrom-Json
if ($story -notmatch 'Alpha' -or $history.Count -ne 1 -or $brand.version -ne 77) { throw 'Snapshot input mismatch' }
Write-Output 'DRY RUN: Would write isolated.md'
Write-Output "# Draft\n\n- Project: Alpha\n\n---\n\nAlpha is a local assistant.\n\nWhich technical detail would you examine first when evaluating the requirements of a local assistant?"
`);
    const out = path.join(root, 'out');
    const child = spawnSync(process.execPath, ['scripts/eval-copy.mjs', '--generate', '--engine', 'legacy', '--inputs', root, '--runner', runner, '--out', out], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, LOOM_BRAND: '' } });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(await readFile(path.join(out, 'results.json'), 'utf8'));
    assert.equal(result.summary.generated, 1);
    assert.equal(result.results[0].error, undefined, JSON.stringify(result.results[0]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
