import assert from 'node:assert/strict'
import { providerCatalog, providerCompletion } from '../packages/api/src/assistant-providers'
const tools = [{ type: 'function', function: { name: 'list_devices', description: 'List devices', parameters: { type: 'object', properties: {}, required: [] } } }]
const sse = (events: any[]) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
for (const provider of ['deepseek', 'anthropic', 'minimax-cn']) {
  const entry = providerCatalog().find(p => p.id === provider)!.models[0]
  let count = 0
  const mock: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); count++
    assert.equal(init?.redirect, 'error')
    assert.equal(body.model, entry.id)
    assert(JSON.stringify(body).includes('list_devices'))
    if (count === 2) assert(JSON.stringify(body).includes('tool-1'))
    if (provider === 'deepseek') {
      assert(String(url).endsWith('/chat/completions'))
      const delta = count === 1 ? { tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name: 'list_devices', arguments: '{}' } }] } : { content: '完成' }
      return new Response(`data: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta, finish_reason: count === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    assert(String(url).includes('/messages'))
    const block = count === 1 ? { type: 'tool_use', id: 'tool-1', name: 'list_devices', input: {} } : { type: 'text', text: '' }
    return sse([{ type: 'message_start', message: { id: 'reply', type: 'message', role: 'assistant', model: entry.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: block }, ...(count === 1 ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }]), { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: count === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }])
  }
  const config = { provider, model: entry.id, baseUrl: entry.baseUrl, apiKey: 'test-only', effort: 'default' }
  const messages: any[] = [{ role: 'system', content: 'Test' }, { role: 'user', content: 'List devices' }]
  const first = await providerCompletion(config, messages, tools, new AbortController().signal, mock)
  assert.equal(first.tool_calls[0].function.name, 'list_devices')
  messages.push({ role: 'assistant', ...first }, { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '[]' })
  let streamed = ''
  const last = await providerCompletion(config, messages, tools, new AbortController().signal, mock, text => { streamed += text })
  assert.equal(streamed, '完成')
  assert.equal(last.content, '完成'); assert.equal(count, 2)
  console.log(provider + ': native tools + replay OK')
}
