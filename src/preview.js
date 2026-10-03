/**
 * The local preview frame: the template rendered into a document served
 * under the platform's preview CSP (rules.preview_csp), with every
 * platform media source mapped to the product's local assets path so its
 * files load, and nothing else widened. Approved library builds keep
 * their shared marketplace URLs, so the preview runs the same bytes the
 * live site does.
 */

const keywordSource = /^(?:'[^']*'|[a-z][a-z0-9+.-]*:)$/i;

/**
 * Map the published preview CSP onto the local server, directive by
 * directive, so a template that passes one passes the other:
 *
 * - keyword and scheme sources ('self', 'none', data:, blob:) and the
 *   sandbox flags stay as published;
 * - script-src http(s) sources stay as published: the only scripts a
 *   template loads are approved library builds, which the kit resolves
 *   to their shared marketplace URLs (the published libraries path), and
 *   the kit never serves a script from a product's assets folder;
 * - every other http(s) source, whether a bare origin (the uploads
 *   origin in img-src and media-src) or an origin with a path (the
 *   models path in connect-src), is a place the platform serves the
 *   product's own media from, and maps to the product's local assets
 *   path. A path source maps path for path, so it never widens to the
 *   local origin.
 *
 * @param {Record<string, string[]>} previewCsp
 * @param {string} localAssetsPath the product's assets URL, e.g. http://127.0.0.1:5173/p/games/spin-to-win/assets/
 * @returns {Record<string, string[]>}
 */
export function localCspDirectives(previewCsp, localAssetsPath) {
    /** @type {Record<string, string[]>} */
    const directives = {};

    for (const [directive, sources] of Object.entries(previewCsp)) {
        const mapped = sources.map((source) => {
            if (directive === 'sandbox' || keywordSource.test(source) || !/^https?:\/\//i.test(source)) {
                return source;
            }

            if (directive === 'script-src') {
                return source;
            }

            return localAssetsPath;
        });

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
