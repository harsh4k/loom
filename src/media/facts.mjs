import { clean } from './director-common.mjs';
export function readmeText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`>|]+/g, ' ')
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line && !/^[-=:\s]+$/.test(line))
    .join('\n');
}

// A command worth typing on screen: a line from the README's shell blocks that runs the project
// itself (its first word is the project's own name), never an install or setup step.
export function readmeCommand(markdown, names = []) {
  const own = new Set(names.map((name) => String(name).toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((name) => name.length >= 3));
  for (const block of String(markdown ?? '').matchAll(/```(?:bash|sh|shell|console|powershell|ps1|pwsh|zsh|cmd)\s*\n([\s\S]*?)```/gi)) {
    for (const raw of block[1].split('\n')) {
      const line = raw.replace(/^\s*(?:PS [^>]*>|[$>])\s*/, '').trim();
      if (!line || line.length > 48 || /[<>[\]{}|]|your[-_ ]|\.\.\./i.test(line)) continue;
      const first = line.split(/\s+/)[0].toLowerCase().replace(/^\.[\\/]/, '').replace(/\.(exe|ps1|cmd|sh)$/, '');
      if (own.has(first)) return line;
    }
  }
  return '';
}

// Everything a film may say about a project, as text the grounding check reads.
export function projectFacts(project, { draft = '', readme = '' } = {}) {
  const stats = (project.stats ?? []).filter((s) => Array.isArray(s) && s.length >= 2).map(([value, label]) => ({ value: clean(value, 16), label: clean(label, 90) }));
  const stack = (project.stack ?? []).map((item) => clean(item, 30)).filter(Boolean);
  const lines = [
    `Name: ${project.name}`,
    project.eyebrow ? `Kind: ${project.eyebrow}` : '',
    project.hook ? `Hook: ${project.hook}` : '',
    project.tagline ? `What it is: ${project.tagline}` : '',
    ...(project.features ?? []).map((feature) => `Feature: ${clean(feature, 160)}`),
    ...stats.map((s) => `Number: ${s.value} (${s.label})`),
    stack.length ? `Built with: ${stack.join(', ')}` : '',
    project.link ? `Link: ${project.link}` : '',
  ].filter(Boolean);
  const repo = /github\.com\/[^/]+\/([^/]+)/.exec(project.link ?? '')?.[1] ?? '';
  const command = clean(project.command, 48) || readmeCommand(readme, [project.name, project.name.split(/\s+/)[0], repo]);
  if (command) lines.push(`Command: ${command}`);
  const post = clean(draft.replace(/^- [A-Z][a-z]+:.*$/gm, ''), 1500);
  const about = readmeText(readme);
  const records = lines.map((text, index) => ({ id: `project:${index + 1}`, source: 'projects', field: text.split(':')[0].toLowerCase() === 'what it is' ? 'tagline' : text.split(':')[0].toLowerCase(), text }));
  let fenced = false;
  let section = '';
  String(readme).split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    if (/^#{1,6}\s/.test(raw)) { section = raw.replace(/^#+\s*/, ''); return; }
    if (fenced || /roadmap|planned|todo|install|setup|license|contribut/i.test(section)) return;
    const text = readmeText(raw).replace(/^[-*]\s*/, '').trim();
    if (text.length < 20 || /coming soon|\bplanned\b|https?:|^\|/.test(text)) return;
    records.push({ id: `readme:${index + 1}`, source: 'readme', line: index + 1, section, text: text.slice(0, 700) });
  });
  // The exact same bounded evidence reaches the writer and the checker. Generated copy is
  // editorial context only: it can never make its own invented claim become a source fact.
  const selected = records.slice(0, 32);
  const source = selected.map((record) => record.text).join('\n');
  const text = selected.map((record) => `${record.id}: ${record.text}`).join('\n');
  return { name: project.name, stats, stack, command, link: clean(project.link, 60), text, source, records: selected, post };
}

