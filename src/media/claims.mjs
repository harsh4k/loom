// Conservative language guard, not semantic entailment. Field/line provenance stays reviewable.
const plain = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const strong = /\b(?:guarantees?|proves?|always|never|unlimited|eliminates?|perfect|completely|total privacy|zero risk|all data|every user|offline|no internet|nothing leaves|data stays|data never leaves|without external dependencies|no external dependencies|zero dependencies|dependency.free)\b/i;
export function unsupportedClaim(text, source) {
  if (!strong.test(text)) return '';
  const claim = plain(text);
  // Strong categorical promises must be quoted from a source, not inferred from a stack name.
  return plain(source).includes(claim) ? '' : 'a categorical promise needs explicit source wording';
}

export function evidenceMap(shots, records) {
  const stop = new Set('the a an to of in on and or is it its your with for by from as at'.split(' '));
  return shots.map((shot, index) => {
    const texts = [shot.text, shot.line, shot.caption, shot.label, ...(shot.items ?? [])].filter(Boolean);
    return { shot: index + 1, claims: texts.map((text) => {
      const words = [...new Set(plain(text).split(' ').filter((word) => !stop.has(word)))];
      const sourceIds = records.filter((record) => words.length && words.every((word) => plain(record.text).split(' ').includes(word))).map((record) => record.id);
      return { text, sourceIds, status: sourceIds.length ? 'TRACEABLE' : 'REVIEW_REQUIRED' };
    }) };
  });
}
