import { bindBeforeUnload } from '../../apps/web/src/before-unload.ts'
import { DetachedEditorNotice } from '../../apps/web/src/RetainedDraftNotice.tsx'
import { unloadTarget } from './unload-events.ts'
import { deviceEditMatches } from '../../packages/core/src/device-settings-edit.ts'

/** Real guard/notice implementations; only the browser event target is simulated. */
export function groupEditorScope(scope: Record<string, unknown>) {
  return { ...scope, deviceEditMatches, bindBeforeUnload, DetachedEditorNotice, window: scope.window ?? { ...unloadTarget(), confirm: () => false } }
}
