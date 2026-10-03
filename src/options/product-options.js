import { existsSync, readFileSync } from 'node:fs';

/**
 * A product's options.json: its content, or why it cannot be read. A
 * missing file holds no overrides.
 *
 * @param {{optionsPath: string}} product
 * @returns {{overrides: unknown, error: string|null}}
 */
export function readOptionOverrides(product) {
    if (!existsSync(product.optionsPath)) {
        return { overrides: null, error: null };
    }

    try {
        return { overrides: JSON.parse(readFileSync(product.optionsPath, 'utf8')), error: null };
    } catch (error) {
        return { overrides: null, error: `options.json is not valid JSON: ${/** @type {Error} */ (error).message}` };
    }
}
