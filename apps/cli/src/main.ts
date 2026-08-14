import { Context } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import * as core from '@probebench/core'

const ctx = new Context()

ctx.plugin(ConsoleExporter)
ctx.plugin(core, {
  host: '0.0.0.0',
  port: 8080,
  dbPath: 'data/modbus_monitor.db',
  dataRetainDays: 30,
  pollIntervalMs: 1000,
})

ctx.logger('cli').info('ProbeStation booted')
