import { bindBeforeUnload } from '../../apps/web/src/before-unload.ts'
import { DetachedEditorNotice } from '../../apps/web/src/RetainedDraftNotice.tsx'
import { unloadTarget } from './unload-events.ts'

/** Real guard/notice implementations; only the browser event target is simulated. */
export function groupEditorScope(scope: Record<string, unknown>) {
  return { ...scope, bindBeforeUnload, DetachedEditorNotice, window: scope.window ?? { ...unloadTarget(), confirm: () => false } }
}
