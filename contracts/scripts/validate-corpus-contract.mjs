import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractedRequirementsSchema } from '../src/schemas.ts';

const corpusPath = resolve(
  import.meta.dirname,
  '../../evals/requirements-v0.1.jsonl',
);
const lines = (await readFile(corpusPath, 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean);
const errors = [];

for (const [index, line] of lines.entries()) {
  let item;
  try {
    item = JSON.parse(line);
  } catch (error) {
    errors.push(`line ${index + 1}: invalid JSON (${error.message})`);
    continue;
  }

  const parsed = ExtractedRequirementsSchema.safeParse(item.expected);
  if (!parsed.success) {
    errors.push(`line ${index + 1} (${item.case_id}): ${parsed.error.message}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS: contract v1 validates all ${lines.length} evaluation cases.`,
  );
}
