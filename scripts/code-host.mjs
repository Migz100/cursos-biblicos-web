import { configureHostIsolation, runCodeHost } from './code-host-runtime.mjs';

if (process.argv.includes('--setup-isolation')) {
  const result = await configureHostIsolation();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  await runCodeHost({ selfTest: process.argv.includes('--self-test') });
}
