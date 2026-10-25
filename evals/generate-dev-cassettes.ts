import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { toJsonSchemas } from '@datascout/contracts';
import { getCassetteKey } from '../packages/ai/src/client.js';
import {
  EXTRACTION_MAX_OUTPUT_TOKENS,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_TIMEOUT_MS,
} from '../packages/ai/src/extraction.js';

const corpusPath = fileURLToPath(new URL('./requirements-v0.1.jsonl', import.meta.url));
const corpusText = await readFile(corpusPath, 'utf8');
const prompt = await readFile(new URL('../packages/ai/prompts/extract.v1.md', import.meta.url), 'utf8');
const cases = corpusText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
  case_id: string;
  split: string;
  input: string;
  expected: Record<string, unknown>;
}).filter((item) => item.split === 'development');
if (!process.argv.includes('--write')) {
  console.log(`Prepared ${cases.length} development-only gold cassettes for ${EXTRACTION_PROMPT_VERSION}. Add --write to create fixtures.`);
  process.exit(0);
}

const outputDirectory = resolve(fileURLToPath(new URL('../packages/ai/test/fixtures/corpus-cassettes-v3/', import.meta.url)));
await mkdir(outputDirectory, { recursive: true });
for (const filename of await readdir(outputDirectory)) {
  if (/^[a-f0-9]{64}\.json$/u.test(filename)) {
    await unlink(resolve(outputDirectory, filename));
  }
}
for (const item of cases) {
  const request = {
    task: 'extract' as const,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    system: prompt,
    user: item.input,
    jsonSchema: toJsonSchemas().ExtractedRequirements as object,
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  };
  const key = getCassetteKey(request);
  await writeFile(resolve(outputDirectory, `${key}.json`), `${JSON.stringify({
    output: item.expected,
    modelId: 'development-gold-fixture-v0.1',
    usage: { inputTokens: 0, outputTokens: 0 },
  }, null, 2)}\n`, 'utf8');
}
console.log(`Wrote ${cases.length} fixtures; source corpus SHA-256 ${createHash('sha256').update(corpusText).digest('hex')}. These are gold-derived replay fixtures, not model predictions.`);
