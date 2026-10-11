/**
 * Agent Messages (`collaboration`), an experiment: harnesses in a tab with Agent Messages on message each other
 * with `harness send` (messages/service.ts, docs/design/2026-10-10-agent-messages.md). It replaced Swarm
 * collaboration in the same slot, the teams' process, and keeps that slot's contract with the core: its typed
 * deliveries go through `core.turns.deliver` under `team:` ids, which the core writes only into an idle,
 * empty composer, and the core asks in line whether one may still be written (`canWrite`). So the core did not
 * change for it.
 * - The `agent_messages` request: `harness send` in an agent's pane, the owner's other machines, the windows.
 * - In the core's process (`HARNESSD_SERVICES=none`) it starts here, at once; in the teams' own process,
 *   services/collaborationProcess.ts starts the same service.
 */
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { startAgentMessages, type AgentMessages, type MessagesOptions } from '../messages/service.js'

/** The requests Agent Messages answers, declared in core/api.ts for the core to route. */
export { TEAMS_REQUESTS } from '../core/api.js'

export type TeamsOptions = MessagesOptions
export type Teams = AgentMessages

export function startCollaboration(core: CoreApi, options: TeamsOptions = {}): Teams {
  return startAgentMessages(core, options)
}

/**
 * Agent Messages in the core's process (`HARNESSD_SERVICES=none`). The core still records each prompt's swarm
 * scope into this port (core/input.ts, turns/funnel.ts) until that plumbing is removed: nothing reads it now.
 */
export function startTeamsInCore(core: CoreApi, ports: CorePorts, options: TeamsOptions = {}): ServiceRequests {
  const messages = startCollaboration(core, options)
  ports.teams = Object.assign({
    prepare: () => () => {}, started: () => {}, raw: () => {}, forget: () => {},
    canWrite: (deliveryId: string) => messages.canWrite(deliveryId),
  }, { stop: () => messages.stop() })
  messages.start()
  return messages.requests
}
