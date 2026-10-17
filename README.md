# Loom

A local automation hub with its own desktop app. It keeps a Notion projects database in step
with your GitHub repos, writes project summaries, syncs your portfolio site, writes LinkedIn posts
and posts them, and sends you a weekly report. Everything runs on your own Windows PC with Ollama
(`qwen3.5:9b-q4_K_M`); nothing calls a paid API.

## Set up

Requires Windows, Node.js 24 or newer (`node --version`) and [Ollama](https://ollama.com) with
the model pulled (`ollama pull qwen3.5:9b-q4_K_M`).

1. Clone the repo and copy the example settings:

   ```powershell
   git clone https://github.com/<you>/loom.git
   cd loom
   copy config\profile.example.json config\profile.json
   copy config\projects.example.json config\projects.json
   ```

2. Fill in `config\profile.json`. Only the parts for the automations you want are needed; an
   automation whose settings are missing shows **Needs setup** and never runs on its schedule.

   | Setting | Used by |
   | --- | --- |
   | `name` | LinkedIn posts (the author name on post images) |
   | `timeZone` | Every schedule, e.g. `Europe/London`. Leave it out to use the PC's time zone. |
   | `github.user` | Notion projects, Project details, Weekly report |
   | `notion.projectsDatabaseId` | Notion projects, Project details, Portfolio sync (the id in the database's URL) |
   | `notion.reportPageId` | Weekly report (the page the report goes under) |
   | `portfolio.repo`, `portfolio.file`, `portfolio.imagesDir` | Portfolio sync |
   | `linkedin.folder` | Where `story-bank.md` and `drafts\` live. Defaults to `data\linkedin`. |
   | `linkedin.topics` | LinkedIn posts: the projects the posts rotate through |
   | `linkedin.audience`, `linkedin.avoid` | Who posts are written for, and names a post must never contain |

3. Start the hub and add your keys on the **Accounts** page (Notion, GitHub, LinkedIn):

   ```powershell
   npm test     # optional: run the checks
   npm start    # opens the hub at http://127.0.0.1:4173
   ```

`config\profile.json`, `config\projects.json` and everything in `data\` stay on your PC; they are
in `.gitignore`. After changing `profile.json`, restart the hub.

Stop it with `Ctrl+C` in that window. The hub only listens on `127.0.0.1`, so nothing
else on your network can reach it.

## The desktop app

`desktop/` is Loom, an Electron app around the dashboard: its own window (no browser, no address bar),
a tray icon, a Windows notification when an automation fails, and an installer with Start menu
and desktop shortcuts. The hub itself still runs as the "Automation Hub" logon task, so closing
or quitting the app never stops the automations; the app starts that task if it isn't running.

Build and install it (needs internet once for Electron):

```powershell
cd desktop
npm ci
npm run dist
.\dist\Loom-Setup-1.0.0.exe
```

Closing the window keeps it in the tray. The tray menu has **Open when I sign in** and **Quit**.
Links to other sites (GitHub, Notion, LinkedIn sign-in) open in your normal browser.
The hub's own code stays dependency-free; Electron is only in `desktop/`.

## What you see

- **Overview**: one tile per automation with its status, last result and next run.
- **Automation page**: schedule, next and last run, run history and the latest output.
- **Activity**: a timestamped log of everything the hub has done.
- **Live activity panel**: the same log beside your page on wide screens.
- **Changes**: every change the hub made outside this PC, with the value before and after. A Notion change can be undone, and the hub then leaves that field alone for good.
- **Accounts**: the Notion and GitHub keys, and a link to the LinkedIn sign-in.
- **Health strip** on the overview: whether Ollama is running, free disk space and the last backup.
- **Runs on schedule** switch on each automation page turns its schedule off or on.
- **Pause all**: stops new runs from starting until you resume. A run already in progress keeps going; use **Stop run** on its page to end it.

Automations marked **Not set up** are planned and do not run yet.

## Scheduled runs

The hub runs each automation at its own time (in `timeZone` from your profile) while it is running, which is all
day since it starts at login. If the PC was off at a run's time, the hub runs it when it starts,
as long as that time was less than 12 hours ago. A run that fails for a reason that can pass
(Ollama starting, the network, a busy API) is tried again 15 minutes later, up to 3 tries in all.
A run that fails for good shows a Windows notification. Before a job that uses the model, the
hub starts Ollama if it isn't running. Model jobs stop after 20 minutes (LinkedIn after 30),
other jobs after 5.

To run an automation from Windows Task Scheduler instead, use:

```powershell
node <path-to-loom>\src\cli.mjs run linkedin-draft
```

Scheduled runs are written to the same database as the dashboard, so they appear there
whether or not the hub was open at the time. Only one model job runs at a time; a second
run for the same automation on the same day is skipped. The exit code is `0` for success
or a same-day skip, `1` for a failed or stopped run, and `2` for a bad command.

## LinkedIn posting

Each finished draft is posted to LinkedIn through the official API, with the repo link as the
first comment. Drafts are written from `story-bank.md` in your LinkedIn folder: one fact per line,
naming the project it is about. Posting stays off until you connect an account on the LinkedIn posts page:

1. At https://www.linkedin.com/developers/apps create an app (any company page you own works).
2. Under **Products**, add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
3. Under **Auth**, add the redirect URL `http://localhost:4173/linkedin/callback`.
4. Paste the Client ID and Client secret into the dashboard, then click **Connect LinkedIn**.

The sign-in lasts 60 days; the page warns a week before it ends. A draft is never posted
twice (`data\linkedin-posted.json` records each one), and a draft that still has a bracket or
placeholder is saved without posting. If a post attempt loses its connection mid-request the
draft is not retried, since it may already be live.

## Notion projects

Every Monday at 9:00 AM the hub reads your GitHub repos (`github.user`, forks and the profile repo
skipped) and keeps your Notion Projects database in step. The database needs these properties:
Name, GitHub URL, Description, Tech Stack, Type and Status (select options `👤 Personal`,
`⚡ In Dev`, `🚀 Deployed`, `🔧 Maintenance`, `📦 Archived`); Portfolio sync also uses an
**On portfolio** checkbox and a **Portfolio ID** text property. A repo is matched to a page by its
GitHub URL, never by name.

- A repo with no page gets one: Name, GitHub URL, Description (the repo's GitHub description),
  Tech Stack (from GitHub's language list and the manifest files), Type `👤 Personal`, and Status
  `⚡ In Dev` if pushed in the last 30 days, `🚀 Deployed` if it has a homepage, else `🔧 Maintenance`.
- On an existing page only Description and Tech Stack change, and only while the field is empty
  or still holds what the hub last wrote. Once you edit a field it is yours.
- A repo archived on GitHub sets the page's Status to `📦 Archived`. With a GitHub key connected,
  a repo that no longer exists does too; without one, a repo GitHub can't show (private) is left alone.
- A repo whose name matches a page with no GitHub URL gets no new page; the run says so.
- A run that would add more than 10 pages or change more than 25 stops before writing anything.
- Nothing is ever deleted. Each change is in the change log, and Undo puts it back (a page the
  hub added is archived).

Setup: at https://www.notion.so/profile/integrations create an internal integration, paste its
key on the Accounts page, then in Notion open your Projects database, choose **•••** > **Connections**
and add the integration. To see what a run would change without writing anything:

```powershell
node src\cli.mjs preview notion-projects
```

## Project details

Every Monday at 9:30 AM, for each Notion project whose repo was pushed since the last run (up to
8 a run), Qwen reads the README, the manifest files and the last 20 commit messages and writes a
short description and 3 to 6 features. They go into a **Project details** section the hub adds at
the end of the page (Notion's API can only add blocks at the end). An empty Description property
is filled with the same description.

- Output must be JSON of a fixed shape and length, with no brackets, placeholders or links, and
  every name or number in it must appear in the repo text. Features that fail are dropped; if
  fewer than 3 are left, or the description fails, that project is skipped and the run says why.
- The README is passed to the model as data with an instruction to ignore anything in it that
  reads like a command.
- The hub only rewrites its own section, and only while it still reads exactly as the hub wrote
  it. Edit or delete the section and the hub leaves that page alone from then on.
- Undo puts the previous details back. A section that was just added can't be undone; delete it
  in Notion instead.

## Portfolio sync

Every Monday at 10:00 AM the hub compares the **On portfolio** checkbox in your Projects database
with your portfolio's project list (`portfolio.file`, a JSON list in `portfolio.repo`) and commits
that one file when they differ. Your host (Cloudflare Pages, Netlify, Vercel) then rebuilds the
site as it does for any push.

- A ticked project that isn't on the site is added at the end, with its name, GitHub link, tech
  stack and (if 120 characters or fewer) its Description. It needs an image at
  `<portfolio.imagesDir>/<id>.webp` first; until then the run lists it as left out. The id is written to
  the page's **Portfolio ID** so the two stay linked.
- Unticking a linked project removes it from the site. More than 3 removals in one run, or a run
  where nothing is ticked, stops before writing anything.
- Entries already on the site are never edited, so your hand-written text stays. Entries with no
  Notion page are kept.
- Undo puts the previous file back, if nobody has changed it since.

It needs a GitHub key: a fine-grained token at https://github.com/settings/personal-access-tokens
with access to your portfolio repo only and **Contents: Read and write**, pasted on the Accounts page.

## Weekly report

Every Sunday at 7:00 PM the hub writes one page in Notion under `notion.reportPageId`: anything that needs
your attention (failed runs, keys that stopped working), what each automation did that week,
every change it made outside your PC, and READMEs that look out of date (code pushed in the last
90 days while README.md hasn't changed for 90 days or more). It writes one page per week and
never edits it afterwards.

## Data

- Run history, activity and the change log: `data\hub.sqlite`, readable only by your Windows user.
- Activity events older than 90 days are pruned. Drafts, run history and the change log are kept.
- A backup of the database and the small ledgers goes to `data\backup\hub-<date>` once a day; the last 14 are kept. Keys are not copied into backups.
- Which repo version each project's details were written from: `data\project-details.json`.
- Notion and GitHub keys: `data\connections.json`; on/off switches: `data\hub-settings.json`. Both are readable only by your Windows user.
- LinkedIn drafts: `drafts\` in your LinkedIn folder (`data\linkedin\drafts` by default).
- LinkedIn app keys and sign-in: `data\linkedin.json`, readable only by your Windows user.
