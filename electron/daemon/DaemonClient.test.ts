import { beforeEach, describe, expect, it, vi } from 'vitest'

const wsConstructor = vi.fn()
const wsHandlers = new Map<string, (...args: any[]) => void>()
const createConnectionMock = vi.fn((_path: string) => ({}) as any)

vi.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1
    readyState = MockWebSocket.OPEN

    constructor(address: string, options?: Record<string, unknown>) {
      wsConstructor(address, options)
    }

    on(event: string, handler: (...args: any[]) => void): this {
      wsHandlers.set(event, handler)
      return this
    }

    close(): void {
      // no-op
    }
  }

  return { default: MockWebSocket }
})

vi.mock('net', () => ({
  createConnection: (path: string) => createConnectionMock(path)
}))

import { DaemonClient } from './DaemonClient'

describe('DaemonClient websocket connection', () => {
  beforeEach(() => {
    wsConstructor.mockReset()
    wsHandlers.clear()
    createConnectionMock.mockReset()
    createConnectionMock.mockReturnValue({} as any)
  })

  it('uses createConnection to bind websocket traffic to the daemon Unix socket', () => {
    const socketPath = '/Users/test/Library/Application Support/hydra/daemon.sock'
    const client = new DaemonClient(socketPath)

    ;(client as any).connectWebSocket()

    expect(wsConstructor).toHaveBeenCalledTimes(1)
    expect(wsConstructor).toHaveBeenCalledWith(
      'ws://localhost/ws',
      expect.objectContaining({
        createConnection: expect.any(Function)
      })
    )

    const options = wsConstructor.mock.calls[0]?.[1] as { createConnection: () => unknown }
    options.createConnection()
    expect(createConnectionMock).toHaveBeenCalledWith(socketPath)
  })

  it('relays overview snapshots from the websocket', () => {
    const client = new DaemonClient('/tmp/daemon.sock')
    const listener = vi.fn()
    client.on('overview:snapshot', listener)
    ;(client as any).connectWebSocket()

    const snapshot = { at: 1, sessions: [], counts: { total: 0 } }
    wsHandlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'overview:snapshot', payload: snapshot })))

    expect(listener).toHaveBeenCalledWith(snapshot)
  })
})
