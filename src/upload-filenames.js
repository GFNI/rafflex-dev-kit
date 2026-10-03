/**
 * The marketplace's rule for the name a file is uploaded under
 * (`rules.upload_rules.filename_pattern` and `max_filename_length`), for
 * media library files and listing images alike: the upload refuses any
 * other name.
 */

/**
 * A name the upload takes, as close to `filename` as possible: every run
 * of characters outside the pattern becomes a hyphen, so the derived tag
 * stays the same in the common case of spaces.
 *
 * @param {string} filename
 * @param {RegExp|null} pattern
 * @param {number|null} maxLength
 */
export function suggestedFilename(filename, pattern, maxLength) {
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 ? filename.slice(dot).toLowerCase() : '';
    let stem = (dot > 0 ? filename.slice(0, dot) : filename)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[.-]+|-+$/g, '');

    if (stem === '') {
        stem = 'file';
    }

    if (maxLength !== null && stem.length + extension.length > maxLength) {
        stem = stem.slice(0, Math.max(1, maxLength - extension.length));
    }

    const suggestion = `${stem}${extension}`;

    return pattern === null || pattern.test(suggestion) ? suggestion : `file${extension}`;
}

/**
 * @param {any} uploadRules
 * @returns {RegExp|null}
 */
export function filenamePattern(uploadRules) {
    const published = uploadRules?.filename_pattern;

    if (typeof published?.pattern !== 'string' || published.js_compatible === false) {
        return null;
    }

    try {
        return new RegExp(published.pattern, String(published.flags ?? '').replace('g', ''));
    } catch {
        return null;
    }
}

/**
 * Why the upload refuses a file name, or null when it takes it (or the
 * rules do not publish the rule).
 *
 * @param {string} filename
 * @param {any} uploadRules
 * @returns {{reason: string, suggestion: string}|null}
 */
export function filenameRefusal(filename, uploadRules) {
    const pattern = filenamePattern(uploadRules);
    const maxLength = typeof uploadRules?.max_filename_length === 'number' ? uploadRules.max_filename_length : null;
    const tooLong = maxLength !== null && filename.length > maxLength;
    const refused = pattern !== null && !pattern.test(filename);

    if (!tooLong && !refused) {
        return null;
    }

    const reason = refused
        ? String(uploadRules?.refusals?.invalid_filename ?? 'Use letters, numbers, dots, hyphens, and underscores only in file names.')
        : `File names can be at most ${maxLength} characters.`;

    return { reason, suggestion: suggestedFilename(filename, pattern, maxLength) };
}
