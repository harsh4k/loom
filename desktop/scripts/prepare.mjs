// Records where the hub lives, so the installed app can start it if it isn't running.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
writeFileSync(path.join(desktop, 'hub-root.json'), `${JSON.stringify({ root }, null, 2)}\n`);
console.log(`Hub location: ${root}`);
