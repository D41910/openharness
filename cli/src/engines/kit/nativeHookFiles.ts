/** Hook preparation owns only a verified file version. Unknown contents are
 * never an empty configuration, and a completed write includes its directory. */
import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, fstatSync, fsync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'

export class HookPreparationHeld extends Error {
  constructor(detail: string) { super(`Hook preparation is waiting: ${detail}`); this.name = 'HookPreparationHeld' }
}
const version = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const fileIdentity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}`
export interface HookFilePublication { verify(): void }
const MAX_BYTES = 1024 * 1024
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function syncDirectory(path: string, attempt: HookPreparationAttempt): Promise<void> {
  attempt.check()
  const expected = fileIdentity(lstatSync(path, { bigint: true }))
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (fileIdentity(fstatSync(fd, { bigint: true })) !== expected) throw new HookPreparationHeld('the directory changed before sync')
    await attempt.flush(fd)
    if (fileIdentity(lstatSync(path, { bigint: true })) !== expected) throw new HookPreparationHeld('the directory changed during sync')
  } finally { closeSync(fd) }
}

/** Retry must also confirm names created before an earlier parent sync failed.
 * Seeing an existing ancestor cannot prove that its publication was durable. */
async function syncDirectoryChain(path: string, attempt: HookPreparationAttempt): Promise<void> {
  for (let depth = 0; depth < 256; depth++) {
    attempt.check(); await syncDirectory(path, attempt)
    if (path === '/') return
    path = dirname(path)
  }
  throw new HookPreparationHeld('the directory sync exceeds its path limit')
}

/** Create only absent directories. The final leaf-to-root flush confirms every name. Existing
 * aliases are resolved before use; no directory is chmodded or replaced. */
function ensureDirectory(path: string, attempt: HookPreparationAttempt): void {
  attempt.check()
  try {
    if (!lstatSync(path).isDirectory()) throw new HookPreparationHeld('the configuration directory changed type')
  } catch (error) {
    if (!missing(error)) throw error
    ensureDirectory(dirname(path), attempt)
    try { mkdirSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}

/** Resolve a missing descendant through a bounded, verified existing ancestor. */
function directoryPath(path: string): string {
  const suffix: string[] = []
  for (let depth = 0; depth < 256; depth++) {
    const route = new NativePaths(new NativeEvidenceBudget(250)).resolveSync(path, true)
    if (route) {
      if (!route.info.isDirectory()) throw new HookPreparationHeld('the configuration parent is not a directory')
      return join(route.path, ...suffix)
    }
    suffix.unshift(basename(path)); path = dirname(path)
  }
  throw new HookPreparationHeld('the configuration directory exceeds its path limit')
}

/** The result is local to one preparation attempt, not a settings cache.
 * A changed alias, owner, file or contents invalidates the whole observation. */
export function inspectHookFile(file: string, defaultMode = 0o666) {
  const paths = new NativePaths(new NativeEvidenceBudget(250))
  const located = paths.resolveSync(file, true)
  const facts = paths.snapshot()
  const directory = directoryPath(dirname(file))
  const target = located?.path ?? join(directory, basename(file))
  let before: string | null = null, content: string | null = null, mode = defaultMode
  if (located) {
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd, { bigint: true })
      if (!info.isFile() || info.size > MAX_BYTES || info.dev !== located.info.dev || info.ino !== located.info.ino
        || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) {
        throw new HookPreparationHeld('the settings file is not a bounded file owned by this account')
      }
      before = version(info); mode = Number(info.mode & 0o777n)
      const bytes = Buffer.alloc(Number(info.size))
      let offset = 0
      for (let reads = 0; offset < bytes.length; reads++) {
        if (reads >= 128) throw new HookPreparationHeld('the settings read exceeded its operation limit')
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!read) throw new HookPreparationHeld('the settings file changed while being read')
        offset += read
      }
      if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings file changed while being read')
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } finally { closeSync(fd) }
  }
  const verify = () => {
    verifyNativePathFacts(facts.filter(fact => fact.identity !== null))
    // Another destination in the same preparation may have created a shared
    // absent directory. New ordinary directories are fine; a newly inserted
    // alias is not authority to write at a different location.
    const fresh = new NativePaths(new NativeEvidenceBudget(250))
    fresh.resolveSync(file, true)
    const knownAliases = new Set(facts.filter(fact => fact.alias).map(fact => fact.path))
    if (fresh.snapshot().some(fact => fact.alias && !knownAliases.has(fact.path))) {
      throw new HookPreparationHeld('the settings route gained an unconfirmed alias')
    }
    let now: BigIntStats | null
    try { now = lstatSync(target, { bigint: true }) } catch (error) { if (!missing(error)) throw error; now = null }
    if ((now ? version(now) : null) !== before) throw new HookPreparationHeld('the settings file changed before publication')
  }
  const prepare = (next: string | null) => {
    verify()
    if (next !== null && Buffer.byteLength(next) > MAX_BYTES) throw new HookPreparationHeld('the prepared settings exceed their size limit')
    if (next === null && content !== null && lstatSync(file).isSymbolicLink()) throw new HookPreparationHeld('the plugin entry is an alias')
    if (content === next) return
    if (content !== null && next !== null && (mode & 0o200) === 0) throw new HookPreparationHeld('the settings file is read-only')
    let parent = dirname(target)
    for (let depth = 0; depth < 256; depth++) {
      const route = new NativePaths(new NativeEvidenceBudget(250)).resolveSync(parent, true)
      if (route) { accessSync(route.path, constants.W_OK | constants.X_OK); return }
      parent = dirname(parent)
    }
    throw new HookPreparationHeld('the configuration parent exceeds its path limit')
  }
  verify()
  return {
    content, directory, stamp: before,
    verify, prepare,
    async replace(next: string, attempt: HookPreparationAttempt): Promise<HookFilePublication> {
      attempt.check(); prepare(next)
      if (content === next) {
        // A previous rename may have succeeded before directory sync failed.
        // Equality alone cannot turn that uncertainty into a durable success.
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings changed before sync')
          await attempt.flush(fd)
          if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings changed during sync')
        } finally { closeSync(fd) }
        await syncDirectoryChain(dirname(target), attempt)
        verify()
        return { verify }
      }
      // Resolve an existing ancestor before creating descendants; this preserves
      // relocated config homes without following a replaced alias at publish.
      const parent = directoryPath(dirname(target))
      ensureDirectory(parent, attempt)
      const actual = join(parent, target.slice(dirname(target).length + 1))
      // Creation invalidates absent-ancestor facts; capture the new route and
      // still require the exact old leaf (or its observed absence).
      const fresh = inspectHookFile(actual)
      if (fresh.content !== content) throw new HookPreparationHeld('the settings changed while their directory was prepared')
      const temporary = join(parent, `.harness-hook-${randomUUID()}.tmp`)
      let fd: number | undefined
      let stagedIdentity: string | undefined
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
        stagedIdentity = fileIdentity(fstatSync(fd, { bigint: true }))
        writeFileSync(fd, next)
        await attempt.flush(fd)
        fresh.verify()
        // Retained existing ancestors/aliases must still name the original
        // route; only directories created above can replace an absent fact.
        verifyNativePathFacts(facts.filter(fact => fact.identity !== null))
        attempt.check()
        renameSync(temporary, actual)
        await syncDirectoryChain(parent, attempt)
        verifyNativePathFacts(facts.filter(fact => fact.identity !== null && fact.path !== target))
        const published = inspectHookFile(file)
        if (published.content !== next || published.stamp !== version(fstatSync(fd, { bigint: true }))) {
          throw new HookPreparationHeld('the published settings changed before confirmation')
        }
        return { verify: published.verify }
      } finally {
        try { if (fd !== undefined) closeSync(fd) } finally {
          try {
            if (fileIdentity(lstatSync(temporary, { bigint: true })) !== stagedIdentity) throw new HookPreparationHeld('the staging file changed before cleanup')
            unlinkSync(temporary)
          } catch (error) { if (!missing(error)) throw error }
        }
      }
    },
    async remove(attempt: HookPreparationAttempt): Promise<HookFilePublication> {
      attempt.check(); prepare(null)
      // Removing a discovered entry never authorizes deleting another profile's
      // shared target. A leaf alias requires the owner to resolve that conflict.
      if (content !== null && lstatSync(file).isSymbolicLink()) throw new HookPreparationHeld('the plugin entry is an alias')
      if (content !== null) unlinkSync(target)
      let parent = dirname(target)
      for (let depth = 0; depth < 256; depth++) {
        const route = new NativePaths(new NativeEvidenceBudget(250)).resolveSync(parent, true)
        if (route) { await syncDirectoryChain(route.path, attempt); break }
        parent = dirname(parent)
      }
      verifyNativePathFacts(facts.filter(fact => fact.identity !== null && fact.path !== target))
      const removed = inspectHookFile(file)
      if (removed.content !== null) throw new HookPreparationHeld('the removed plugin was recreated before confirmation')
      return { verify: removed.verify }
    },
  }
}


export interface HookPreparationAttempt {
  /** The original caller and deadline still authorize another effect. */
  check(): void
  /** Own the descriptor until the actual syscall settles, even after a reply timeout. */
  flush(fd: number): Promise<void>
}
export interface HookPreparationOptions {
  /** Join only the same port, executable, command and complete destination set. */
  identity?: string
  current?(): boolean
  timeoutMs?: number
}
interface PendingPreparation { identity?: string; keys: string[]; revoke(): void; reply: Promise<unknown> }
const pendingPreparations = new Set<PendingPreparation>()
const MAX_PREPARATIONS = 16

/** Disk waits remain in eager core code. Reservations survive a timeout until
 * actual I/O settles: a late fsync must never use a closed, recycled descriptor. */
export async function runHookPreparation<T>(files: readonly string[], work: (attempt: HookPreparationAttempt) => Promise<T>, options: HookPreparationOptions = {}): Promise<T> {
  if (!files.length || files.length > 32) throw new HookPreparationHeld('the destination set exceeds its limit')
  const keys = [...new Set(files.map(file => {
    const located = new NativePaths(new NativeEvidenceBudget(250)).resolveSync(file, true)
    return located?.path ?? join(directoryPath(dirname(file)), basename(file))
  }))].sort()
  const conflicts = [...pendingPreparations].filter(pending => pending.keys.some(key => keys.includes(key)))
  if (conflicts.length) {
    const same = conflicts.length === 1 && options.identity !== undefined && conflicts[0].identity === options.identity
      && JSON.stringify(conflicts[0].keys) === JSON.stringify(keys)
    if (same) return await conflicts[0].reply as T
    for (const pending of conflicts) pending.revoke()
    throw new HookPreparationHeld('another preparation still owns these destinations')
  }
  if (pendingPreparations.size >= MAX_PREPARATIONS) throw new HookPreparationHeld('the disk preparation slots are occupied')
  const deadline = performance.now() + (options.timeoutMs ?? 5_000)
  let revoked = false
  const check = () => {
    if (revoked || performance.now() >= deadline || options.current?.() === false) {
      throw new HookPreparationHeld('the preparation expired or its owner changed')
    }
  }
  const attempt: HookPreparationAttempt = {
    check,
    async flush(fd) {
      check()
      await new Promise<void>((done, reject) => fsync(fd, error => error ? reject(error) : done()))
      check()
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending: PendingPreparation = { identity: options.identity, keys, revoke: () => { revoked = true }, reply: Promise.resolve() }
  pendingPreparations.add(pending)
  // Dispatch only after the reservation is visible. A timeout ends the caller's
  // wait; the finally below runs only when the actual work (and its FDs) finishes.
  const actual = Promise.resolve().then(() => { check(); return work(attempt) }).then(result => { check(); return result }).finally(() => {
    pendingPreparations.delete(pending)
    clearTimeout(timer)
  })
  pending.reply = Promise.race([actual, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { revoked = true; reject(new HookPreparationHeld('disk confirmation exceeded its deadline')) }, options.timeoutMs ?? 5_000)
  })])
  return await pending.reply as T
}
