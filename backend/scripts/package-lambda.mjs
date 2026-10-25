import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(backendDirectory, '..');
const outputRoot = resolve(backendDirectory, '.aws-sam', 'minimal');
const allowedRoot = resolve(backendDirectory, '.aws-sam');
if (!outputRoot.startsWith(`${allowedRoot}${sep}`) || isAbsolute(relative(allowedRoot, outputRoot)) && relative(allowedRoot, outputRoot).startsWith('..')) {
  throw new Error('Refusing to write the Lambda package outside backend/.aws-sam.');
}

const handlers = [
  ['SearchFunction', 'search'],
  ['ResultsFunction', 'results'],
  ['DatasetFunction', 'dataset'],
  ['CompareFunction', 'compare'],
  ['RefreshFunction', 'refresh'],
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const manifest = [];

for (const [functionName, entryName] of handlers) {
  const packageRoot = join(outputRoot, functionName);
  const handlerDirectory = join(packageRoot, 'dist', 'handlers');
  await mkdir(handlerDirectory, { recursive: true });
  const entryPoint = join(backendDirectory, 'src', 'handlers', `${entryName}.ts`);
  const outfile = join(handlerDirectory, `${entryName}.mjs`);
  const buildResult = await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    packages: 'bundle',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
  });
  const runtimeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const unresolved = Object.values(buildResult.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((item) => item.external && !runtimeBuiltins.has(item.path));
  if (unresolved.length > 0) {
    throw new Error(`${functionName} has unbundled third-party imports: ${unresolved.map((item) => item.path).join(', ')}`);
  }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: `datascout-lambda-${entryName}`,
    version: '0.1.0',
    type: 'module',
  }, null, 2) + '\n');
  if (functionName === 'SearchFunction') {
    const promptSource = join(repositoryDirectory, 'packages', 'ai', 'prompts', 'extract.v1.md');
    const promptTarget = join(packageRoot, 'dist', 'prompts', 'extract.v1.md');
    await mkdir(dirname(promptTarget), { recursive: true });
    await copyFile(promptSource, promptTarget);
  }
  manifest.push({ functionName, entryPoint: `dist/handlers/${entryName}.mjs`, packageRoot, files: [] });
}

async function collectFiles(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await collectFiles(path));
    else if (item.isFile()) result.push(path);
  }
  return result;
}

const allFiles = await collectFiles(outputRoot);
const forbiddenName = /(?:^|[\\/])(?:\.env(?:\.|$)|\.git(?:[\\/]|$)|node_modules(?:[\\/]|$)|(?:^|[\\/])(?:test|tests|docs|evals)(?:[\\/]|$))/iu;
const sensitiveEnvironmentVariables = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'DATAGOVIN_API_KEY',
  'HUGGINGFACE_API_TOKEN',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
];
const runtimeSecretValues = sensitiveEnvironmentVariables
  .map((name) => process.env[name]?.trim())
  .filter((value) => value && value.length >= 6);
for (const file of allFiles) {
  const rel = relative(outputRoot, file).split(sep).join('/');
  if (forbiddenName.test(rel) || !['.mjs', '.json', '.md'].includes(file.slice(file.lastIndexOf('.')))) {
    throw new Error(`Unexpected file in minimal Lambda package: ${rel}`);
  }
  const contents = await readFile(file);
  const source = contents.toString('utf8');
  if (runtimeSecretValues.some((value) => source.includes(value)) || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bhf_[A-Za-z0-9]{20,}\b|\b(?:pk|sk)-lf-[A-Za-z0-9_-]+\b|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|(?:DATAGOVIN_API_KEY|HUGGINGFACE_API_TOKEN|LANGFUSE_(?:PUBLIC|SECRET)_KEY)\s*[:=]\s*["'][^"']+/iu.test(source)) {
    throw new Error(`Credential-like value detected in Lambda package: ${rel}`);
  }
  const owner = manifest.find((item) => rel.startsWith(`${item.functionName}/`));
  owner?.files.push({
    path: rel.slice(owner.functionName.length + 1),
    size: (await stat(file)).size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  });
}

for (const item of manifest) {
  item.files ??= [];
  item.totalBytes = item.files.reduce((sum, file) => sum + file.size, 0);
}
await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), packages: manifest }, null, 2) + '\n');
console.log(`Created ${manifest.length} minimal Lambda packages (${allFiles.length} files), excluding repository dependencies and credentials.`);
