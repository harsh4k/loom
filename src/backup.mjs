// Copies the hub database and the small ledgers into data/backup once a day, keeping the last 14.
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PREFIX = 'hub-';
const DAY_MS = 24 * 60 * 60 * 1000;
const stamp = (date) => date.toISOString().slice(0, 16).replace(/[-:T]/g, '');

async function backups(dir) {
  try { return (await readdir(dir)).filter((name) => name.startsWith(PREFIX) && !name.includes('.')).sort(); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

export async function lastBackupAt(dir) {
  const names = await backups(dir);
  if (!names.length) return null;
  return (await stat(path.join(dir, names.at(-1)))).mtime;
}

// `extraFiles` are copied as-is when they exist; keys (connections.json) are never included.
export async function backupIfDue({ dbPath, dir, extraFiles = [], keep = 14, now = new Date() }) {
  const last = await lastBackupAt(dir);
  if (last && now - last < DAY_MS) return null;
  const target = path.join(dir, `${PREFIX}${stamp(now)}`);
  await mkdir(target, { recursive: true });
  const db = new DatabaseSync(dbPath);
  try { db.exec(`VACUUM INTO '${path.join(target, path.basename(dbPath)).replaceAll("'", "''")}'`); }
  finally { db.close(); }
  for (const file of extraFiles) {
    try { await copyFile(file, path.join(target, path.basename(file))); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const names = await backups(dir);
  for (const old of names.slice(0, Math.max(0, names.length - keep))) {
    await rm(path.join(dir, old), { recursive: true, force: true });
  }
  return target;
}
