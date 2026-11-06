import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ConfigEditRegistrar } from './config-edit.ts'
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'

type SdkV3Input = Record<string, Extract<AnySchema, { _def: unknown }>>

/** Type-check the production SDK boundary once without re-inferring every edit schema overload. */
export function configEditRegistrar(server: McpServer): ConfigEditRegistrar {
  return { registerTool(name, options, callback) {
    // MCP uses its installed Zod 3 copy; SDK compatibility declarations resolve another copy.
    // Adapt only this nominal schema boundary. SDK runtime validation stays enabled and is protocol-tested.
    const inputSchema = options.inputSchema as unknown as SdkV3Input
    return server.registerTool<Record<string, never>, SdkV3Input>(name, { ...options, inputSchema }, callback)
  } }
}
