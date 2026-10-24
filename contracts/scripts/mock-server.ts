import { startMockApiServer } from '../src/mock-api.js';

const portValue = process.env['PORT'] ?? '4010';
const port = Number(portValue);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `PORT must be an integer from 1 to 65535; received ${portValue}.`,
  );
}

await startMockApiServer({
  host: process.env['HOST'] ?? '127.0.0.1',
  port,
});
