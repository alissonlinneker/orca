import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { sweepStaleAgentHookEndpointTemps } from '../agent-hook-endpoint-temp-cleanup'

// ─── Endpoint-file writing ──────────────────────────────────────────

export function getEndpointFileName(): string {
  // Why: per-platform extension lets hook scripts source the file natively (POSIX `. "$file"` / Windows `call "%file%"`); the OpenCode plugin regex accepts both shapes.
  return process.platform === 'win32' ? 'endpoint.cmd' : 'endpoint.env'
}

export function isShellSafeEndpointValue(value: string): boolean {
  // Why: values are shell-sourced; the + rejects empty strings so a sourced `KEY=` can't clear the env var.
  return /^[A-Za-z0-9._:/-]+$/.test(value)
}

export type EndpointFileFields = {
  port: number
  token: string
  env: string
  version: string
  transport?: string
  openCodeTui?: boolean
}

/** Atomically write the endpoint file at `endpointDir/<getEndpointFileName()>`.
 *  Returns true on success, false on error (caller may fall back to PTY env).
 *  Kept in sync with `AgentHookServer.writeEndpointFile`. */
export function writeEndpointFile(
  endpointDir: string,
  finalPath: string,
  fields: EndpointFileFields
): boolean {
  const tmpPath = join(endpointDir, `.endpoint-${process.pid}-${randomUUID()}.tmp`)
  const prefix = process.platform === 'win32' ? 'set ' : ''
  const valuesToWrite: [string, string][] = [
    ['ORCA_AGENT_HOOK_PORT', String(fields.port)],
    ['ORCA_AGENT_HOOK_TOKEN', fields.token],
    ['ORCA_AGENT_HOOK_ENV', fields.env],
    ['ORCA_AGENT_HOOK_VERSION', fields.version]
  ]
  if (fields.transport) {
    valuesToWrite.push(['ORCA_AGENT_HOOK_TRANSPORT', fields.transport])
  }
  if (fields.openCodeTui) {
    valuesToWrite.push(['ORCA_AGENT_HOOK_OPENCODE_TUI', '1'])
  }
  for (const [key, value] of valuesToWrite) {
    if (!isShellSafeEndpointValue(value)) {
      console.error(
        `[agent-hooks] refusing to write endpoint file: ${key} contains ` +
          'characters unsafe for shell sourcing. Falling back to PTY env.'
      )
      return false
    }
  }
  const lines = [...valuesToWrite.map(([key, value]) => `${prefix}${key}=${value}`), '']
  let tmpWritten = false
  try {
    // Why: 0o700 owner-only so the dir doesn't leak this install's existence to other local users.
    mkdirSync(endpointDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // Why: mkdirSync mode only applies on creation; chmod fixes perms on a pre-existing dir (POSIX-only).
      try {
        chmodSync(endpointDir, 0o700)
      } catch {
        // best-effort
      }
    }
    // Why: crash-orphan cleanup must not materialize a tampered, enormous directory.
    sweepStaleAgentHookEndpointTemps(endpointDir)
    const separator = process.platform === 'win32' ? '\r\n' : '\n'
    writeFileSync(tmpPath, lines.join(separator), { mode: 0o600 })
    tmpWritten = true
    renameSync(tmpPath, finalPath)
    return true
  } catch (err) {
    console.error('[agent-hooks] failed to write endpoint file:', err)
    if (tmpWritten) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp may already be gone
      }
    }
    return false
  }
}

const REUSABLE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Port and token a previous run published, when the file is still this user's and owner-only. */
export function readPublishedEndpoint(finalPath: string): { port: number; token: string } | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const stat = statSync(finalPath)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      return null
    }
    const values = new Map<string, string>()
    for (const line of readFileSync(finalPath, 'utf8').split('\n')) {
      const separator = line.indexOf('=')
      if (separator > 0) {
        values.set(line.slice(0, separator), line.slice(separator + 1).trim())
      }
    }
    const port = Number(values.get('ORCA_AGENT_HOOK_PORT'))
    const token = values.get('ORCA_AGENT_HOOK_TOKEN') ?? ''
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      !REUSABLE_TOKEN_PATTERN.test(token)
    ) {
      return null
    }
    return { port, token }
  } catch {
    return null
  }
}
