import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LangfuseClient } from '@langfuse/client';

const split = process.argv.includes('--heldout') ? 'held_out' : 'development';
if (split === 'held_out' && !process.argv.includes('--confirm-frozen')) {
  throw new Error('Held-out upload requires --confirm-frozen after the prompt and schema are frozen.');
}
const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
if (!publicKey?.trim() || !secretKey?.trim() || !baseUrl?.trim()) {
  throw new Error('Langfuse credentials and base URL must be configured in the approved secret store.');
}

const root = process.cwd();
const corpusText = await readFile(resolve(root, 'evals/requirements-v0.1.jsonl'), 'utf8');
const corpusHash = createHash('sha256').update(corpusText).digest('hex');
const cases = corpusText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  .filter((item) => item.split === split);
if (cases.some((item) => typeof item.case_id !== 'string' || typeof item.input !== 'string' ||
  typeof item.expected !== 'object' || item.expected === null)) {
  throw new Error('The reviewed corpus contains an invalid evaluation item.');
}
const datasetName = `datascout/requirements-v0.1-${split === 'held_out' ? 'held-out' : 'development'}`;
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ dataset: datasetName, split, items: cases.length, corpus_sha256: corpusHash, upload: false }));
  process.exit(0);
}
const langfuse = new LangfuseClient({
  publicKey: publicKey.trim(), secretKey: secretKey.trim(), baseUrl: baseUrl.trim(), timeout: 10,
});
try {
  try {
    await langfuse.dataset.get(datasetName);
  } catch {
    await langfuse.api.datasets.create({
      name: datasetName,
      description: `Reviewed DataScout requirement-extraction ${split} split. Corpus SHA-256: ${corpusHash}.`,
      metadata: {
        project: 'DataScout', task: 'requirement_extraction', split,
        corpus_sha256: corpusHash, prompt_tuning_allowed: split === 'development',
      },
    });
  }
  for (const item of cases) {
    await langfuse.dataset.createItem({
      datasetName,
      id: `datascout-req-v01-${item.case_id}`,
      input: { text: item.input },
      expectedOutput: item.expected,
      metadata: { case_id: item.case_id, split, corpus_sha256: corpusHash },
    });
  }
  console.log(JSON.stringify({ dataset: datasetName, split, items: cases.length, corpus_sha256: corpusHash }));
} finally {
  await langfuse.shutdown();
}
