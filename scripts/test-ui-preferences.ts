import assert from 'node:assert/strict'
import { bindUiTheme, readUiLanguage, readUiTheme, readSidebarCollapsed, saveUiTheme, saveUiLanguage, saveSidebarCollapsed, type PreferenceStorage } from '../apps/web/src/ui-preferences.ts'

// All access is injected in-memory storage or a synthetic Node getter; no real browser preferences.
const data = new Map<string, string>(), writes: Array<[string, string]> = [], reads: string[] = []
const storage: PreferenceStorage = () => ({ getItem: key => { reads.push(key); return data.get(key) ?? null }, setItem: (key, value) => { writes.push([key, value]); data.set(key, value) } })
assert.equal(readUiTheme(storage), 'system'); assert.equal(readUiLanguage(storage), 'zh'); assert.equal(readSidebarCollapsed(1200, storage), false)
for (const theme of ['light', 'dark', 'system']) { data.set('ps-theme', theme); assert.equal(readUiTheme(storage), theme) }
for (const language of ['zh', 'en']) { data.set('ps-lang', language); assert.equal(readUiLanguage(storage), language) }
for (const corrupt of ['', 'fr', 'undefined', 'null', '__proto__', 'constructor', 'EN', ' dark ', '{bad json}']) {
  data.set('ps-theme', corrupt); data.set('ps-lang', corrupt); assert.equal(readUiTheme(storage), 'system'); assert.equal(readUiLanguage(storage), 'zh')
}
assert.equal(writes.length, 0, 'reading invalid values must not mutate storage')
data.set('ps-collapsed', '1'); assert.equal(readSidebarCollapsed(769, storage), true)
data.set('ps-collapsed', '0'); assert.equal(readSidebarCollapsed(769, storage), false); assert.equal(readSidebarCollapsed(768, storage), true)
data.set('ps-collapsed', 'broken'); assert.equal(readSidebarCollapsed(1200, storage), false)
for (const denied of [() => { throw new DOMException('synthetic property denied', 'SecurityError') }, () => ({ getItem() { throw new Error('synthetic read denied') }, setItem() { throw new DOMException('synthetic quota', 'QuotaExceededError') } })] as PreferenceStorage[]) {
  assert.equal(readUiTheme(denied), 'system'); assert.equal(readUiLanguage(denied), 'zh'); assert.equal(readSidebarCollapsed(1200, denied), false); assert.equal(readSidebarCollapsed(360, denied), true)
  assert.equal(saveUiTheme('dark', denied), false); assert.equal(saveUiLanguage('en', denied), false); assert.equal(saveSidebarCollapsed(true, denied), false)
  const listeners = new Set<() => void>(), applied: string[] = []
  const media = { matches: true, addEventListener: (_type: string, fn: () => void) => listeners.add(fn), removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn) }
  const cleanup = bindUiTheme('system', media as any, theme => applied.push(theme), denied)
  assert.deepEqual(applied, ['dark']); assert.equal(listeners.size, 1, 'failed persistence cannot prevent theme listener installation')
  media.matches = false; listeners.forEach(fn => fn()); assert.deepEqual(applied, ['dark', 'light'])
  cleanup(); assert.equal(listeners.size, 0, 'theme listeners are still removable after write failure')
}
data.set('unrelated-setting', 'keep'); saveUiTheme('dark', storage); saveUiLanguage('en', storage); saveSidebarCollapsed(false, storage)
assert.deepEqual(writes, [['ps-theme', 'dark'], ['ps-lang', 'en'], ['ps-collapsed', '0']]); assert.equal(data.get('unrelated-setting'), 'keep')
assert.equal(readUiTheme(storage), 'dark'); assert.equal(readUiLanguage(storage), 'en'); assert.equal(readSidebarCollapsed(1000, storage), false)
const readonlyStorage: PreferenceStorage = () => ({ getItem: key => data.get(key) ?? null, setItem() { throw new DOMException('synthetic full quota', 'QuotaExceededError') } })
assert.equal(readUiTheme(readonlyStorage), 'dark'); assert.equal(readUiLanguage(readonlyStorage), 'en'); assert.equal(saveUiLanguage('zh', readonlyStorage), false); assert.equal(data.get('ps-lang'), 'en', 'readable preferences survive write denial')
let available = false
const recoverable: PreferenceStorage = () => { if (!available) throw new Error('temporarily blocked'); return storage() }
assert.equal(readUiLanguage(recoverable), 'zh'); assert.equal(saveUiTheme('light', recoverable), false)
available = true; assert.equal(readUiLanguage(recoverable), 'en'); assert.equal(saveUiTheme('light', recoverable), true); assert.equal(readUiTheme(recoverable), 'light')
const missing = (() => undefined) as unknown as PreferenceStorage
assert.equal(readUiTheme(missing), 'system'); assert.equal(saveUiLanguage('en', missing), false)
assert(reads.every(key => ['ps-theme', 'ps-lang', 'ps-collapsed'].includes(key)))
for (const choice of ['light', 'dark'] as const) {
  const listeners = new Set<() => void>(), applied: string[] = []
  const media = { matches: choice === 'light', addEventListener: (_type: string, fn: () => void) => listeners.add(fn), removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn) }
  const cleanup = bindUiTheme(choice, media as any, value => applied.push(value), storage); media.matches = !media.matches; listeners.forEach(fn => fn())
  assert.deepEqual(applied, [choice, choice], 'explicit theme remains independent of system changes'); cleanup(); assert.equal(listeners.size, 0)
}
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
try {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('synthetic global access blocked', 'SecurityError') } })
  assert.equal(readUiTheme(), 'system'); assert.equal(readUiLanguage(), 'zh'); assert.equal(readSidebarCollapsed(1200), false)
  assert.equal(saveUiTheme('light'), false); assert.equal(saveUiLanguage('zh'), false); assert.equal(saveSidebarCollapsed(false), false)
} finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage') }
console.log('UI PREFERENCES OK: valid/default/corrupt enums, property/method/quota failures, mobile threshold, theme application and listener cleanup despite persistence failure, explicit/system modes, exact own-key writes and recovery; mock storage only, no actual browser storage, API, model, files, database, device or DOM automation')
