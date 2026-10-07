/** Bounded in-memory attachments. Never interpret names as filesystem paths. */
export function parseAttachments(input: unknown) {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 4) throw new Error('每条消息最多添加 4 个附件')
  let total = 0
  return input.map(a => {
    if (!a || typeof a.name !== 'string' || a.name.length > 180 || !a.name.trim() || typeof a.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error('附件格式无效')
    const bytes = Buffer.from(a.data, 'base64')
    if (bytes.toString('base64') !== a.data || !bytes.length) throw new Error('附件为空或编码无效')
    total += bytes.length
    if (total > 6 * 1024 * 1024) throw new Error('附件总大小不能超过 6 MB')
    const ext = a.name.split('.').pop()?.toLowerCase()
    let mime = ''
    if (ext === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png'
    if (['jpg','jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg'
    if (ext === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp'
    if (mime) {
      if (bytes.length > 2 * 1024 * 1024) throw new Error('单张图片不能超过 2 MB')
      return { name: a.name as string, size: bytes.length, mime, data: a.data as string, text: '' }
    }
    if (!['txt','md','csv','json','log','yaml','yml','xml','ini','c','h','cpp','py','js','ts'].includes(ext)) throw new Error('支持 PNG/JPEG/WebP 图片及 UTF-8 文本、CSV、JSON、日志、代码文件；暂不支持 PDF/Office')
    if (bytes.length > 20000) throw new Error('单个文本附件不能超过 20 KB，请截取相关内容')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('文本附件必须使用 UTF-8 编码') }
    if (text.includes('\0')) throw new Error('不能读取二进制文件，请上传文本或图片')
    return { name: a.name as string, size: bytes.length, mime: 'text/plain', data: '', text }
  })
}
export function contextSize(messages: any[]) {
  return JSON.stringify(messages, (k, v) => k === 'url' && typeof v === 'string' && v.startsWith('data:image/') ? '[image]' : v).length
}
export function imageBytes(messages: any[]) {
  return messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.reduce((sum: number, c: any) => sum + (c.type === 'image_url' ? c.image_url.url.length : 0), 0) : 0), 0)
}
