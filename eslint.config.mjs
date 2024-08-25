import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import/extensions
import config from '@doubleaxe/eslint-config/typescript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
    ...config.configs.root,
    ...config.configs.recommended,
    ...config.configs.importSortSimple,
    ...config.configs.typescript.recommended,
];
