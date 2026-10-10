import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'

const disk = vi.hoisted(() => ({ held: true, pending: new Map<number, (error: Error | null) => void>() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  fsync: (fd: number, done: (error: Error | null) => void) => {
    if (disk.held) disk.pending.set(fd, done)
    else queueMicrotask(() => done(null))
  },
}))
let root: string
const drain = async () => { for (let n = 0; n < 80; n++) await Promise.resolve() }
async function release() {
  disk.held = false
  for (const done of disk.pending.values()) done(null)
  disk.pending.clear()
  await drain()
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-attempts-')))
  disk.held = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})
afterEach(async () => { await release(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

it('keeps the event loop available and retains the descriptor and reservation after its reply deadline', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const pending = runHookPreparation([file], attempt => inspectHookFile(file).replace('after', attempt), { timeoutMs: 20 }).catch(error => error)
  await drain()
  const fd = [...disk.pending.keys()][0]
  expect(fstatSync(fd).isFile()).toBe(true)
  let stopped = false
  setTimeout(() => { stopped = true }, 1)
  await vi.advanceTimersByTimeAsync(20)
  expect(stopped).toBe(true)
  expect((await pending).message).toMatch(/deadline/)
  expect(readFileSync(file, 'utf8')).toBe('before')
  expect(fstatSync(fd).isFile()).toBe(true)
  await expect(runHookPreparation([file], async () => true)).rejects.toThrow(/still owns/)
  await release()
  expect(() => fstatSync(fd)).toThrow()
  expect(readdirSync(root)).toEqual(['hooks'])
  expect(readFileSync(file, 'utf8')).toBe('before')
  await runHookPreparation([file], attempt => inspectHookFile(file).replace('recovered', attempt))
  expect(readFileSync(file, 'utf8')).toBe('recovered')
})

it('reserves aliases together, joins identical work, and prevents a superseded port from publishing', async () => {
  const file = join(root, 'hooks'), alias = join(root, 'alias'); writeFileSync(file, 'before'); symlinkSync(file, alias)
  const first = runHookPreparation([file], attempt => inspectHookFile(file).replace('old port', attempt), { identity: 'old port' }).catch(error => error)
  const duplicate = vi.fn(async () => true)
  const joined = runHookPreparation([alias], duplicate, { identity: 'old port' }).catch(error => error)
  await drain()
  expect(duplicate).not.toHaveBeenCalled()
  await expect(runHookPreparation([alias], async () => true, { identity: 'new port' })).rejects.toThrow(/still owns/)
  await release()
  expect((await first).message).toMatch(/owner changed/)
  expect((await joined).message).toMatch(/owner changed/)
  expect(readFileSync(file, 'utf8')).toBe('before')
})

it('rechecks the original caller after a flush without acknowledging or publishing for a closed owner', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  let current = true
  const prepared = runHookPreparation([file], attempt => inspectHookFile(file).replace('late', attempt), { current: () => current }).catch(error => error)
  await drain(); current = false; await release()
  expect((await prepared).message).toMatch(/owner changed/)
  expect(readFileSync(file, 'utf8')).toBe('before')
})

it('bounds actual outstanding flushes even after every reply has timed out', async () => {
  const replies: Promise<unknown>[] = []
  for (let n = 0; n < 16; n++) {
    const file = join(root, String(n)); writeFileSync(file, 'before')
    replies.push(runHookPreparation([file], async attempt => {
      const fd = openSync(file, 'r')
      try { await attempt.flush(fd) } finally { closeSync(fd) }
    }, { timeoutMs: 10 }).catch(error => error))
  }
  await drain()
  expect(disk.pending.size).toBe(16)
  await vi.advanceTimersByTimeAsync(10)
  await Promise.all(replies)
  await expect(runHookPreparation([join(root, 'overflow')], async () => true)).rejects.toThrow(/slots/)
  expect(disk.pending.size).toBe(16)
  await release()
  expect(await runHookPreparation([join(root, 'recovered')], async () => true)).toBe(true)
})
