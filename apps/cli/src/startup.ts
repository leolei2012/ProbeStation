import net from 'node:net'

/** Probe before opening databases or starting pollers. Binding can still race after this check. */
export async function assertPortsAvailable(ports: number[]): Promise<void> {
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用。请先在旧 ProbeStation 终端按 Ctrl+C，再重新启动；若不是旧实例，请检查占用该端口的程序。`
        : `无法监听端口 ${port}：${error.code ?? error.message}`)))
      server.listen(port, '0.0.0.0', () => server.close(error => error ? reject(error) : resolve()))
    })
  }
}
