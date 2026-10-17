# Loom

## Purpose

A Windows automation hub (Notion, GitHub, LinkedIn, portfolio sync) on a local Ollama model, with a dashboard and an Electron desktop app. Anything specific to one person lives in `config/profile.json` (not committed; `src/profile.mjs` reads it, `config/profile.example.json` shows the shape). Never hard-code a person's names, ids, paths or repos in src/.

## Stack and commands

- Node.js 24+ target, ECMAScript modules, built-in `node:sqlite`, and `node:test`.
- No application dependencies are declared in `package.json`.
- `desktop/` is a separate Electron app (own package.json, `npm ci && npm run dist` builds the Windows installer). It only shows the dashboard and starts the logon task; never import Electron or desktop/ code from src/.
- Run tests with `npm test` (it loads `test/setup.mjs`, which points the profile at `test/fixtures/profile.json`). Start with `npm start`.

## Architecture

- `src/store.mjs` owns persistent run/event records and delegates lease lifecycle to `src/lease.mjs`.
- `src/automations.mjs` lists automations (schedule in the profile's time zone, `usesModel`, `timeLimitMs`, `needs` = profile settings it requires); only `active` entries have a job handler.
- `src/registry.mjs` wraps handlers into the queue's job map (Ollama check for model jobs, time limits). `bootstrap.createHubJobs()` is the one place handlers are registered; the CLI and the hub both use it.
- `src/scheduler.mjs` starts scheduled runs, catches up missed slots under 12 hours old, retries `RetryableError` failures (`src/errors.mjs`) and runs the daily backup (`src/backup.mjs`).
- `src/connections.mjs` holds Notion/GitHub keys; `src/ledger.mjs` is the change log for every outside write (record with `begin` before writing, then `applied`/`failed`; `lastWritten` decides whether a field is still the hub's to change).
- `src/jobs/notion-projects.mjs` is the GitHub to Notion sync (`planSync` works out changes without writing; `preview` and `node src/cli.mjs preview notion-projects` show them). `src/github/` reads repos and builds the tech stack; `src/notion/client.mjs` is the only code that talks to Notion, and only `WRITABLE_FIELDS` can be written. Undo handlers are registered in `createHubJobs().undo` by change target.
- `src/jobs/project-details.mjs` writes the hub-owned Notion section with Qwen (`src/model.mjs`); every model answer must pass `src/details/check.mjs` (shape, placeholders, grounding in the repo text) or the project is skipped.
- `src/jobs/portfolio-sync.mjs` commits only `portfolio.file` in `portfolio.repo`; it adds and removes entries by the Notion "On portfolio" checkbox and "Portfolio ID" and never edits an existing entry.
- `src/cli.mjs run <job-id>` is the Task Scheduler entry point and records into the same store as the dashboard.
- `test/store.test.mjs` covers persistence, validation, lease ownership, and recovery.
- The LinkedIn drafts root is `drafts` inside `linkedin.folder` (default `data/linkedin`).

## Boundaries

- LinkedIn posting uses only the official API (`src/linkedin/`), never a browser bot. A draft is posted at most once, per the ledger in `data/linkedin-posted.json`; drafts with brackets or placeholders are never posted.
- Bind the hub only to `127.0.0.1` (the LinkedIn sign-in callback alone also accepts `localhost`); do not capture app screens.
- Outside writes: never delete (archive instead), record each write in the ledger first, never overwrite a field whose current value differs from `ledger.lastWritten` (the user edited it) or is `UNDONE`, and stop a run before writing when it would exceed its change cap.
- Never put a key in the database, logs, events, API responses or backups.
- Keep the single-job lease held when process or child-tree exit cannot be confirmed. Recover only against the persisted owner/child identities after exit is confirmed.
- Do not alter the existing Windows scheduled task unless its exact action, principal, and settings can be inspected, exported for rollback, and verified after migration.
- Keep database and log files private to the current Windows user.

## Known issues

- Artifact validation in the store is lexical. Any future draft reader must resolve the canonical path and reject symlink/junction escapes before opening a file.

## Status

Store, queue, server, CLI, the Apple-style dashboard and LinkedIn auto-posting are built and tested. The Windows task runs `src/cli.mjs run linkedin-draft`.
