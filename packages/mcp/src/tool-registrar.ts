import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'

type SdkV3Input = Record<string, Extract<AnySchema, { _def: unknown }>>
type Options<Shape> = { title?: string; description?: string; annotations?: ToolAnnotations; inputSchema: Shape }

/** Infer handler arguments with this package's Zod 3, not the SDK's mixed v3/v4 overload tree. */
export function toolRegistrar(server: McpServer) {
  return { registerTool<Shape extends z.ZodRawShape>(name: string, options: Options<Shape>, callback: (args: z.output<z.ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>): RegisteredTool {
    // The SDK resolves a different Zod 3 declaration copy. Adapt only this nominal boundary.
    // The original schema/options/callback objects are forwarded; SDK runtime validation stays enabled.
    return server.registerTool<Record<string, never>, SdkV3Input>(name, options as unknown as Options<SdkV3Input>, callback as unknown as ToolCallback<SdkV3Input>)
  } }
}
