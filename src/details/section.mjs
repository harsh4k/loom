// The blocks the hub writes into a Notion project page: the "Project details" section at the end
// and, on pages that have no opening text of their own, an intro paragraph at the top.
import { plainText } from '../notion/client.mjs';

export const HEADING = 'Project details';
export const SECTION_TARGET = 'notion-section';

export const rich = (content) => [{ type: 'text', text: { content: String(content).slice(0, 2000) } }];
export const blockText = (block) => plainText(block?.[block.type]?.rich_text);

export const sectionText = ({ description, features }) => ({ description, features: features.map((feature) => `• ${feature}`).join('\n') });

export function sectionBlocks(details) {
  const text = sectionText(details);
  return [
    { object: 'block', type: 'divider', divider: {} },
    { object: 'block', type: 'heading_3', heading_3: { rich_text: rich(HEADING) } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: rich(text.description) } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: rich(text.features) } },
  ];
}

export const introBlock = (text) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(text) } });

// Whether the four blocks still read exactly as the hub wrote `details`.
export function sectionMatches(blocks, details) {
  const expected = sectionText(details);
  return blocks.length === 4 && blocks.every(Boolean) && blocks[0].type === 'divider' && blockText(blocks[1]) === HEADING
    && blockText(blocks[2]) === expected.description && blockText(blocks[3]) === expected.features;
}
