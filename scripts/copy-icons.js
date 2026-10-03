/**
 * Maintainer tool: copies the Heroicons the app uses from the heroicons dev
 * dependency into src/client/icons, with its MIT licence. The app works
 * offline under its own CSP, so icons are bundled and inlined into the page
 * by the server, never loaded from a CDN. Add a name to `icons` and rerun
 * after using a new icon in app.html.
 *
 * Usage: node scripts/copy-icons.js
 */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundled icons by app variant: outline is the 24px outline set Flux uses in navigation, micro the 16px solid set it uses in buttons. */
export const icons = {
    outline: ['home', 'cube', 'plus'],
    micro: ['clipboard-document', 'ellipsis-horizontal'],
};

/** Where each app variant lives in the heroicons package. */
export const packageFolders = { outline: '24/outline', micro: '16/solid' };

const packageDirectory = fileURLToPath(new URL('../node_modules/heroicons/', import.meta.url));
const iconsDirectory = fileURLToPath(new URL('../src/client/icons/', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(`Copying ${Object.values(icons).flat().length} Heroicons into src/client/icons`);
    rmSync(iconsDirectory, { recursive: true, force: true });

    for (const [variant, names] of Object.entries(icons)) {
        for (const name of names) {
            const target = `${iconsDirectory}${variant}/${name}.svg`;
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(`${packageDirectory}${packageFolders[variant]}/${name}.svg`, target);
            console.log(`  ${variant}/${name}`);
        }
    }

    copyFileSync(`${packageDirectory}LICENSE`, `${iconsDirectory}LICENSE`);
    console.log('Done. Heroicons licence copied to src/client/icons/LICENSE');
}
