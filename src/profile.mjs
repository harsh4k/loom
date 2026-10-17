// Everything about the person using Loom (their GitHub name, Notion pages, portfolio repo,
// LinkedIn folder and time zone) lives in config/profile.json, which is never committed.
// config/profile.example.json shows the shape. LOOM_PROFILE points at another file (tests use it).
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const PROFILE_FILE = path.resolve(import.meta.dirname, '../config/profile.json');
export const EXAMPLE_FILE = path.resolve(import.meta.dirname, '../config/profile.example.json');
const DEFAULT_LINKEDIN_FOLDER = path.resolve(import.meta.dirname, '../data/linkedin');

const text = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);
const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []);

function validTimeZone(value) {
  if (!value) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { return null; }
}

// Fills in defaults, so callers never have to check for missing sections.
export function normalizeProfile(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const github = source.github ?? {};
  const notion = source.notion ?? {};
  const portfolio = source.portfolio ?? {};
  const linkedin = source.linkedin ?? {};
  const design = source.design ?? {};
  return {
    name: text(source.name),
    timeZone: validTimeZone(text(source.timeZone)) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    github: { user: text(github.user) },
    notion: { projectsDatabaseId: text(notion.projectsDatabaseId), reportPageId: text(notion.reportPageId) },
    portfolio: { repo: text(portfolio.repo), file: text(portfolio.file), imagesDir: text(portfolio.imagesDir) },
    linkedin: {
      folder: text(linkedin.folder) || DEFAULT_LINKEDIN_FOLDER,
      topics: list(linkedin.topics),
      audience: text(linkedin.audience) || 'software engineering recruiters',
      avoid: list(linkedin.avoid),
    },
    // The design-taste library Loom's art director draws on; empty means the default skill folder.
    design: { tasteDir: text(design.tasteDir) },
  };
}

export function loadProfile(file = process.env.LOOM_PROFILE || PROFILE_FILE) {
  try {
    return normalizeProfile(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeProfile();
    throw new Error(`${path.basename(file)} isn’t valid JSON: ${error.message}`);
  }
}

let cached = null;
export function getProfile() { return (cached ??= loadProfile()); }
export function resetProfile() { cached = null; }

export const draftsFolder = (profile = getProfile()) => path.join(profile.linkedin.folder, 'drafts');

// Thrown when an automation needs a profile value that hasn't been filled in.
export function need(value, setting) {
  if (value) return value;
  const error = new Error(`Set ${setting} in config/profile.json first (copy config/profile.example.json to start).`);
  error.code = 'ERR_SETUP_NEEDED';
  throw error;
}
