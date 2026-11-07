export type UiTheme = 'system' | 'light' | 'dark'
export type UiLanguage = 'zh' | 'en'
export type PreferenceStorage = () => Pick<Storage, 'getItem' | 'setItem'>
const browserStorage: PreferenceStorage = () => globalThis.localStorage
function read(key: string, storage: PreferenceStorage): string | null { try { return storage().getItem(key) } catch { return null } }
function write(key: string, value: string, storage: PreferenceStorage): boolean { try { storage().setItem(key, value); return true } catch { return false } }

/** Reading never rewrites or clears storage. Unknown values use the existing defaults. */
export function readUiTheme(storage: PreferenceStorage = browserStorage): UiTheme {
  const value = read('ps-theme', storage)
  return value === 'light' || value === 'dark' ? value : 'system'
}
export function readUiLanguage(storage: PreferenceStorage = browserStorage): UiLanguage {
  return read('ps-lang', storage) === 'en' ? 'en' : 'zh'
}
export function readSidebarCollapsed(width: number, storage: PreferenceStorage = browserStorage): boolean {
  return width <= 768 || read('ps-collapsed', storage) === '1'
}
export const saveUiTheme = (value: UiTheme, storage: PreferenceStorage = browserStorage) => write('ps-theme', value, storage)
export const saveUiLanguage = (value: UiLanguage, storage: PreferenceStorage = browserStorage) => write('ps-lang', value, storage)
export const saveSidebarCollapsed = (value: boolean, storage: PreferenceStorage = browserStorage) => write('ps-collapsed', value ? '1' : '0', storage)

/** Persistence failure cannot interrupt applying the theme or installing/removing its listener. */
export function bindUiTheme(theme: UiTheme, media: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>, apply: (theme: 'light' | 'dark') => void, storage: PreferenceStorage = browserStorage) {
  const update = () => apply(theme === 'system' ? media.matches ? 'dark' : 'light' : theme)
  update(); saveUiTheme(theme, storage)
  media.addEventListener('change', update)
  return () => media.removeEventListener('change', update)
}
