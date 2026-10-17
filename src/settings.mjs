// Per-automation on/off switches, kept in data/hub-settings.json. A turned-off automation
// is never started by the schedule; Run now still works.
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export function openSettings(file) {
  let disabled = new Set();
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(saved?.disabled)) disabled = new Set(saved.disabled.filter((id) => typeof id === 'string'));
  } catch (error) {
    if (error?.code !== 'ENOENT') disabled = new Set();
  }

  async function save() {
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  return {
    isEnabled: (id) => !disabled.has(id),
    async setEnabled(id, enabled) {
      if (enabled) disabled.delete(id); else disabled.add(id);
      await save();
    },
  };
}
