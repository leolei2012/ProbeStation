const reserved = ['设备信息', '告警规则', 'History']
const invalidCharacters = /[\\/:*?\[\]\u0000-\u001f\u007f]/g

function shorten(text: string, length: number): string {
  let out = text.slice(0, length)
  // ExcelJS limits UTF-16 length; never cut an emoji's surrogate pair in half.
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1)
  return out.trim().replace(/^'+|'+$/g, '_')
}

/** Workbook-local display names only. Original group names are stored separately in B1. */
export function createSheetNameAllocator(): (name: string) => string {
  const used = new Set(reserved.map(name => name.toLowerCase()))
  return name => {
    let base = name.trim().replace(invalidCharacters, '_').replace(/^'+|'+$/g, '_') || 'sheet'
    if (reserved.some(name => name.toLowerCase() === base.toLowerCase())) base = '分组_' + base
    let candidate = shorten(base, 31), index = 1
    while (used.has(candidate.toLowerCase())) {
      const suffix = '_' + ++index
      candidate = shorten(base, 31 - suffix.length) + suffix
    }
    used.add(candidate.toLowerCase())
    return candidate
  }
}

/** ExcelJS strips control characters from cells. Refuse unrepresentable identities instead of losing them. */
export function assertExportableGroupName(name: string): void {
  if (typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f\ufffe\uffff]/.test(name) ||
    [...name].some(c => { const value = c.codePointAt(0)!; return value >= 0xd800 && value <= 0xdfff })) {
    throw new Error('分组名为空或含XLSX不能保真表示的字符；未生成点表，请核对组名或使用JSON配置备份。')
  }
}
