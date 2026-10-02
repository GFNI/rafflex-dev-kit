#!/usr/bin/env node
import { main } from '../src/cli.js';

const [major] = process.versions.node.split('.').map(Number);

if (major < 20) {
    process.stderr.write(`@rafflex/dev needs Node 20 or newer (this is ${process.versions.node}).\n`);
    process.exit(2);
}

main(process.argv.slice(2)).then((code) => {
    if (code !== null) {
        process.exitCode = code;
    }
});
