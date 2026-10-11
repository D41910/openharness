/** Native hook installation is eager. Optional transcript and screen readers own no hook files. */
import { join } from 'node:path'
import { runHookPreparation, type HookPreparationOptions, type HookPreparationProof } from './kit/nativeHookFiles.js'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN, OPENCODE_LEGACY_REMOVAL, OPENCODE_VERSION } from './opencode/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { PI_EXTENSION } from './pi/contract.js'
import { AMP_PLUGIN } from './amp/contract.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { opencodeMajorVersion, type OpencodeLaunchSnapshot } from './launchControl.js'
import { installNativePlugin, prepareNativePlugin, prepareNativePluginRemoval } from './kit/nativePlugin.js'
import { installNativeYamlHooks } from './kit/nativeHookYaml.js'
import { command } from './kit/notifyHooks.js'
import { GROK_HOOK_SETTINGS } from './grok/contract.js'
import { AGY_HOOK_SETTINGS } from './agy/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { DEVIN_HOOK_SETTINGS } from './devin/contract.js'
import { installNativeHookSettings } from './kit/nativeHookSettings.js'

export const installGrokHooks = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativeHookSettings(GROK_HOOK_SETTINGS, port, options)
export const installAgyHooks = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativeHookSettings(AGY_HOOK_SETTINGS, port, options)
export const installCopilotHooks = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativeHookSettings(COPILOT_HOOK_SETTINGS, port, options)
export const installCursorHooks = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativeHookSettings(CURSOR_HOOK_SETTINGS, port, options)
export const installCommandCodeHooks = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativeHookSettings(COMMANDCODE_HOOK_SETTINGS, port, options)
export const installDevinHooks = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativeHookSettings(DEVIN_HOOK_SETTINGS, port, options)

const pluginValues = (port: number) => ({
  port: String(port), credential: JSON.stringify(join(env.ADAPTER_DATA_DIR, 'hook-credential')), version: JSON.stringify(VERSION),
})
export const installKiloPlugin = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativePlugin(KILO_PLUGIN, pluginValues(port), options)
export const installPiExtension = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativePlugin(PI_EXTENSION, pluginValues(port), options)
export const installAmpPlugin = (port: number, options?: HookPreparationOptions): Promise<boolean> => installNativePlugin(AMP_PLUGIN, pluginValues(port), options)
export const installHermesHooks = (port: number, selectedHome?: string, options?: HookPreparationOptions): Promise<boolean> =>
  installNativeYamlHooks(HERMES_HOOK_SETTINGS, home => command(port, 'hermes', env.CODEX_HOME, home), selectedHome, options)

/** Install both discovery surfaces for v1; v2 must not load our incompatible v1 export. */
interface OpencodeInstallation { port: number; executable?: string; major?: number | null; done: Promise<boolean>; proofs: HookPreparationProof[] }
let opencodeInstallation: OpencodeInstallation | undefined
export async function installOpencodePlugin(port: number, snapshot?: OpencodeLaunchSnapshot, options: HookPreparationOptions = {}): Promise<boolean> {
  const deadline = performance.now() + (options.timeoutMs ?? OPENCODE_VERSION.timeoutMs)
  const installation: OpencodeInstallation = { port, executable: snapshot?.identity, done: Promise.resolve(false), proofs: [] }
  opencodeInstallation = installation
  installation.done = (async () => {
    const values = pluginValues(port)
    const major = snapshot ? snapshot.major : await opencodeMajorVersion()
    installation.major = major
    // A newer request may have installed an upgraded/downgraded engine's hooks
    // while this probe waited. Only the latest request can change those files.
    if (installation !== opencodeInstallation || snapshot?.current() === false) return false
    // Keep the existing first-install route until installer-only continuation
    // can return through launch preparation. A missing executable also gives
    // null here; refusing it would prevent create from reaching its installer.
    // Whole-launch preparation must confirm a version before native dispatch.
    try { return await runHookPreparation([OPENCODE_LEGACY_PLUGIN.file, OPENCODE_TUI_PLUGIN.file], async attempt => {
      // Inspect both destinations before publishing. A foreign legacy plugin
      // cannot authorize even the first half of an upgrade's writes.
      const legacy = major === 1 ? prepareNativePlugin(OPENCODE_LEGACY_PLUGIN, values) : prepareNativePluginRemoval(OPENCODE_LEGACY_REMOVAL)
      const tui = prepareNativePlugin(OPENCODE_TUI_PLUGIN, values)
      legacy.verify(); tui.verify()
      const removedOrInstalled = await legacy.commit(attempt), installed = await tui.commit(attempt)
      removedOrInstalled.verify(); installed.verify()
      return snapshot?.current() !== false
    }, { ...options, timeoutMs: Math.max(0, deadline - performance.now()), confirmed: proof => installation.proofs.push(proof), identity: JSON.stringify([port, snapshot?.identity, major]),
      current: () => opencodeInstallation?.port === port && opencodeInstallation.executable === installation.executable
        && opencodeInstallation.major === major && performance.now() < deadline && snapshot?.current() !== false && options.current?.() !== false }) } catch (error) {
      console.error('[hooks] OpenCode preparation held:', error)
      return false
    }
  })()
  let current = installation, installed = await current.done
  while (current !== opencodeInstallation) {
    current = opencodeInstallation!
    // Two healthy creates must not fail merely because they overlap. Follow the
    // current installation without restoring an obsolete request's write rights.
    // A port change or continuing churn cannot make this caller wait forever.
    const remaining = deadline - performance.now()
    if (current.port !== port || current.executable !== installation.executable || snapshot?.current() === false || options.current?.() === false || remaining <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([current.done, new Promise<'timeout'>(done => {
        timer = setTimeout(() => done('timeout'), remaining)
      })])
      if (result === 'timeout') return false
      installed = result
    } finally { clearTimeout(timer) }
  }
  if (!installed || performance.now() >= deadline || options.current?.() === false || snapshot?.current() === false || current.proofs.some(proof => !proof.current())) return false
  if (performance.now() >= deadline) return false
  for (const proof of current.proofs) options.confirmed?.(proof)
  return true
}
