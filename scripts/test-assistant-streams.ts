import assert from 'node:assert/strict'
import { chatResponse } from '../packages/api/src/assistant-stream'
const controller = new AbortController()
const content = 'A'.repeat(1_100_000)
const data = { choices: [{ delta: { content, tool_calls: Array.from({ length: 20 }, (_, index) => ({ index, id: 'call-' + index, function: { name: 'list_devices', arguments: '{}' } })) } }] }
const response = new Response('data: ' + JSON.stringify(data) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const result = await chatResponse(response, controller.signal)
assert.equal(result.content, content)
assert.equal(result.tool_calls.length, 20)
controller.abort()
await assert.rejects(chatResponse(new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] })), controller.signal))
console.log('ASSISTANT STREAMS OK: large SSE responses, 20 tool calls and cancellation')
