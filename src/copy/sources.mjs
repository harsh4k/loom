// Line provenance stays attached to facts; permissions and editorial notes are never evidence.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, project) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(project)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
export const nameList = (list) => Array.isArray(list) ? list.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()) : [];
const editorial = /free to name|ask first|never name|off limits|confidential|not yet recorded|thin:|\bNOT\b/;

export function selectFacts(storyBank, project, { avoid = [] } = {}) {
  if (!project?.trim()) return [];
  avoid = nameList(avoid);
  let section = '';
  const facts = [];
  storyBank.split(/\r?\n/).forEach((raw, index) => {
    if (/^#{1,3}\s/.test(raw)) { section = raw.replace(/^#+\s*/, ''); return; }
    if (section && !/^(?:\d+\.\s*)?(?:Receipts|Shipped|Timeline)\b/i.test(section)) return;
    if (!/^\s*-\s+/.test(raw)) return;
    const line = raw.replace(/^\s*-\s+/, '')
      .replace(/\([^)]*(?:resume says|corrected|never claim)[^)]*\)/gi, '').trim();
    // Split only a new entity label after sentence punctuation, never ordinary prose.
    const clauses = line.split(/(?<=[.!?])\s+(?=[\p{L}][\p{L}\p{N} _-]{0,45}(?:\s*\([^)]*\))?:)/u);
    clauses.forEach((text, clause) => {
      if (!mentions(text, project) || editorial.test(text)) return;
      if (avoid.some((name) => mentions(text, name))) return;
      const repo = /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.exec(text)?.[0];
      facts.push({ id: `story:${index + 1}:${clause + 1}`, text, source: 'story-bank', line: index + 1, section, ...(repo ? { repo } : {}) });
    });
  });
  return facts;
}

export const factText = (facts) => facts.map((fact) => fact.text).join('\n');
export const withoutLinks = (text) => text.replace(/\(?\b(?:https?:\/\/|www\.|github\.com\/)\S+/gi, '')
  .replace(/\(\s*\)|[ \t]+(?=[.,;:!?])/g, '').replace(/[ \t]{2,}/g, ' ').trim();

// Source snapshots are supplied by the caller; generation never fetches or edits a project.
// Presentation hooks are not facts. Only descriptive fields and README prose are eligible.
export function collectSources({ storyBank, topic, avoid = [], project = null, readme = '' }) {
  avoid = nameList(avoid);
  const records = selectFacts(storyBank, topic, { avoid });
  const add = (text, source, field, line) => {
    if (!text || avoid.some((name) => mentions(text, name))) return;
    records.push({ id: `${source}:${field}`, text: withoutLinks(text), source, field, ...(line ? { line } : {}) });
  };
  if (project) {
    if (project.tagline) add(`${topic}: ${project.tagline}`, 'project', 'tagline');
    if (project.stack?.length) add(`${topic} stack: ${project.stack.join(', ')}.`, 'project', 'stack');
    // Unreviewed marketing statistics are intentionally not promoted over Story Bank receipts.
  }
  let fence = false;
  let section = '';
  readme.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*```/.test(raw)) { fence = !fence; return; }
    if (/^#{1,6}\s/.test(raw)) { section = raw.replace(/^#+\s*/, ''); return; }
    if (fence || /install|setup|roadmap|planned|todo|license|contribut|acknowledg|usage|quick.?start/i.test(section)) return;
    const text = raw.replace(/^\s*[-*]\s+/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`_]/g, '').trim();
    if (text.length < 35 || /^[|<>$]/.test(text) || /https?:\/\/|\b(?:npm|pip|git clone)\b|\b(?:will|coming soon|planned)\b/i.test(text)) return;
    if (records.filter((item) => item.source === 'readme').length < 10) add(`${topic}: ${text.slice(0, 700)}`, 'readme', `line-${index + 1}`, index + 1);
  });
  return records;
}
