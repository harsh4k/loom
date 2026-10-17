// The automation list. Only `active` entries have a registered job handler; `planned` entries
// are shown as not set up so the hub never implies they are running. `schedule` is wall-clock
// time in the profile's time zone and is run by src/scheduler.mjs; `usesModel` makes the hub start
// Ollama first; `needs` lists the config/profile.json settings the automation can't run without.
import { getProfile } from './profile.mjs';

export const AUTOMATIONS = Object.freeze([
  {
    id: 'linkedin-draft',
    name: 'LinkedIn posts',
    app: 'linkedin',
    status: 'active',
    description: 'Writes a post from your Story Bank with Qwen on Ollama, saves it to your drafts folder and posts it to LinkedIn.',
    schedule: { days: [2, 4], time: '08:00', label: 'Tue and Thu at 8:00 AM' },
    usesModel: true,
    needs: ['linkedin.topics'],
    // The draft alone may take 15 minutes, then the video render and the upload follow.
    timeLimitMs: 30 * 60 * 1000,
  },
  {
    id: 'notion-projects',
    name: 'Notion projects',
    app: 'notion',
    status: 'active',
    description: 'Reads your GitHub repos and adds, updates or archives the matching pages in your Notion Projects database. Your own edits are never overwritten.',
    schedule: { days: [1], time: '09:00', label: 'Mondays at 9:00 AM' },
    needs: ['github.user', 'notion.projectsDatabaseId'],
  },
  {
    id: 'project-details',
    name: 'Project details',
    app: 'github',
    status: 'active',
    description: 'When a repo changes, Qwen reads its README and code notes and writes a short description and features into a Project details section on its Notion page.',
    schedule: { days: [1], time: '09:30', label: 'Mondays at 9:30 AM' },
    usesModel: true,
    needs: ['github.user', 'notion.projectsDatabaseId'],
    // Up to 8 projects, each one a model call of a minute or two.
    timeLimitMs: 45 * 60 * 1000,
  },
  {
    id: 'portfolio-sync',
    name: 'Portfolio sync',
    app: 'portfolio',
    status: 'active',
    description: 'Adds projects you tick “On portfolio” in Notion to your portfolio’s Work section, with a picture of the live site and words in your site’s voice, and removes ones you untick. Entries already on the site are never edited.',
    schedule: { days: [1], time: '10:00', label: 'Mondays at 10:00 AM' },
    usesModel: true,
    needs: ['notion.projectsDatabaseId', 'portfolio.repo', 'portfolio.file', 'portfolio.imagesDir'],
  },
  {
    id: 'weekly-report',
    name: 'Weekly report',
    app: 'notion',
    status: 'active',
    description: 'Writes one Notion page under your report page each Sunday: what ran, what failed, every change the hub made, and READMEs that look out of date.',
    schedule: { days: [0], time: '19:00', label: 'Sundays at 7:00 PM' },
    needs: ['github.user', 'notion.reportPageId'],
  },
  {
    id: 'design-inspo',
    name: 'Design inspiration',
    app: 'linkedin',
    status: 'active',
    description: 'Studies new sites from public web-design galleries with Qwen and adds their palettes, motion ideas and poster ideas to the library Loom’s studio designs post videos from.',
    schedule: { days: [6], time: '11:00', label: 'Saturdays at 11:00 AM' },
    usesModel: true,
    timeLimitMs: 30 * 60 * 1000,
  },
].map((item) => Object.freeze({ ...item })));

// The profile settings an automation still needs, e.g. ['github.user']. Empty when it's ready.
export function missingSetup(automation, profile = getProfile()) {
  return (automation?.needs ?? []).filter((setting) => {
    const value = setting.split('.').reduce((item, key) => item?.[key], profile);
    return Array.isArray(value) ? value.length === 0 : !value;
  });
}
