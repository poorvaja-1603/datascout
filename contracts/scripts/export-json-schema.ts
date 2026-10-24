import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import prettier from 'prettier';
import { toJsonSchemas } from '../src/json-schema.js';

const outputDirectory = resolve(import.meta.dirname, '../json-schema');
const schemas = toJsonSchemas();

await mkdir(outputDirectory, { recursive: true });

await Promise.all(
  Object.entries(schemas).map(async ([name, schema]) => {
    const filePath = resolve(outputDirectory, `${name}.schema.json`);
    const formatted = await prettier.format(JSON.stringify(schema), {
      parser: 'json',
      filepath: filePath,
    });

    await writeFile(filePath, formatted, 'utf8');
  }),
);

console.log(`Exported ${Object.keys(schemas).length} JSON Schemas.`);
