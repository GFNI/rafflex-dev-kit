/**
 * The local preview frame: the template rendered into a document served
 * under the platform's preview CSP (rules.preview_csp), with the
 * marketplace's uploads origin mapped to the local server so the
 * project's assets load, and nothing else widened. Approved library
 * builds keep their shared URLs in script-src, so the preview runs the
 * same bytes the live site does.
 */

const keywordSource = /^(?:'[^']*'|[a-z][a-z0-9+.-]*:)$/i;

/**
 * Map the published preview CSP onto the local server: every http(s)
 * source becomes the local origin, except script-src sources that are a
 * prefix of an approved library URL (the shared libraries path), which
 * stay as published. Each approved library URL is listed in script-src
 * as well, so a build loads even where the published policy has no
 * libraries path.
 *
 * @param {Record<string, string[]>} previewCsp
 * @param {string} localOrigin e.g. http://127.0.0.1:5173
 * @param {string[]} libraryUrls
 * @returns {Record<string, string[]>}
 */
export function localCspDirectives(previewCsp, localOrigin, libraryUrls) {
    /** @type {Record<string, string[]>} */
    const directives = {};

    for (const [directive, sources] of Object.entries(previewCsp)) {
        /** @type {string[]} */
        const mapped = [];

        for (const source of sources) {
            if (directive === 'sandbox' || keywordSource.test(source) || !/^https?:\/\//i.test(source)) {
                mapped.push(source);
                continue;
            }

            if (directive === 'script-src' && libraryUrls.some((url) => url.startsWith(source))) {
                mapped.push(source);
                continue;
            }

            mapped.push(localOrigin);
        }

        if (directive === 'script-src') {
            mapped.push(localOrigin, ...libraryUrls);
        }

        directives[directive] = [...new Set(mapped)];
    }

    return directives;
}

/**
 * @param {Record<string, string[]>} directives
 */
export function cspHeader(directives) {
    return Object.entries(directives)
        .map(([directive, sources]) => [directive, ...sources].join(' '))
        .join('; ');
}

/**
 * @param {string} text
 */
export function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Whether a CSS hex colour is dark, for the frame's colour scheme.
 *
 * @param {unknown} colour
 */
function isDark(colour) {
    const match = typeof colour === 'string' ? colour.match(/^#([0-9a-f]{6})$/i) : null;

    if (match === null) {
        return true;
    }

    const value = Number.parseInt(match[1], 16);
    const luminance = (0.2126 * (value >> 16) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;

    return luminance < 0.5;
}

/**
 * Reports what happens inside the opaque origin frame to the kit's page,
 * as the platform's preview script does for the studio: CSP violations
 * and uncaught script errors.
 */
const frameReporter = `
document.addEventListener('securitypolicyviolation', function (event) {
    window.parent.postMessage({
        type: 'rafflex-dev-violation',
        blockedUri: String(event.blockedURI || ''),
        directive: String(event.effectiveDirective || event.violatedDirective || ''),
        line: event.lineNumber || null
    }, '*');
});
window.addEventListener('error', function (event) {
    window.parent.postMessage({
        type: 'rafflex-dev-script-error',
        message: String(event.message || 'Script error'),
        line: event.lineno || null
    }, '*');
});
`;

/**
 * The frame's stylesheet. With the published theme (contexts.theme) it is
 * the platform frame's: the sample tenant's CSS variables on :root and a
 * gray 950 body. Contexts cached before the theme was published fall back
 * to the sample `settings.background`.
 *
 * @param {{css?: unknown, html_class?: unknown}|undefined} theme
 * @param {unknown} background
 * @returns {{htmlClass: string, css: string}}
 */
export function frameStyles(theme, background) {
    if (typeof theme?.css === 'string') {
        return {
            htmlClass: typeof theme.html_class === 'string' ? theme.html_class : '',
            css: `${theme.css.replace(/<\//g, '<\\/')} :root.dark { color-scheme: dark; } body { background: var(--gray-color-950); font-family: ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'; -webkit-font-smoothing: antialiased; }`,
        };
    }

    return {
        htmlClass: isDark(background) ? 'dark' : '',
        css: `:root.dark { color-scheme: dark; } body { background: ${typeof background === 'string' && /^#[0-9a-f]{3,8}$/i.test(background) ? background : '#030712'}; font-family: ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }`,
    };
}

/**
 * The frame document around the rendered template, or around the render
 * error the way the platform's frame shows one.
 *
 * @param {{html: string|null, error: string|null, background?: unknown, theme?: {css?: unknown, html_class?: unknown}}} content
 */
export function frameDocument({ html, error, background, theme }) {
    const styles = frameStyles(theme, background);
    const body = error !== null
        ? `<div style="margin: 16px; padding: 12px 16px; border: 1px solid #ef4444; border-radius: 6px; background: #fef2f2; color: #b91c1c; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;"><strong>Preview error:</strong> ${escapeHtml(error)}</div>`
        : html;

    return `<!DOCTYPE html>
<html lang="en"${styles.htmlClass === '' ? '' : ` class="${escapeHtml(styles.htmlClass)}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Preview</title>
<style>${styles.css}</style>
<script>${frameReporter}</script>
<script defer src="/__rafflex/alpine.js"></script>
</head>
<body>
${body}
</body>
</html>
`;
}
