import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { registerAssistant } from '../packages/api/src/assistant.ts'
import { contextBudget, estimateContextTokens } from '../packages/api/src/assistant-context.ts'

assert.equal(contextBudget(204800)?.compactAt, 176947)
assert.equal(contextBudget(null), null)
const base = [{ role: 'assistant', content: 'hello' }]
assert.equal(estimateContextTokens(base), estimateContextTokens([{ ...base[0], _native: { content: 'x'.repeat(100000) } }]))
assert(estimateContextTokens([{ role: 'user', content: '温度'.repeat(1000) }]) > estimateContextTokens([{ role: 'user', content: 'a'.repeat(2000) }]))

const dir = mkdtempSync(join(tmpdir(), 'probe-context-'))
mkdirSync(join(dir, 'ai-sessions'))
const requests: any[] = []
const cfg: any = { listObjects: () => [], getObject: () => undefined }
const app = Fastify()
registerAssistant(app, { cfg, store: {}, poller: {} }, dir, async (_url, options) => {
  const request = JSON.parse(String(options?.body)); requests.push(request)
  const summarizing = request.messages[0].content.includes('你是对话摘要器')
  return new Response(JSON.stringify({ choices: [{ message: { content: summarizing ? '较早对话：用户正在分析设备数据，尚未修改配置。' : '分析完成。' } }] }))
})
const headers = { 'x-probestation-ai': '1' }
async function configure(window: number | null) {
  const response = await app.inject({ method: 'POST', url: '/api/ai/settings', headers, payload: { baseUrl: 'https://model.example/v1', model: 'test', contextWindow: window } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal((await app.inject({ url: '/api/ai/settings', headers })).json().contextWindow, window)
}
function seed(messages: any[]) {
  const id = randomUUID()
  writeFileSync(join(dir, 'ai-sessions', id + '.json'), JSON.stringify({ id, deviceId: null, messages: [{ role: 'system', content: '仅分析' }, ...messages], entries: [], proposals: [], turns: [], touched: Date.now(), running: false }))
  return id
}
async function ask(id: string, message: string) {
  const result = await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/messages`, headers, payload: { message } })
  assert.equal(result.statusCode, 200, result.body)
  for (let i = 0; i < 100; i++) {
    const state = (await app.inject({ url: `/api/ai/sessions/${id}`, headers })).json()
    if (!state.running) { assert(!state.error, state.error); return state }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('request did not finish')
}
try {
  await configure(400000)
  const many = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? '好的' : '请求时间：测试\n继续分析' }))
  const long = 'a'.repeat(240000)
  await ask(seed(many), long)
  assert.equal(requests.length, 1, 'no 80-message or 80K-character compaction threshold')
  assert(requests[0].messages.at(-1).content.includes(long), 'long input is not truncated at 8K or 120K')
  assert(requests[0].messages.length > 100)
  await configure(null)
  await ask(seed(many), '温度'.repeat(100000))
  assert.equal(requests.length, 2, 'unknown custom window does not impose a fixed text ceiling')

  await configure(8192)
  requests.length = 0
  const nearLimit = seed([{ role: 'user', content: '请求时间：测试\n' + 'x'.repeat(18000) }, { role: 'assistant', content: '已分析' }])
  const recent = '当前问题：' + 'y'.repeat(5000)
  const state = await ask(nearLimit, recent)
  assert.equal(requests.length, 2, 'near the configured model capacity, summarize before responding')
  assert(state.entries.some((e: any) => e.content.includes('已压缩上下文')))
  assert(requests[1].messages.some((m: any) => m.content.includes('较早对话摘要')))
  assert(requests[1].messages.at(-1).content.includes(recent), 'latest whole turn remains intact')
  assert(requests[0].max_tokens <= 2048, 'reserve fits small windows')
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/settings', headers, payload: { baseUrl: 'https://model.example/v1', model: 'test', contextWindow: 10 } })).statusCode, 400)
  console.log('ASSISTANT CONTEXT OK: model capacities, long input, many messages, unknown windows, automatic compaction and latest-turn preservation')
} finally { await app.close() }
