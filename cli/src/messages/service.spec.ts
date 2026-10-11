import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendNotice, TurnDelivery } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { PaneInbox } from './inbox.js'
import { deliveryKey } from './mailbox.js'
import { LIMITS, MessageError } from './model.js'
import type { Rpc } from './rpc.js'
import { REMOTE_STATUS_MS, startAgentMessages, TICK_MS } from './service.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agent-messages-')) })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

const OWNER_LOCAL = { local: true, owner: true }
const OWNER_REMOTE = { local: false, owner: true }
const session = (agentId: string, pane: string, engine = 'claude', cwd = `/work/${agentId}`) =>
  ({ agentId, sessionId: `s-${agentId}`, engine, cwd, tmuxPane: pane, active: true, title: agentId }) as unknown as RegisteredSession

interface Setup {
  tabs?: Array<{ id: string; name: string; enabled: boolean; panes: Array<{ machineId: string; agentId: string }> }>
  agents?: RegisteredSession[]
  rpc?: Rpc
  backendStatus?: number
}

function setup(over: Setup = {}) {
  let clock = 1_000_000
  const agents = over.agents ?? [session('lead', '%1', 'codex'), session('api', '%2'), session('web', '%3')]
  const tabs = over.tabs ?? [{ id: 'app', name: 'app', enabled: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }, { machineId: 'm2', agentId: 'phone' }] }]
  const directory = { revision: 4, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: 'laptop' }], tabs }
  const delivered: Array<[string, string, string]> = []
  const windows: Array<Record<string, unknown>> = []
  const deliveryListeners = new Set<(event: TurnDelivery) => void>()
  const noticeListeners = new Set<(notice: BackendNotice) => void>()
  const backend = vi.fn(async () => ({ status: over.backendStatus ?? 200, body: { success: true, data: directory } }))
  const rpcCalls: Array<[string, Record<string, unknown>]> = []
  const rpc: Rpc = over.rpc ?? (async (target, payload) => {
    rpcCalls.push([target.machineId, payload])
    if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude', project: 'app' }] }
    if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'queued' }] }
    return { statuses: [] }
  })
  const changed = vi.fn()
  const core = fakeCore({
    dataDir: root,
    daemon: { machineId: () => 'm1', port: 18473 },
    agents: {
      live: () => agents,
      displayName: (s) => (s as unknown as { title: string }).title,
      terminalAvailable: () => true,
    },
    turns: {
      deliver: (agentId, text, id) => { delivered.push([agentId, text, id]) },
      onDelivery: (listener) => { deliveryListeners.add(listener); return () => deliveryListeners.delete(listener) },
    },
    account: {
      backend,
      onNotice: (listener) => { noticeListeners.add(listener); return () => noticeListeners.delete(listener) },
    },
    clients: { windows: (frame) => { windows.push(frame) } },
  })
  const service = startAgentMessages(core, { stateDir: join(root, 'state'), inboxRoot: join(root, 'inbox-root'), rpc: over.rpc ? over.rpc : rpc, now: () => clock, changed })
  const ask = (payload: Record<string, unknown>, asker = OWNER_LOCAL) => service.requests.agent_messages!(payload, asker)
  return {
    service, ask, delivered, windows, backend, rpcCalls, agents, tabs, directory, changed,
    inbox: new PaneInbox(join(root, 'inbox-root')),
    tick: (ms: number) => { clock += ms },
    deliveryEvent: (event: TurnDelivery) => { for (const l of deliveryListeners) l(event) },
    notice: (notice: BackendNotice) => { for (const l of noticeListeners) l(notice) },
  }
}

describe('harness send', () => {
  it('sends from the pane\'s harness to a teammate on this machine, typed into it when idle, with the roster note first', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: ['api'], text: 'Is the cleanup fix in?' })
    expect(reply).toMatchObject({ tab: 'app', recipients: [{ name: 'api', state: 'queued' }] })
    const id = reply.id as string
    expect(id).toMatch(/^m[0-9a-z]{7}$/)
    expect(t.delivered).toHaveLength(1)
    const [agentId, text, deliveryId] = t.delivered[0]
    expect(agentId).toBe('api')
    expect(deliveryId).toBe(`team:msg:${deliveryKey(id, 'api')}:1`)
    expect(text).toContain('[Harness] Agent Messages are on in tab "app". Teammates:')
    expect(text).toContain('lead')
    expect(text).toContain('phone')
    expect(text).toContain(`[${id} from lead · Codex · studio]\nIs the cleanup fix in?`)
    expect(t.service.canWrite(deliveryId)).toBe(true)
    // The core typed it: delivered, and the windows hear of it.
    t.deliveryEvent({ deliveryId, sessionId: 'api', state: 'started' })
    const history = await t.ask({ action: 'history', tabId: 'app' })
    expect(history.messages).toEqual([expect.objectContaining({ id, statuses: expect.arrayContaining([
      expect.objectContaining({ machineId: 'm1', agentId: 'api', state: 'delivered', via: 'prompt' }),
    ]) })])
    expect(t.windows.at(-1)).toMatchObject({ type: 'messages_changed', payload: { tabId: 'app', messageId: id, to: [{ agentId: 'api', state: 'delivered' }] } })
    // The note rode with the message: the next one comes without it.
    const second = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'thanks' })
    expect(t.delivered.at(-1)![1]).toBe(`[${second.id} from lead · Codex · studio]\nthanks`)
  })

  it('hands a teammate on another machine to that machine, and asks later what became of it', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: ['phone'], text: 'ping' })
    expect(reply.recipients).toEqual([{ name: 'phone', state: 'queued' }])
    expect(t.rpcCalls.map(([machine, p]) => [machine, p.action])).toEqual([['m2', 'who'], ['m2', 'deliver']])
    expect(t.rpcCalls[1][1].message).toMatchObject({ id: reply.id, from: { agentId: 'lead', machine: 'studio' }, to: [{ machineId: 'm2', agentId: 'phone', name: 'phone' }] })
    t.tick(REMOTE_STATUS_MS)
  })

  it('without a recipient lists who is here; and says plainly what is wrong with a send', async () => {
    const t = setup()
    const roster = await t.ask({ action: 'send', pane: '%1' })
    expect(roster.roster).toContain('Teammates:')
    expect(roster.roster).toMatch(/api\s+Claude Code · studio · api/)
    expect(roster.roster).toMatch(/phone\s+Claude Code · laptop · app/)
    const fail = async (payload: Record<string, unknown>, asker = OWNER_LOCAL) => (await t.ask(payload, asker)).error
    expect(await fail({ action: 'send', pane: 'nope', to: 'api', text: 'x' })).toBe('NOT_A_HARNESS')
    expect(await fail({ action: 'send', pane: '%99', to: 'api', text: 'x' })).toBe('NOT_A_HARNESS')
    expect(await fail({ action: 'send', pane: '%1', text: 'x' })).toBe('USAGE')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: '  ' })).toBe('USAGE')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LIMITS.text + 1) })).toBe('TOO_LONG')
    expect(await fail({ action: 'send', pane: '%1', to: 'nobody', text: 'x' })).toBe('UNKNOWN_RECIPIENT')
    // A unique start of a name is enough.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'ph', text: 'x' })).recipients).toEqual([{ name: 'phone', state: 'queued' }])
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x' }, OWNER_REMOTE)).toBe('LOCAL_ONLY')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x' }, { local: true, owner: false })).toBe('OWNER_REQUIRED')
    expect(await fail({ action: 'nonsense' })).toBe('UNKNOWN_ACTION')
    // Sent to the same teammate twice in one message: once.
    const twice = await t.ask({ action: 'send', pane: '%1', to: 'api,API', text: 'once' })
    expect(twice.recipients).toHaveLength(1)
  })

  it('tells two teammates with the same start apart only by more of the name', async () => {
    const t = setup({
      agents: [session('lead', '%1'), session('api-a', '%2'), session('api-b', '%3')],
      tabs: [{ id: 'app', name: 'app', enabled: true, panes: ['lead', 'api-a', 'api-b'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).error).toBe('AMBIGUOUS_RECIPIENT')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api-b', text: 'x' })).recipients).toEqual([{ name: 'api-b', state: 'queued' }])
  })

  it('refuses in a tab with Agent Messages off, and when the directory cannot be read', async () => {
    const off = setup({ tabs: [{ id: 'app', name: 'app', enabled: false, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }] }] })
    expect(await off.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toMatchObject({ error: 'MESSAGES_OFF' })
    const down = setup({ backendStatus: 500 })
    expect(await down.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toMatchObject({ error: 'DIRECTORY_UNAVAILABLE' })
  })

  it('limits how often one harness sends, and tells the windows', async () => {
    const t = setup()
    for (let i = 0; i < LIMITS.perSender; i++) await t.ask({ action: 'send', pane: '%1', to: 'api', text: `n${i}` })
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'one more' })).toMatchObject({ error: 'RATE_LIMITED' })
    expect(t.windows.some((w) => (w.payload as Record<string, unknown>).limited)).toBe(true)
    t.tick(LIMITS.window)
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'later' })).recipients).toBeDefined()
  })

  it('keeps a message for a machine that is away, and hands it over once it is back', async () => {
    vi.useFakeTimers()
    let away = true
    const calls: string[] = []
    const t = setup({ rpc: async (target, payload) => {
      calls.push(String(payload.action))
      if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      if (away) throw new MessageError(payload.action === 'deliver' && calls.length > 4 ? 'NO_PEER_LINK' : 'DISCONNECTED', 'away')
      if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'delivered', via: 'hook' }] }
      return { statuses: [] }
    } })
    t.service.start()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'when you are back' })
    expect(reply.recipients).toEqual([{ name: 'phone', state: 'queued', reason: 'that machine is away: it is handed over once it is back' }])
    away = false
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const history = await t.ask({ action: 'history' })
    expect((history.messages as Array<{ statuses: unknown[] }>)[0].statuses).toEqual([expect.objectContaining({ machineId: 'm2', agentId: 'phone', state: 'delivered', via: 'hook' })])
    t.service.stop()
  })
})

describe('from the owner\'s other machines', () => {
  const incoming = (to = 'api', from = { machineId: 'm2', agentId: 'phone' }) => ({
    id: 'm00000aa', tabId: 'app', text: 'from the phone', at: 5,
    from: { ...from, name: 'phone', engine: 'claude', machine: 'laptop' },
    to: [{ machineId: 'm1', agentId: to, name: to }],
  })

  it('delivers a message for one of this machine\'s agents that shares an on tab with the sender, once', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ messageId: 'm00000aa', machineId: 'm1', agentId: 'api', state: 'queued' })])
    expect(t.delivered).toHaveLength(1)
    // Handed over again after a lost reply: the same delivery, not a second.
    await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(t.delivered).toHaveLength(1)
    t.deliveryEvent({ deliveryId: t.delivered[0][2], sessionId: 'api', state: 'delivered' })
    expect(await t.ask({ action: 'status', ids: ['m00000aa', 'unknown'] }, OWNER_REMOTE)).toEqual({ statuses: [expect.objectContaining({ state: 'delivered', via: 'prompt' })] })
  })

  it('refuses a message for an agent outside the sender\'s tabs, and one that is not a message', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: incoming('web') }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'web', state: 'failed' })])
    expect(t.delivered).toHaveLength(0)
    expect(await t.ask({ action: 'deliver', message: { id: 'x' } }, OWNER_REMOTE)).toMatchObject({ error: 'INVALID_MESSAGE' })
  })

  it('names its agents for another machine, and only those it has', async () => {
    const t = setup()
    expect(await t.ask({ action: 'who', agentIds: ['api', 'ghost', 3] }, OWNER_REMOTE)).toEqual({ agents: [{ agentId: 'api', name: 'api', engine: 'claude', project: 'api' }] })
    expect(await t.ask({ action: 'who' }, OWNER_REMOTE)).toEqual({ agents: [] })
    expect(await t.ask({ action: 'status' }, OWNER_REMOTE)).toEqual({ statuses: [] })
  })
})

describe('the roster note and the directory', () => {
  it('puts the note in each agent\'s inbox once the tab has a teammate, and takes it back when the tab turns off', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const waiting = (pane: string) => {
      const dir = t.inbox.paneDir(pane)!
      try { return require('node:fs').readdirSync(dir) as string[] } catch { return [] }
    }
    expect(waiting('%1').some((n) => n.startsWith('0note-'))).toBe(true)
    expect(waiting('%2').some((n) => n.startsWith('0note-'))).toBe(true)
    // Web is in no tab with Agent Messages on: nothing.
    expect(waiting('%3')).toEqual([])
    // The hook took lead's note: it is not put again.
    const note = waiting('%1').find((n) => n.startsWith('0note-'))!.replace(/\.json$/, '')
    require('node:fs').mkdirSync(join(root, 'inbox-root', 'claimed'), { recursive: true })
    require('node:fs').renameSync(join(t.inbox.paneDir('%1')!, `${note}.json`), join(root, 'inbox-root', 'claimed', `1-${note}.json`))
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(waiting('%1')).toEqual([])
    // Turned off: the notes go.
    t.tabs[0].enabled = false
    t.notice({ type: 'desk_changed', revision: 5 })
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting('%2')).toEqual([])
    t.service.stop()
  })

  it('fails a waiting delivery once its tab turns Agent Messages off', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })
    t.deliveryEvent({ deliveryId: t.delivered[0][2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    t.tabs[0].enabled = false
    t.notice({ type: 'desk_changed', revision: 6 })
    await new Promise((settle) => setTimeout(settle, 0))
    const history = await t.ask({ action: 'history', limit: 10 })
    expect((history.messages as Array<{ id: string; statuses: Array<{ state: string; reason?: string }> }>).find((m) => m.id === reply.id)!.statuses[0])
      .toMatchObject({ state: 'failed', reason: 'Agent Messages were turned off in this tab' })
  })

  it('answers a failure it did not expect without saying more', async () => {
    const t = setup()
    const broken = startAgentMessages(fakeCore({ dataDir: root, agents: { live: () => { throw new Error('boom') } } }), { stateDir: join(root, 's2'), inboxRoot: join(root, 'i2') })
    expect(await broken.requests.agent_messages!({ action: 'send', pane: '%1', to: 'a', text: 'b' }, OWNER_LOCAL)).toEqual({ error: 'MESSAGES_UNAVAILABLE', detail: expect.any(String) })
    broken.stop()
    t.service.stop()
  })
})
