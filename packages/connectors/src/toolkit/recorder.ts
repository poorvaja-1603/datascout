import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { redactUrl } from './redaction.js';

export interface RecordedFixture {
  url: string;
  status: number;
  recordedAt: string;
  data: unknown;
}

export async function recordFixture(
  filePath: string,
  url: string,
  status: number,
  data: unknown,
): Promise<void> {
  const sanitizedUrl = redactUrl(url);
  const fixture: RecordedFixture = {
    url: sanitizedUrl,
    status,
    recordedAt: new Date().toISOString(),
    data,
  };

  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(fixture, null, 2), 'utf8');
}
