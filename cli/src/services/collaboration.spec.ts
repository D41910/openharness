import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, TEAMS_REQUESTS } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'

/**
 * Agent Messages in Swarm's slot: the service is messages/service.ts's to prove (messages/service.spec.ts); here,
 * that the slot starts it and keeps its contract with the core.
 */
const made = vi.hoisted(() => ({ calls: [] as string[], options: [] as unknown[] }))
vi.mock('../messages/service.js', () => ({
  startAgentMessages: (_core: unknown, options: unknown) => {
    made.options.push(options)
    return {
      requests: { agent_messages: async () => ({ ok: true }) },
      canWrite: (id: string) => id === 'team:msg:yes',
      start: () => made.calls.push('start'),
      stop: () => made.calls.push('stop'),
    }
  },
}))

import { startCollaboration, startTeamsInCore, TEAMS_REQUESTS as REEXPORTED } from './collaboration.js'

describe('Agent Messages in the collaboration slot', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'collab-')); made.calls.length = 0; made.options.length = 0 })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('answers the one request the core routes to it', () => {
    expect(TEAMS_REQUESTS).toEqual(['agent_messages'])
    expect(REEXPORTED).toBe(TEAMS_REQUESTS)
  })

  it('starts Agent Messages with the options it was given', () => {
    const service = startCollaboration(fakeCore({ dataDir: dir }), { dataDir: dir })
    expect(made.options).toEqual([{ dataDir: dir }])
    expect(service.canWrite('team:msg:yes')).toBe(true)
    startCollaboration(fakeCore({ dataDir: dir }))
    expect(made.options.at(-1)).toEqual({})
  })

  it('in the core\'s process: starts at once, answers whether a delivery may be written, and records no scopes', async () => {
    const ports = emptyPorts()
    const requests = startTeamsInCore(fakeCore({ dataDir: dir }), ports)
    expect(made.calls).toEqual(['start'])
    expect(await requests.agent_messages!({ action: 'history' }, { local: true, owner: true })).toEqual({ ok: true })
    expect(ports.teams!.canWrite('team:msg:yes')).toBe(true)
    expect(ports.teams!.canWrite('team:msg:no')).toBe(false)
    // The core still records each prompt's scope here; nothing reads it now.
    const undo = ports.teams!.prepare('a1', 'text')
    undo()
    ports.teams!.started!('a1', 'text', 'hook')
    ports.teams!.raw!('a1', Buffer.from('x'))
    ports.teams!.forget!('a1')
    ;(ports.teams as unknown as { stop(): void }).stop()
    expect(made.calls).toEqual(['start', 'stop'])
    startTeamsInCore(fakeCore({ dataDir: dir }), emptyPorts(), { dataDir: dir })
    expect(made.options.at(-1)).toEqual({ dataDir: dir })
  })
})
