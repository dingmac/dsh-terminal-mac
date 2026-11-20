/**
 * Virtual Mac plugin for the terminal-mac guest: lifecycle tools plus the skill
 * that tells the model when to use the machine, how to drive it, and when to
 * shut it down.
 *
 * Registers start / stop / pause / resume / status on ctx.tools and embeds a
 * model-invocable skill through ctx.skills.register(), so the guidance ships
 * inside the plugin instead of a global skills directory.
 *
 * Approval is per call: pass `confirm: true` to a state-changing tool and the
 * call asks through tools/pre-execute; otherwise it runs directly. A deployment
 * can set `requireConfirm` to ask for every state change.
 *
 * Tool definitions are plain objects instead of `defineTool` from
 * `@deepseek-ai/dsh-tools`: a linked bundle cannot resolve that package, and a
 * ToolDefinition only needs JSON-Schema `parameters` plus `output`.
 *
 * @module @local/dsh-terminal-mac
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Cordis plugin name. */
export const name = 'terminal-mac'
/** The tool registry is required; the skill registry is injected optionally. */
export const inject = ['tools']

const PARAMETERS = { type: 'object', properties: {} }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Whether the lifecycle command exited successfully.' },
    state: { type: 'string', description: 'Virtual machine state reported by terminal-mac: running, stopped or paused.' },
    pid: { type: 'string', description: 'Host process id of the running virtual machine.' },
    message: { type: 'string', description: 'Failure detail when the command did not report JSON.' },
  },
  required: ['ok', 'state'],
}

function settings(config) {
  const c = config ?? {}
  const launcher = String(c.launcher ?? '~/.local/bin/terminal-mac')
  return {
    launcher: launcher.startsWith('~/') ? path.join(homedir(), launcher.slice(2)) : launcher,
    machine: String(c.machine ?? 'default'),
    requireConfirm: c.requireConfirm === true,
    startTimeoutMs: Number(c.startTimeoutMs ?? 180_000),
    stopTimeoutMs: Number(c.stopTimeoutMs ?? 180_000),
    pauseTimeoutMs: Number(c.pauseTimeoutMs ?? 30_000),
    resumeTimeoutMs: Number(c.resumeTimeoutMs ?? 120_000),
    statusTimeoutMs: Number(c.statusTimeoutMs ?? 30_000),
  }
}

/** Run the launcher once and settle with its output; caller cancellation terminates it. */
function run(launcher, args, timeoutMs, signal) {
  return new Promise((resolve) => {
    const child = execFile(launcher, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: Boolean(error?.killed),
      })
    })
    if (signal === undefined) return
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('exit', () => signal.removeEventListener('abort', onAbort))
  })
}

/** Fold a CLI result into the declared output shape. */
function settle(result, fallbackState) {
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    parsed = undefined
  }
  const value = {
    ok: result.ok,
    state: typeof parsed?.state === 'string' ? parsed.state : fallbackState,
  }
  if (typeof parsed?.pid === 'string') value.pid = parsed.pid
  if (!result.ok || parsed === undefined) {
    const detail = [
      result.timedOut ? 'command timed out' : 'command failed',
      result.stderr.trim(),
      result.stdout.trim(),
    ].filter((part) => part.length > 0).join('\n').slice(0, 2000)
    if (detail.length > 0) value.message = detail
  }
  return value
}

/** One-line model-visible rendering of a lifecycle result. */
function render(_args, value) {
  const text = value.ok
    ? `Virtual Mac is ${value.state}${value.pid === undefined ? '' : ` (pid ${value.pid})`}.`
    : `Lifecycle command failed; the machine reports ${value.state}.\n${value.message ?? ''}`
  return [{ type: 'text', text: text.trim() }]
}

/** Build one registry-ready tool definition. */
function definition(toolName, description, parameters, body) {
  return {
    name: toolName,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    execute: body,
  }
}

const CONFIRM = {
  type: 'boolean',
  description: 'Ask the user for approval before this state change. Without it the call runs directly; when the deployment forbids asking, a confirmed call fails instead of running.',
}

const FORCE = {
  type: 'boolean',
  description: 'Power the guest off immediately and skip the shutdown confirmation it would otherwise show. Unsaved guest work is lost.',
}

const CONFIRMS = { type: 'object', properties: { confirm: CONFIRM } }
const FORCE_AND_CONFIRM = { type: 'object', properties: { force: FORCE, confirm: CONFIRM } }

/**
 * Register the lifecycle tools and the embedded skill.
 * @param ctx - context providing the tool registry and, optionally, the skill registry.
 * @param config - launcher path, machine name, approval default and timeouts.
 */
export function apply(ctx, config) {
  const s = settings(config)

  /** Lifecycle commands print no state, so read the real one afterwards. */
  const currentState = async (signal) => {
    const result = await run(s.launcher, ['status', s.machine], s.statusTimeoutMs, signal)
    try {
      const parsed = JSON.parse(result.stdout.trim())
      if (typeof parsed?.state === 'string') return parsed.state
    } catch {
      // Status output is undocumented beyond the JSON the CLI already emits.
    }
    return undefined
  }

  const register = (toolName, description, timeout, argvFor, fallbackState, parameters = PARAMETERS) =>
    ctx.tools.register(definition(toolName, description, parameters, async (args, exec) => {
      const argv = argvFor(args ?? {})
      const value = settle(await run(s.launcher, argv, timeout(), exec.signal), fallbackState)
      if (argv[0] === 'status') return value
      const state = await currentState(exec.signal)
      if (state !== undefined) value.state = state
      return value
    }))

  register('terminal_mac_vm_status',
    'Report whether the virtual Mac is running, stopped or paused. Read-only; it never changes the machine.',
    () => s.statusTimeoutMs, () => ['status', s.machine], 'unknown')

  register('terminal_mac_vm_start',
    'Boot the virtual Mac after it was stopped. Takes tens of seconds; the guest signs itself in and its helper drives screen and input.',
    () => s.startTimeoutMs, () => ['start', s.machine], 'starting', CONFIRMS)

  register('terminal_mac_vm_stop',
    'Shut the virtual machine down and release the memory it holds. A normal stop asks the guest to shut down, so the guest may show its own shutdown confirmation; pass force to power it off immediately and skip that dialog.',
    () => s.stopTimeoutMs,
    (args) => args.force === true ? ['stop', s.machine, '--force'] : ['stop', s.machine],
    'stopping', FORCE_AND_CONFIRM)

  register('terminal_mac_vm_pause',
    'Pause the virtual Mac. Memory stays allocated; resume continues where it left off.',
    () => s.pauseTimeoutMs, () => ['pause', s.machine], 'pausing', CONFIRMS)

  register('terminal_mac_vm_resume',
    'Resume a paused virtual Mac. Use start instead when the machine is stopped.',
    () => s.resumeTimeoutMs, () => ['resume', s.machine], 'resuming')

  const guarded = new Map([
    ['terminal_mac_vm_start', { en: 'Start the virtual Mac and reserve its memory.', zh: '启动虚拟 Mac 并占用它的内存。' }],
    ['terminal_mac_vm_stop', { en: 'Shut down the virtual Mac; unsaved guest work may be lost.', zh: '关闭虚拟 Mac；客户机里未保存的内容可能丢失。' }],
    ['terminal_mac_vm_pause', { en: 'Pause the virtual Mac.', zh: '暂停虚拟 Mac。' }],
  ])

  ctx.on('tools/pre-execute', (exec, next) => {
    const displayReason = guarded.get(exec.name)
    if (displayReason === undefined) return next()
    const asked = exec.arguments?.confirm === true
    if (!asked && !s.requireConfirm) return next()
    return Promise.resolve({ kind: 'ask', reason: `terminal-mac: ${exec.name} on '${s.machine}'`, displayReason })
  })

  // The skill registry is optional: a profile without it keeps the tools working.
  ctx.inject(['skills'], (skillsCtx) => {
    try {
      const body = readFileSync(new URL('./skills/virtual-mac/SKILL.md', import.meta.url), 'utf8')
      skillsCtx.skills.register({
        name: 'virtual-mac',
        description: 'Drive an isolated macOS virtual machine when a task needs a real desktop GUI: start it, screenshot, click and type, then shut it down to free memory.',
        whenToUse: 'A task needs GUI work no command line can do, or must run risky desktop operations away from the user\'s own Mac.',
        content: body,
      })
    } catch (error) {
      console.warn(`terminal-mac: skill not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
