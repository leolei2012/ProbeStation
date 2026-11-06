import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Explicit allowlist: these tests use pure functions, mock providers or isolated databases.
// Never discover all test-*.ts automatically: some scripts intentionally connect to real devices.
const tests = ['codec', 'physical-value', 'observation', 'history-curve', 'history-query', 'history-query-task', 'history-read-context', 'history-curve-selection', 'history-navigation', 'history-time-range', 'history-query-memory', 'history-comparison', 'history-export', 'history-columns', 'export-limit', 'export-selection', 'history-integrity', 'live-curve', 'live-point-filter', 'alarm', 'alarm-source', 'alarm-rule-read', 'alarm-history', 'poller-coherence', 'slave-source', 'config-backup', 'config-backup-flow', 'config-read', 'store-batch', 'store-source', 'source-pipeline', 'mcp-source', 'mcp-config-edit', 'register-selection', 'point-diagnostics', 'point-diagnostics-ui', 'importer-groups', 'semantic-import', 'smart-import', 'pointbook-atomic', 'pointbook-result', 'pointbook-fidelity', 'pointbook-identity', 'pointbook-names', 'pointsheet', 'recorder', 'recorder-source', 'recorder-interval', 'recorder-storage', 'recording-attention', 'serial-ports', 'serial-port-timeout', 'register-picker', 'point-label', 'point-settings', 'point-enum-edit', 'point-edit-conflict', 'device-edit-conflict', 'group-edit-conflict', 'curve-sampling', 'alias-edit', 'assistant-config-edit', 'assistant', 'assistant-context', 'assistant-streams', 'assistant-renderer', 'assistant-providers', 'assistant-history']
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
