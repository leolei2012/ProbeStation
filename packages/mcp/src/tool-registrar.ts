import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { deviceWriteRefusal } from '../../core/src/device-write-policy.ts'

type SdkV3Input = Record<string, Extract<AnySchema, { _def: unknown }>>
type Options<Shape> = { title?: string; description?: string; annotations?: ToolAnnotations; inputSchema: Shape; boundDeviceWrite?: true }

/** Infer handler arguments with this package's Zod 3, not the SDK's mixed v3/v4 overload tree. */
export function toolRegistrar(server: McpServer) {
  return { registerTool<Shape extends z.ZodRawShape>(name: string, options: Options<Shape>, callback: (args: z.output<z.ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>): RegisteredTool {
    // The SDK resolves a different Zod 3 declaration copy. Adapt only this nominal boundary.
    // Schemas stay intact. Unsafe direct-send callbacks are never registered.
    const handler = (name === 'write_register' && options.boundDeviceWrite !== true) || name === 'ota_upgrade'
      ? () => ({ isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify(deviceWriteRefusal()) }] })
      : callback
    const config = options.boundDeviceWrite ? (({ boundDeviceWrite: _bound, ...rest }) => rest)(options) : options
    return server.registerTool<Record<string, never>, SdkV3Input>(name, config as unknown as Options<SdkV3Input>, handler as unknown as ToolCallback<SdkV3Input>)
  } }
}
