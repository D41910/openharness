import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneInbox } from './inbox.js'
import { ATTEMPT_MS, deliveryKey, Mailbox, MAX_BACKOFF_MS, PARK_MS, PUMP_MS, type MailboxAgent, type MailboxDeps } from './mailbox.js'
import type { DeliveryStatus, Message } from './model.js'
import { MessageStore } from './store.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mailbox-')) })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

const message = (id = 'm0000001'): Message => ({
  id, tabId: 'app', text: 'review 3f2a9c1', at: 1,
  from: { machineId: 'm1', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'studio' },
  to: [{ machineId: 'm1', agentId: 'api', name: 'api' }],
})

function setup(over: Partial<MailboxDeps> = {}) {
  let clock = 1_000
  const store = new MessageStore(join(root, 'state'))
  const inbox = new PaneInbox(join(root, 'agent-messages'))
  let agent: MailboxAgent | null = { pane: '%3', session: '', available: true }
  const delivered: Array<[string, string, string]> = []
  const statuses: DeliveryStatus[] = []
  let refused: string | null = null
  const deps: MailboxDeps = {
    store, inbox, now: () => clock,
    agent: () => agent,
    deliver: (agentId, text, id) => { delivered.push([agentId, text, id]) },
    refused: () => refused,
    text: (_d, m) => `[${m.id}] ${m.text}`,
    changed: (status) => { statuses.push(status) },
    ...over,
  }
  const mailbox = new Mailbox(deps)
  const accept = (m = message()) => { store.record(m); return mailbox.accept(m, 'api') }
  return {
    store, inbox, mailbox, delivered, statuses, accept,
    tick: (ms: number) => { clock += ms },
    setAgent: (next: MailboxAgent | null) => { agent = next },
    refuse: (why: string | null) => { refused = why },
    claim: (pane: string, key: string) => {
      // As the hook does: the rename into claimed/.
      renameSync(join(root, 'agent-messages', 'inbox', pane.slice(1), `${key}.json`), join(root, 'agent-messages', 'claimed', `${pane.slice(1)}-${key}.json`))
    },
  }
}

describe('Agent Messages\' mailbox', () => {
  it('puts a message in the agent\'s inbox and types it at once into an idle agent', () => {
    const t = setup()
    const delivery = t.accept()
    expect(delivery.key).toBe(deliveryKey('m0000001', 'api'))
    expect(t.delivered).toEqual([['api', '[m0000001] review 3f2a9c1', `team:msg:${delivery.key}:1`]])
    // Taken back from the hook while it is typed: the hook cannot also deliver it.
    expect(t.inbox.waiting('%3', delivery.key)).toBe(false)
    expect(t.mailbox.canWrite(`team:msg:${delivery.key}:1`)).toBe(true)
    expect(t.mailbox.canWrite('team:msg:other')).toBe(false)
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:1`, sessionId: 'api', state: 'queued' })
    expect(delivery.state).toBe('queued')
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:1`, sessionId: 'api', state: 'started' })
    expect(delivery).toMatchObject({ state: 'delivered', via: 'prompt' })
    expect(t.statuses.at(-1)).toMatchObject({ messageId: 'm0000001', agentId: 'api', state: 'delivered', via: 'prompt' })
    expect(t.mailbox.canWrite(`team:msg:${delivery.key}:1`)).toBe(false)
    // Accepted again (a retried handover): the same delivery.
    expect(t.mailbox.accept(message(), 'api')).toBe(delivery)
  })

  it('gives a message back to the hook while the agent works, and the hook delivers it at its next tool call', () => {
    const t = setup()
    const delivery = t.accept()
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:1`, sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    expect(t.statuses.at(-1)).toMatchObject({ state: 'queued', reason: 'working: arrives at its next tool call' })
    // Not typed again before its wait is over.
    t.mailbox.pump()
    expect(t.delivered).toHaveLength(1)
    t.claim('%3', delivery.key)
    t.mailbox.pump()
    expect(delivery).toMatchObject({ state: 'delivered', via: 'hook' })
    expect(t.delivered).toHaveLength(1)
  })

  it('gives a typed attempt the core holds behind a running turn back to the hook, and types it once the turn ends without a tool call', () => {
    let clock = 1_000
    const writable = vi.fn()
    const t = setup({ now: () => clock, writable })
    const delivery = t.accept()
    const first = delivery.attempt!.id
    t.mailbox.observe({ deliveryId: first, sessionId: 'api', state: 'queued' })
    t.mailbox.observe({ deliveryId: first, sessionId: 'api', state: 'queued' })
    expect(delivery.attempt!.queuedAt).toBe(1_000)
    clock += PARK_MS - 1
    t.mailbox.pump()
    expect(t.mailbox.canWrite(first)).toBe(true)
    clock += 1
    t.mailbox.pump()
    expect(delivery.attempt!.parked).toBe(true)
    expect(t.mailbox.canWrite(first)).toBe(false)
    expect(writable).toHaveBeenCalledOnce()
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'working: arrives at its next tool call' })
    // Parked, it never times out: it waits for its turn to end.
    clock += ATTEMPT_MS * 2
    t.mailbox.pump()
    expect(delivery.state).toBe('queued')
    // The turn ended with no tool call: the core asks, is refused, and the next attempt types it at once.
    t.mailbox.observe({ deliveryId: first, sessionId: 'api', state: 'rejected', reason: 'team_waiting_control' })
    expect(delivery.attempt).toBeUndefined()
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    t.mailbox.pump()
    expect(t.delivered.map(([, , id]) => id)).toEqual([first, `team:msg:${delivery.key}:2`])
  })

  it('takes a parked attempt the hook took as delivered through the hook, and one the core wrote anyway as typed', () => {
    let clock = 1_000
    const t = setup({ now: () => clock })
    const hooked = t.accept()
    t.mailbox.observe({ deliveryId: hooked.attempt!.id, sessionId: 'api', state: 'queued' })
    clock += PARK_MS
    t.mailbox.pump()
    t.claim('%3', hooked.key)
    t.mailbox.pump()
    expect(hooked).toMatchObject({ state: 'delivered', via: 'hook' })
    // Late: the core is refused, and nothing changes.
    t.mailbox.observe({ deliveryId: `team:msg:${hooked.key}:1`, sessionId: 'api', state: 'rejected', reason: 'team_waiting_control' })
    expect(hooked.state).toBe('delivered')
    const written = t.accept(message('m0000002'))
    t.mailbox.observe({ deliveryId: written.attempt!.id, sessionId: 'api', state: 'queued' })
    clock += PARK_MS
    t.mailbox.pump()
    expect(t.inbox.waiting('%3', written.key)).toBe(true)
    t.mailbox.observe({ deliveryId: written.attempt!.id, sessionId: 'api', state: 'delivered' })
    expect(written).toMatchObject({ state: 'delivered', via: 'prompt' })
    expect(t.inbox.waiting('%3', written.key)).toBe(false)
  })

  it('waits longer between typed attempts at an agent that keeps working, up to a limit', () => {
    let clock = 1_000
    const t = setup({ now: () => clock })
    const delivery = t.accept()
    const waits: number[] = []
    for (let i = 1; i <= 7; i++) {
      t.mailbox.observe({ deliveryId: delivery.attempt!.id, sessionId: 'api', state: 'rejected', reason: i % 2 ? 'team_waiting_draft' : 'team_waiting_user' })
      waits.push(delivery.nextTryAt - clock)
      clock = delivery.nextTryAt
      t.mailbox.pump()
    }
    expect(waits).toEqual([4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000])
    expect(t.statuses.map((s) => s.reason)).toContain('someone is typing in its pane')
    expect(t.statuses.map((s) => s.reason)).toContain('a dialog is open in its pane')
  })

  it('never types a message twice once it may have reached the engine', () => {
    const t = setup()
    const delivery = t.accept()
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:1`, sessionId: 'api', state: 'unknown' })
    expect(delivery).toMatchObject({ state: 'delivered', via: 'prompt', reason: 'unconfirmed: inspect its pane' })
    const other = t.accept(message('m0000002'))
    t.tick(ATTEMPT_MS + 1)
    t.mailbox.pump()
    expect(other).toMatchObject({ state: 'delivered', reason: 'unconfirmed: inspect its pane' })
    expect(t.delivered).toHaveLength(2)
  })

  it('reads other refusals as a wait, by their own reason, and ignores a stranger\'s delivery', () => {
    const t = setup()
    const delivery = t.accept()
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:1`, sessionId: 'api', state: 'rejected', reason: 'queue_full' })
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'queue_full' })
    t.tick(PUMP_MS * 2)
    t.mailbox.pump()
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:2`, sessionId: 'api', state: 'rejected' })
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'waiting' })
    t.mailbox.observe({ deliveryId: 'team:other', sessionId: 'api', state: 'started' })
    expect(delivery.state).toBe('queued')
  })

  it('fails a delivery the directory refuses, and withdraws it from the hook', () => {
    const t = setup()
    const delivery = t.accept()
    t.mailbox.observe({ deliveryId: `team:msg:${delivery.key}:1`, sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    t.refuse('Agent Messages were turned off in this tab')
    t.mailbox.refuseAll()
    expect(delivery).toMatchObject({ state: 'failed', reason: 'Agent Messages were turned off in this tab' })
    expect(t.inbox.waiting('%3', delivery.key)).toBe(false)
    // In the middle of a typed attempt: left to finish, and refused at the next pump.
    t.refuse(null)
    const next = t.accept(message('m0000002'))
    t.refuse('it is no longer in a tab with the sender')
    t.mailbox.refuseAll()
    expect(next.state).toBe('queued')
    t.mailbox.observe({ deliveryId: next.attempt!.id, sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    t.tick(MAX_BACKOFF_MS)
    t.mailbox.pump()
    expect(next.state).toBe('failed')
  })

  it('waits for a stopped harness, and follows it into another pane', () => {
    const t = setup()
    t.setAgent(null)
    const delivery = t.accept()
    expect(delivery.pane).toBe('')
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'its harness is stopped' })
    t.setAgent({ pane: '%3', session: '', available: false })
    t.mailbox.pump()
    expect(t.delivered).toHaveLength(0)
    t.setAgent({ pane: '%9', session: 's2', available: true })
    t.mailbox.pump()
    expect(delivery.pane).toBe('%9')
    expect(t.delivered).toHaveLength(1)
    t.mailbox.observe({ deliveryId: delivery.attempt!.id, sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    expect(t.inbox.waiting('%9', delivery.key)).toBe(true)
    // Moved again while waiting for the hook: the file moves with it.
    t.setAgent({ pane: '%4', session: 's2', available: true })
    t.mailbox.pump()
    expect(t.inbox.waiting('%9', delivery.key)).toBe(false)
    expect(t.inbox.waiting('%4', delivery.key)).toBe(true)
  })

  it('fails a delivery whose message is no longer kept', () => {
    const t = setup()
    const delivery = t.accept()
    t.mailbox.observe({ deliveryId: delivery.attempt!.id, sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    t.store.state.history = []
    t.tick(MAX_BACKOFF_MS)
    t.mailbox.pump()
    expect(delivery).toMatchObject({ state: 'failed', reason: 'the message is no longer kept' })
  })

  it('on start: an attempt cut off is never typed again, and what was taken back goes back to the hook', () => {
    const t = setup()
    const cut = t.accept()
    const parked = t.accept(message('m0000003'))
    t.mailbox.observe({ deliveryId: parked.attempt!.id, sessionId: 'api', state: 'queued' })
    parked.attempt!.parked = true
    const back = t.accept(message('m0000002'))
    t.mailbox.observe({ deliveryId: back.attempt!.id, sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    t.inbox.reclaim('%3', back.key)
    t.inbox.put('%3', 'stale', { session: '', text: 'x' })
    t.inbox.reclaim('%3', 'stale')
    t.store.save()
    const restarted = new Mailbox({ store: new MessageStore(join(root, 'state')), inbox: t.inbox, agent: () => null, deliver: () => {}, refused: () => null, text: () => '', changed: () => {} })
    restarted.start()
    restarted.start()
    restarted.stop()
    const state = new MessageStore(join(root, 'state')).state.local
    expect(state.find((d) => d.key === cut.key)).toMatchObject({ state: 'delivered', reason: 'unconfirmed: the service restarted while typing it' })
    expect(state.find((d) => d.key === parked.key)).toMatchObject({ state: 'queued' })
    expect(state.find((d) => d.key === parked.key)!.attempt).toBeUndefined()
    expect(t.inbox.waiting('%3', back.key)).toBe(true)
    expect(t.inbox.reclaimed()).toEqual([])
  })

  it('pumps on its own every few seconds once started, and stops', () => {
    vi.useFakeTimers()
    const t = setup()
    t.mailbox.start()
    const pump = vi.spyOn(t.mailbox, 'pump')
    vi.advanceTimersByTime(PUMP_MS)
    expect(pump).toHaveBeenCalledOnce()
    pump.mockImplementation(() => { throw new Error('a bad look') })
    vi.advanceTimersByTime(PUMP_MS)
    t.mailbox.stop()
    t.mailbox.stop()
    vi.advanceTimersByTime(PUMP_MS * 3)
    expect(pump).toHaveBeenCalledTimes(2)
  })

  it('keeps going when the inbox cannot be written or the store saved', () => {
    const t = setup()
    vi.spyOn(t.inbox, 'put').mockImplementation(() => { throw new Error('disk full') })
    vi.spyOn(t.store, 'save').mockImplementation(() => { throw new Error('disk full') })
    const delivery = t.accept()
    expect(delivery.state).toBe('queued')
    t.mailbox.pump()
  })
})
