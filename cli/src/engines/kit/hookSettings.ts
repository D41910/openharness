/**
 * The one installer of the engines' declared hook settings (facets/hooks.ts `HookSettings`): Harness's block
 * merged into the settings file an engine reads its hooks from, every other block left as it was.
 *
 * It runs eagerly before launch. Unknown files are held, foreign commands are
 * preserved, and hook and approval destinations are inspected before publication.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import type { HookSettings } from '../facets/hooks.js'
import { prepareReviewed } from './hookReview.js'
import { command, HOOK_SCRIPT, isOurs, foreignHookBlocks, type Settings } from './notifyHooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation, type HookPreparationOptions } from './nativeHookFiles.js'

/** The engines whose hooks run the notify.mjs command. */
export type HookEngine = Parameters<typeof command>[1]

/** The home an engine's settings are in when core names none. */
export function defaultHookHome(settings: HookSettings): string {
  return 'setting' in settings.home ? env[settings.home.setting] : join(homedir(), settings.home.inHome)
}

export async function installHookSettings(engine: HookEngine, settings: HookSettings, port: number, home: string = defaultHookHome(settings), options: HookPreparationOptions = {}): Promise<boolean> {
  const file = join(home, settings.file)
  const say = (line: string): string => line.replace(/\{(file|script|port)\}/g, (_, name: string) =>
    name === 'file' ? file : name === 'script' ? HOOK_SCRIPT : String(port))
  const { messages } = settings
  try { return await runHookPreparation([file, ...(settings.reviewed ? [join(home, settings.reviewed.file)] : [])], async attempt => {
    const observed = inspectHookFile(file)
    const current = (observed.content === null ? {} : JSON.parse(observed.content)) as Settings
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks)))) {
      throw new HookPreparationHeld('the hook settings do not have the declared object shape')
    }
    current.hooks ??= {}
    const cmd = command(port, engine, settings.commandNamesHome ? home : undefined)
    let changed = false
    let updated = false // true when an EXISTING block's command changed (path/port drift)

    for (const { event, matcher } of settings.events) {
      if (current.hooks[event] !== undefined && !Array.isArray(current.hooks[event])) throw new HookPreparationHeld('a hook event is not a list')
      const blocks = current.hooks[event] ?? []
      // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and keep every
      // non-ours block untouched.
      const foreign = foreignHookBlocks(blocks)
      const ours = blocks.filter(isOurs)
      if (ours.length !== 1) changed = true // none yet, or duplicates to drop
      const existing = ours[0]
      if (existing) {
        // A prior block with a different command (moved checkout / dev↔dist / changed port / interpreter) is
        // overwritten in place by the canonical one below.
        const existingCmd = settings.upToDate.command === 'first-ours'
          ? existing.hooks?.find((h) => isOurs({ hooks: [h] }))?.command
          : existing.hooks?.[0]?.command
        if (existingCmd !== cmd) { changed = true; updated = true }
        if (settings.upToDate.matcher && existing.matcher !== matcher) changed = true
      }
      current.hooks[event] = [...foreign, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: settings.timeout }] }]
    }

    const next = changed ? JSON.stringify(current, null, 2) + '\n' : observed.content!
    const reviewed = settings.reviewed ? prepareReviewed(settings.reviewed, home, file, JSON.parse(next) as Settings) : null
    reviewed?.verify()
    if (!changed) {
      const published = await observed.replace(next, attempt)
      console.log(say(messages.current))
      // Installed by an earlier start, or by a release before the engine asked: recorded now, as the file has it.
      const approval = await reviewed?.commit(attempt)
      published.verify(); approval?.verify()
      return true
    }

    const published = await observed.replace(next, attempt)
    console.log(say(updated && messages.updated ? messages.updated : messages.installed))
    console.log(say(messages.after))
    const approval = await reviewed?.commit(attempt)
    published.verify(); approval?.verify()
    return true
  }, { identity: JSON.stringify([engine, settings, port, home]), ...options }) } catch (err) {
    console.error(say(messages.failed), err)
    return false
  }
}
