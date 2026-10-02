import { readFileSync } from 'node:fs';

/** The kit's own version, from its package.json. */
export const kitVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
