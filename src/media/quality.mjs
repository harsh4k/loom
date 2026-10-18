import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareStudio } from './studio.mjs';
import { CRITIQUE_PROMPT, CRITIQUE_SCHEMA } from './director.mjs';

export function qualityVerdict({ layout, score, problems = [], reason = '' } = {}) {
  const faults = [...gateProblems(layout), ...problems];
  const knownScore = Number.isInteger(score) && score >= 1 && score <= 10;
  const validLayout = layout && ['lint', 'runtime', 'layout', 'contrast'].every((key) => Array.isArray(layout[key]?.findings));
  if (knownScore && score < 7 && !faults.length) faults.push(`Visual review scored ${score}/10; at least 7 is required.`);
  const status = faults.length ? 'FAIL' : !validLayout || !knownScore || reason ? 'UNVERIFIED' : 'PASS';
  return { status, score: knownScore ? score : null, problems: [...new Set(faults)], ...(reason ? { reason } : {}) };
}

export function inspectionTimes(shots) {
  let t = 0;
  return [...new Set(shots.flatMap((shot) => {
    const d = Math.min(8, Math.max(1, Number(shot.d) || 2.5));
    const moments = [t + Math.min(0.15, d / 5), t + d * 0.5, t + d - 0.25].map((value) => Number(value.toFixed(2)));
    t += d;
    return moments;
  }))];
}

// Two tall sheets exhausted the 8192-token vision context, truncating the JSON response.
// Review full-resolution sheets independently; retain every response and the worst verdict.
export async function reviewSheets({ framesDir, sheets, askJson, prompt, signal, reportDir }) {
  const reviews = [];
  for (const name of sheets) {
    try {
      const image = (await readFile(path.join(framesDir, name))).toString('base64');
      const result = await askJson({ system: 'Review designed output strictly. Return the requested JSON.', prompt, schema: CRITIQUE_SCHEMA, images: [image], temperature: 0.1, signal });
      const valid = Number.isInteger(result?.score) && result.score >= 1 && result.score <= 10 && Array.isArray(result.problems) && result.problems.every(problem => typeof problem === 'string');
      reviews.push({ sheet: name, result, valid });
    } catch (error) { if (signal?.aborted) throw error; reviews.push({ sheet: name, valid: false, error: String(error.message).slice(0, 500) }); }
  }
  await writeFile(path.join(reportDir, 'critique-sheets.json'), JSON.stringify(reviews, null, 2));
  const valid = reviews.filter(review => review.valid);
  const result = valid.length ? { score: Math.min(...valid.map(review => review.result.score)), problems: [...new Set(valid.flatMap(review => review.result.problems))], ...(valid.length !== sheets.length ? { incomplete: true } : {}) } : null;
  await writeFile(path.join(reportDir, 'critique.json'), JSON.stringify(result, null, 2));
  return result;
}

// Persist evidence even on failure. Preview generation and quality approval are separate outcomes.
export function createInspector({ hf, askJson }) {
  return async function inspect({ film, format, images, fonts, workDir, reportDir, signal }) {
    await prepareStudio({ workDir, film, format, images, fonts });
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, 'film.json'), JSON.stringify(film, null, 2));
    const commands = [];
    const run = async (args) => {
      try {
        const result = await hf(args, signal);
        commands.push({ command: args[0], code: result.code, output: result.output?.slice(-2000) });
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        commands.push({ command: args[0], error: String(error.message).slice(0, 500) });
        return null;
      }
    };
    const checked = await run(['check', workDir, '--json', '--samples', String(Math.max(10, film.shots.length * 3))]);
    const checks = path.join(workDir, '.hyperframes', 'artifacts', 'checks');
    let layout = null;
    if (existsSync(checks)) {
      await cp(checks, path.join(reportDir, 'checks'), { recursive: true });
      for (const name of (await readdir(checks)).filter((name) => name.endsWith('.json'))) {
        try {
          const candidate = JSON.parse(await readFile(path.join(checks, name), 'utf8'));
          if (['lint', 'runtime', 'layout', 'contrast'].every((key) => Array.isArray(candidate[key]?.findings))) { layout = candidate; break; }
        } catch { /* An unreadable report is missing evidence. */ }
      }
    }
    const framesDir = path.join(workDir, 'frames');
    const times = inspectionTimes(film.shots);
    const snapped = await run(['snapshot', workDir, '--at', (format === 'poster' ? [times.at(-1)] : times).join(','), '--no-end', '--describe', 'false', '-o', framesDir]);
    if (existsSync(framesDir)) await cp(framesDir, path.join(reportDir, 'frames'), { recursive: true });
    const sheets = existsSync(framesDir) ? (await readdir(framesDir))
      .filter((name) => /^contact-sheet(?:-\d+)?\.jpg$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
    let verdict = null;
    if (snapped?.code === 0 && sheets.length) {
      try {
        const prompt = format === 'poster'
          ? 'Judge this finished static poster as a strict design lead. Assess hierarchy, readable type at phone size, composition, contrast, focal graphic and product evidence. Reject unintended clipping, overlapping text, blank/error screenshots and illegible details. Motion, frame-to-frame change, and a call to action are not required. score: 1 to 10, where 7 means good enough to post. problems: concrete visual defects, each under 15 words; empty when none. Do not judge wording or invent defects.'
          : `${CRITIQUE_PROMPT}\nFrames include entry, middle and settled moments; intentional entry masks are allowed. Also assess hierarchy, product evidence, composition and distinctiveness. Static frames cannot prove smooth motion.`;
        verdict = await reviewSheets({ framesDir, sheets, askJson, prompt, signal, reportDir });
      } catch (error) { if (signal?.aborted) throw error; commands.push({ command: 'visual-review', error: String(error.message).slice(0, 500) }); }
    }
    const missing = [!layout ? 'Layout report missing or invalid' : '', checked?.code !== 0 ? 'Layout command did not exit successfully' : '', !verdict ? 'Visual review unavailable' : verdict.incomplete ? 'Visual review incomplete' : '', snapped?.code !== 0 || !sheets.length ? 'Contact sheet unavailable' : ''].filter(Boolean).join('; ');
    const result = { ...qualityVerdict({ layout, score: verdict?.score, problems: Array.isArray(verdict?.problems) ? verdict.problems : [], reason: missing }), format, reportDir, commands };
    await writeFile(path.join(reportDir, 'quality.json'), JSON.stringify(result, null, 2));
    return result;
  };
}
const LAYOUT_FAULTS = new Set(['clipped_text', 'text_box_overflow', 'content_overlap', 'text_occluded', 'text_not_painted']);

// The findings in a HyperFrames check report that make a film not worth posting.
export function gateProblems(report) {
  if (!report || typeof report !== 'object') return [];
  const problems = [];
  for (const section of ['lint', 'runtime', 'layout', 'contrast']) {
    for (const finding of report[section]?.findings ?? []) {
      const serious = finding.severity === 'error' || (finding.severity === 'warning' && ['layout', 'contrast'].includes(section));
      // Layout findings that mean broken text. Masked words outside their line, a name that
      // bleeds off the frame or a marquee running past the edge are the design, so they pass.
      if (!serious || (section === 'layout' && !LAYOUT_FAULTS.has(finding.code))) continue;
      const at = Number.isFinite(finding.time) ? ` at ${Number(finding.time).toFixed(1)}s` : '';
      problems.push(`${String(finding.message ?? finding.code).slice(0, 120)}${at}`);
    }
  }
  return [...new Set(problems)].slice(0, 6);
}

