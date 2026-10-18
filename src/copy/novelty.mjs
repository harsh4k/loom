import { scorePost } from '../eval/copy-score.mjs';

const filler = new Set('a an the and or in on at to of for from with without is are was were be has have had it its this that as by before after alongside runs run needs need'.split(' '));
export function evidenceTerms(text, topic = '') {
  const project = new Set(topic.toLowerCase().match(/[a-z]+/g) ?? []);
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((word) => !filler.has(word) && !project.has(word)));
}
export const hasAnchor = (text, evidence, topic) => {
  const terms = evidenceTerms(evidence, topic);
  return [...evidenceTerms(text, topic)].some((term) => terms.has(term));
};

export function freshness(text, { topic, brand, history = [] }) {
  return scorePost({ post: text, project: topic, facts: text, brand, others: history }).checks;
}

export function sourceSignals(records, context) {
  return records.map((record) => ({ id: record.id, details: record.text.split(/(?<=[.!?])\s+|;\s+/).filter(Boolean).map((detail) => {
    const checks = freshness(detail, context);
    return { detail, eligibleAsAngle: checks.freshOpener.pass && evidenceTerms(detail, context.topic).size >= 2,
      openingSimilarity: checks.freshOpener.detail, appearedInPastBody: !checks.freshBody.pass };
  }) }));
}

export function briefNoveltyErrors(brief, { signals, records, rejectedAngles = [], ...context }) {
  const eligible = signals.filter((item) => brief.factIds.includes(item.id)).flatMap((item) => item.details).filter((item) => item.eligibleAsAngle);
  const errors = [];
  if (!freshness(brief.angle, { ...context, history: [...(context.history ?? []), ...rejectedAngles] }).freshOpener.pass) errors.push('The brief repeats an existing opening/angle.');
  if (!eligible.length) errors.push('Selected sources have no unused substantive opening detail.');
  if (!hasAnchor(brief.angle, records.filter((record) => brief.factIds.includes(record.id)).map((record) => record.text).join('\n'), context.topic)) errors.push('The angle needs a substantive anchor in the selected evidence.');
  if (errors.length) errors.push(`Choose a different eligible detail: ${signals.flatMap((item) => item.details.filter((detail) => detail.eligibleAsAngle).map((detail) => `${item.id}: ${detail.detail}`)).slice(0, 6).join(' | ')}`);
  return errors;
}
