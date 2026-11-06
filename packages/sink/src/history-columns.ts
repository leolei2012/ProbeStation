import { validSlaveId } from '../../core/src/sample-source.ts'

interface ColumnPoint { id: number; alias?: string | null; slaveId?: number }
const fields = (name: string) => [name, name + '__batch_status', name + '__automatic_eligible']
const fold = (name: string) => name.toLowerCase()

/** Display labels shared by CSV/XLSX; configuration aliases are never changed. */
function displayAlias(text: string): string {
  return [...text.replace(/\r\n?/g, '\n')].map(char => {
    const code = char.codePointAt(0)!
    return code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127 || code === 65534 || code === 65535 || code >= 0xd800 && code <= 0xdfff
      ? '\\u' + code.toString(16).padStart(4, '0') : char
  }).join('')
}

/** Allocate a unique value/status/eligibility triplet, including collisions with timestamp fields. */
export function historyColumnNames(points: readonly ColumnPoint[], reserved: readonly string[]): string[] {
  const bases = points.map(p => p.alias?.trim() ? displayAlias(p.alias) : `reg${p.id}`)
  const counts = new Map<string, number>()
  for (const name of [...reserved, ...bases.flatMap(fields)]) counts.set(fold(name), (counts.get(fold(name)) ?? 0) + 1)
  const ambiguous = bases.map(base => fields(base).some(name => counts.get(fold(name))! > 1))
  const used = new Set(reserved.map(fold)), result: string[] = []
  const keep = (index: number, name: string) => { result[index] = name; fields(name).forEach(value => used.add(fold(value))) }
  // Preserve ordinary unique aliases before allocating generated qualifiers that could resemble them.
  bases.forEach((base, i) => { if (!ambiguous[i]) keep(i, base) })
  bases.forEach((base, i) => {
    if (!ambiguous[i]) return
    const p = points[i], label = `${base} [slave=${validSlaveId(p.slaveId) ? p.slaveId : 'unknown'} id=${p.id}]`
    let candidate = label, suffix = 1
    while (fields(candidate).some(name => used.has(fold(name)))) candidate = label + ' (' + ++suffix + ')'
    keep(i, candidate)
  })
  return result
}
