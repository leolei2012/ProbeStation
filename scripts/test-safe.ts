import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Explicit allowlist: these tests use pure functions, mock providers or isolated databases.
// Never discover all test-*.ts automatically: some scripts intentionally connect to real devices.
const tests = ['codec', 'register-write-value', 'ui-preferences', 'settings-loading', 'global-retention', 'device-issues-read', 'runtime-logs', 'communication-summary', 'raw-frames-read', 'diagnostics-cleanup', 'runtime-log-null', 'log-cleanup', 'physical-value', 'observation', 'realtime-fallback', 'history-curve', 'history-query', 'history-query-task', 'history-read-context', 'history-curve-selection', 'history-navigation', 'history-time-range', 'history-query-memory', 'history-comparison', 'history-export', 'history-export-context', 'history-columns', 'export-limit', 'export-selection', 'history-integrity', 'live-curve', 'live-snapshot', 'live-point-filter', 'alarm', 'alarm-source', 'alarm-rule-read', 'alarm-edit-conflict', 'alarm-context', 'alarm-history', 'poller-coherence', 'poller-origin', 'slave-source', 'config-backup', 'export-config-snapshot', 'config-backup-flow', 'config-read', 'config-read-timeout', 'store-batch', 'store-source', 'export-read-handle', 'workspace-export-pair', 'persistence-status', 'readiness', 'api-lifecycle', 'store-lifecycle', 'runtime-close', 'signal-exit-audit', 'retention-display', 'source-pipeline', 'mcp-source', 'mcp-config-edit', 'register-selection', 'point-diagnostics', 'point-diagnostics-ui', 'importer-groups', 'semantic-import', 'smart-import', 'pointbook-atomic', 'pointbook-result', 'pointbook-fidelity', 'pointbook-identity', 'pointbook-names', 'pointsheet', 'recorder', 'recorder-source', 'recorder-device-source', 'recorder-interval', 'recorder-storage', 'recording-page', 'recording-attention', 'serial-ports', 'serial-port-timeout', 'register-picker', 'point-label', 'point-settings', 'point-draft-close', 'device-draft-close', 'point-enum-edit', 'point-edit-conflict', 'device-edit-conflict', 'group-edit-conflict', 'group-create-active', 'group-create-atomic', 'activation-settings', 'activation-compat', 'curve-sampling', 'alias-edit', 'assistant-config-edit', 'assistant', 'assistant-context', 'assistant-streams', 'assistant-renderer', 'assistant-attachment-read', 'assistant-providers', 'assistant-history']
tests.push('database-upgrade', 'backup-retention', 'retention-triggers', 'history-page-snapshot', 'history-pagination', 'history-feedback', 'history-capacity', 'device-connection-view', 'live-curve-context', 'source-transition', 'diagnostics-loading', 'draft-navigation', 'retained-drafts', 'device-removal-drafts', 'before-unload', 'draft-composition', 'draft-accessibility', 'communication-loading', 'alarm-log-failure', 'api-types', 'mcp-types')
tests.push('mcp-lifecycle')
tests.push('mcp-disconnect')
tests.push('mcp-write-outcome')
const cli = fileURLToPath(import.meta.resolve('tsx/cli'))
const root = fileURLToPath(new URL('../', import.meta.url))
for (const name of tests) {
  console.log(`\n[check] ${name}`)
  const code = await new Promise<number | null>((resolve, reject) => {
    // Full settings SSR includes existing browser components that rely on automatic JSX.
    // Use the actual web build configuration for this suite; retain all older suites' configuration.
    const args = name === 'settings-loading' ? [cli, '--tsconfig', 'tsconfig.web.json', `scripts/test-${name}.ts`] : [cli, `scripts/test-${name}.ts`]
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' })
    child.on('error', reject); child.on('exit', resolve)
  })
  if (code !== 0) { process.exitCode = code ?? 1; break }
}
if (!process.exitCode) console.log(`\nAll ${tests.length} safe test suites passed.`)
