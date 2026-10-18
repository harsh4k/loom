# Local content evaluation

Copy constraints, editorial quality, static composition, and motion are different results. A rendered file or passing test does not mean a post is publishable.

The production draft job still uses the hidden PowerShell runner and its existing lease protocol. The structured Node brief/copy generator is a benchmark candidate, not the production default. Nothing in these commands posts, approves, or schedules LinkedIn content.

## Copy

```powershell
node scripts/eval-copy.mjs
node scripts/eval-copy.mjs --generate --engine node --inputs data/quality/2026-10-17-upgrade --brand config/brand.json --story-only --runs 2 --topic "Bunny OS,Rudo,shipd,GetCited,Late Apex" --out data/quality/new-copy-run
```

Omit `--story-only` to include frozen project descriptions, stacks, and README excerpts. Use a different output folder for each arm. With `--inputs`, brand and benchmark settings come from the snapshot unless explicitly overridden. Pass `--brand config/brand.json` when evaluating current rules against old source snapshots.

An input folder contains `inputs.json` (`profile`, `brand`, `benchmark`), `story-bank.md`, `history/*.md`, optional `projects.json`, and optional `readmes/<topic-slug>.md`. Keep snapshots private under gitignored `data/quality/`; they must never contain connection keys.

Use `--engine legacy` for the hardened current PowerShell runner. `--runner` can name an archived runner for a historical comparison. Each arm gets isolated files and accepted-post history. Attempts and raw local model responses are retained, including failures. Repeated briefs are rejected before writing copy; exhausted evidence can produce an explicit insufficient-novelty skip.

The report distinguishes attempted, generated, scorable, constraint-valid, skipped, and publishable counts. Publishability stays unknown until a review is recorded. Numeric/name checks and citation anchors are filters, not proof that a sentence follows from its evidence. Inspect each claim and its cited source, then rate specificity, voice, originality, and whether it is worth publishing. Missing project metadata is unscorable; do not silently infer a project from the full Story Bank.

## Studio

```powershell
node scripts/check-studio.mjs --out data/quality/studio-regression
node scripts/check-wipe.mjs
node scripts/check-motifs.mjs
node scripts/eval-media.mjs --inputs data/quality/2026-10-17-upgrade --out data/quality/new-media-run
node scripts/quality-preview.mjs --dir data/quality/2026-10-17-upgrade --port 4277
```

Studio checks use the browser and tools already installed in `media/`. No new dependency or generation model is needed. Only the preview server binds a port, on `127.0.0.1`. `eval-media` also accepts `--source-root` for a frozen code baseline and `--topics` for a comma-separated subset.

Media inputs additionally support `images/<topic-slug>/shot.png` or `readme.png`, and copied `looks.json` / `storyboards.json`. The benchmark uses private per-arm caches. Generated copy can guide the story but never enters its factual evidence.

Each output keeps `<name>.quality/manifest.json`, source mappings, film/look, per-format command reports and contact sheets. Missing or malformed evidence is `UNVERIFIED`; failed layout, critique, or rendering is `FAIL`. The visual critique threshold is 7/10. Fallback output receives the same inspections. Failed/unverified output does not enter accepted storyboard history, and studio errors are not disguised as successful plain-template renders.

Review the poster and each aspect ratio separately. Full video playback is still required for readability, pacing, transition continuity, and the ending; still frames cannot establish these. Abstract motifs are visual metaphors, not measured data or architecture diagrams. Compare initial results with final reruns and keep rejected examples rather than selecting only attractive successes.

## Verification

```powershell
node "$HOME/.agents/gates/verify.mjs"
```

Use the machine's normal gate location if different. The hub has no lint, typecheck, or build script, so this gate runs its declared tests. Runtime/browser evidence is separate. On restricted Windows sandboxes, HTTP, symlinks, fonts, or browser caches may need execution outside the sandbox; report the actual failure and adaptation rather than reducing checks.
