import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.argv.includes('--confirm-connectivity-check')) {
  throw new Error('Pass --confirm-connectivity-check to permit one metadata request.');
}

const apiKey = process.env.GEMINI_API_KEY;
const modelId = process.env.GEMINI_MODEL_ID;
if (!apiKey || !modelId) {
  throw new Error('GEMINI_API_KEY and GEMINI_MODEL_ID must be configured.');
}

const startedAt = new Date().toISOString();
let report = {
  report_schema: 'gemini-metadata-connectivity-v1',
  request_type: 'models.get_no_generation',
  provider: 'gemini',
  model_id: modelId,
  started_at: startedAt,
  http_status: null,
  outcome: 'failed',
};

try {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}`,
    {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    },
  );
  report.http_status = response.status;
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    const supported = Array.isArray(body.supportedGenerationMethods)
      ? body.supportedGenerationMethods
      : [];
    report = {
      ...report,
      outcome: 'passed',
      model_name: typeof body.name === 'string' ? body.name : null,
      display_name: typeof body.displayName === 'string' ? body.displayName : null,
      supports_generate_content: supported.includes('generateContent'),
    };
  } else {
    const message = typeof body?.error?.message === 'string' ? body.error.message : '';
    report = {
      ...report,
      safe_error_status: typeof body?.error?.status === 'string' ? body.error.status : null,
      safe_error_code: typeof body?.error?.code === 'number' ? body.error.code : response.status,
      safe_error_message: message
        .replaceAll(apiKey, '[REDACTED]')
        .replace(/[\r\n\t]+/gu, ' ')
        .slice(0, 240),
    };
  }
} catch (error) {
  report = {
    ...report,
    transport_error_type: error instanceof Error ? error.name : 'unknown',
  };
}

report.completed_at = new Date().toISOString();
const directory = resolve('evals/reports');
await mkdir(directory, { recursive: true });
const reportPath = resolve(
  directory,
  `gemini-connectivity-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
if (report.outcome !== 'passed') process.exitCode = 1;
