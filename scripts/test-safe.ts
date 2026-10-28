import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Explicit allowlist: these tests use pure functions, mock providers or isolated databases.
// Never discover all test-*.ts automatically: some scripts intentionally connect to real devices.
const tests = ['codec', 'physical-value', 'observation', 'history-curve', 'live-curve', 'alarm', 'poller-coherence', 'config-backup', 'curve-sampling', 'assistant', 'assistant-context', 'assistant-streams', 'assistant-providers', 'assistant-history']
const cli = fileURLToPath(import.meta.resolve('tsx/cli'))
const root = fileURLToPath(new URL('../', import.meta.url))
for (const name of tests) {
  console.log(`\n[check] ${name}`)
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, `scripts/test-${name}.ts`], { cwd: root, stdio: 'inherit' })
    child.on('error', reject); child.on('exit', resolve)
  })
  if (code !== 0) { process.exitCode = code ?? 1; break }
}
if (!process.exitCode) console.log(`\nAll ${tests.length} safe test suites passed.`)
