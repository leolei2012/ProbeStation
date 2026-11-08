import assert from 'node:assert/strict'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { toolRegistrar } from '../src/tool-registrar.ts'

// Compile-only cases: none of these registrations are executed.
function checkInference(server: McpServer) {
  const tools = toolRegistrar(server)
  tools.registerTool('inference', { inputSchema: { id: z.number(), name: z.string().optional(), limit: z.number().default(7), rows: z.array(z.object({ value: z.number() })) } }, args => {
    const id: number = args.id, limit: number = args.limit, name: string | undefined = args.name, nested: number = args.rows[0].value
    // @ts-expect-error Required numeric inputs do not become any.
    const wrongId: string = args.id
    // @ts-expect-error Optional inputs remain possibly undefined.
    const wrongName: string = args.name
    // @ts-expect-error Nested schemas retain their numeric output.
    const wrongNested: string = args.rows[0].value
    // @ts-expect-error Unknown arguments are not permitted.
    args.missing
    return { content: [{ type: 'text', text: String([id, limit, name, nested]) }] }
  })
  // @ts-expect-error A raw shape must contain real schemas.
  tools.registerTool('bad-schema', { inputSchema: { id: 'not-a-schema' } }, () => ({ content: [] }))
  // @ts-expect-error A handler must return a valid MCP result, not a number.
  tools.registerTool('bad-result', { inputSchema: {} }, () => 12)
}
void checkInference

export function verifyForwardingIdentity() {
  const registered = {} as RegisteredTool
  const options = { title: 'synthetic identity', inputSchema: { id: z.number() } }
  const callback = (args: { id: number }) => ({ content: [{ type: 'text' as const, text: String(args.id) }] })
  const server = { registerTool(this: unknown, name: unknown, config: unknown, handler: unknown) {
    assert.equal(this, server); assert.equal(name, 'synthetic-identity'); assert.equal(config, options); assert.equal(handler, callback)
    return registered
  } }
  assert.equal(toolRegistrar(server as unknown as McpServer).registerTool('synthetic-identity', options, callback), registered)
}

/** Test-only SDK server: no production tool, service or network listener. */
export function createDefaultProtocolFixture() {
  const server = new McpServer({ name: 'synthetic-registrar', version: '1' }); let calls = 0
  toolRegistrar(server).registerTool('synthetic-defaults', { inputSchema: { limit: z.number().default(7), name: z.string().optional() } }, args => {
    calls++; return { content: [{ type: 'text', text: JSON.stringify(args) }] }
  })
  return { server, calls: () => calls }
}
