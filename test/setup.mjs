// Every test reads the made-up profile in test/fixtures, never the real config/profile.json.
import path from 'node:path';
process.env.LOOM_PROFILE = path.resolve(import.meta.dirname, 'fixtures/profile.json');
