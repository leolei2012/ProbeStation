export interface AttachmentFile { readonly name: string; readonly type: string; readonly size: number }
export interface LocalAttachment { name: string; size: number; data: string }

export function prepareAttachmentFiles<F extends AttachmentFile>(files: readonly F[]) {
  return files.map(file => {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[file.type]
    const name = ext && !/\.(png|jpe?g|webp)$/i.test(file.name) ? `${file.name || '粘贴图片'}.${ext}` : file.name
    if (!/\.(png|jpe?g|webp|txt|md|csv|json|log|yaml|yml|xml|ini|c|h|cpp|py|js|ts)$/i.test(name)) throw new Error(`${name}：暂不支持此附件格式`)
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${file.name}：不能读取空文件或无效大小`)
    return { file, name, size: file.size }
  })
}

/** Browser-local bytes only. Importing/constructing the model does not read any file or send data. */
export function readAttachmentBase64(file: Blob, signal: AbortSignal, factory: () => FileReader = () => new FileReader()): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const reader = factory(); let settled = false
    const finish = (value?: string, error?: Error) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', cancel)
      reader.onload = reader.onerror = reader.onabort = null
      if (error) reject(error); else resolve(value!)
    }
    const cancel = () => { finish(undefined, new DOMException('附件读取已取消', 'AbortError')); try { reader.abort() } catch { /* Waiting is already cancelled. */ } }
    reader.onload = () => {
      const match = typeof reader.result === 'string' ? /^data:[^,]*;base64,([A-Za-z0-9+/]+={0,2})$/.exec(reader.result) : null
      if (!match || match[1].length % 4 !== 0) finish(undefined, new Error('附件读取结果无效'))
      else finish(match[1])
    }
    reader.onerror = () => finish(undefined, new Error('读取附件失败'))
    reader.onabort = () => finish(undefined, new Error('附件读取已中止'))
    signal.addEventListener('abort', cancel, { once: true })
    try { reader.readAsDataURL(file) } catch { finish(undefined, new Error('读取附件失败')) }
  })
}

/** Atomic local batch. A cancelled/obsolete batch can never append to the existing attachment draft. */
export class AttachmentBatchRead<F extends AttachmentFile> {
  private active?: { controller: AbortController }
  get reading() { return this.active !== undefined }
  constructor(private readonly options: { read: (file: F, signal: AbortSignal) => Promise<string>; accepted: (files: LocalAttachment[]) => void; failed: (error: unknown) => void; busy: (value: boolean) => void }) {}
  cancel(notify = true) {
    const old = this.active
    if (!old) return false
    this.active = undefined; old.controller.abort()
    if (notify) this.options.busy(false)
    return true
  }
  async start(files: readonly F[]) {
    if (!files.length || this.active) return
    const operation = this.active = { controller: new AbortController() }
    this.options.busy(true)
    try {
      // Validate all metadata before opening any reader; one rejected file cannot start partial I/O.
      const plan = prepareAttachmentFiles(files)
      const result = await Promise.all(plan.map(async ({ file, name, size }) => ({ name, size, data: await this.options.read(file, operation.controller.signal) })))
      if (this.active === operation) this.options.accepted(result)
    } catch (error) { if (this.active === operation) this.options.failed(error) }
    finally {
      if (this.active === operation) { this.active = undefined; operation.controller.abort(); this.options.busy(false) }
    }
  }
}
