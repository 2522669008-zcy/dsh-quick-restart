/**
 * Host half of dsh-quick-restart.
 *
 * Job: expose one local route that the Web UI's restart button calls. The route does NOT
 * restart anything itself — it hands the work to a script that lives outside the app.
 *
 * Two layers, both needed:
 *
 *   1. `launch.ps1` — runs inside the app's Windows job, and its only job is to create
 *      the restarter through WMI (`Win32_Process.Create`). All of the app's processes
 *      share a job object (measured on this host), jobs are inherited by children, and a
 *      kill-on-close job would take a plain child down together with the app. A
 *      WMI-created process is a child of WmiPrvSE.exe, so it is not in that job
 *      (measured: inJob = false) and survives.
 *
 *   2. `restart.ps1` — outside the job. Waits, closes every process whose executable
 *      equals `process.execPath`, waits until they are all gone, then starts the app.
 *
 * Safety: the restart only ever targets processes whose executable path equals
 * `process.execPath` AND that sit beside an Electron `resources` directory. Under plain
 * `dsh web` (node.exe) the plugin reports `available: false` and refuses to act, so a
 * stray click can never kill every Node process on the machine.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis diagnostic name. */
export const name = 'quick-restart'

/**
 * No hard service dependency: `webServer` is attached lazily through `ctx.inject`, so
 * this plugin can never delay or fail the host boot.
 */
export const inject = []

/** The one route the Web UI calls. Must match `client.js`. */
export const ROUTE = '/dsh-quick-restart'

/** Creates the restarter outside the app's job object. */
const LAUNCH_PATH = fileURLToPath(new URL('./launch.ps1', import.meta.url))

/** The restarter itself. Referenced only for diagnostics. */
const RESTART_PATH = fileURLToPath(new URL('./restart.ps1', import.meta.url))

/** Where `restart.ps1` writes its trail. */
const LOG_PATH = path.join(os.tmpdir(), 'dsh-quick-restart.log')

/** Seconds `restart.ps1` waits before touching the process list. */
const DEFAULT_DELAY_SECONDS = 1

/** Upper bound for the launcher call; WMI answers in about a second. */
const LAUNCH_TIMEOUT_MS = 20000

/** @param {unknown} error @returns {string} */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The desktop executable, or `undefined` when this host is not the desktop app.
 * @returns {{ exe: string | undefined, reason: string }}
 */
function desktopExecutable() {
  const exe = process.execPath
  const base = path.basename(exe).toLowerCase()
  // Bare interpreters are never the desktop app. This is the guard that matters: the
  // script kills every process whose path equals execPath, so mis-detecting a plain
  // `node` host would kill unrelated Node work on the machine.
  if (base === 'node.exe' || base === 'node' || base === 'dsh' || base === 'dsh.exe') {
    return { exe: undefined, reason: `execPath is a bare interpreter (${exe})` }
  }
  // An Electron app keeps its unpacked resources beside the executable. Checked with
  // existsSync on purpose: inside Electron, fs.statSync treats the .asar archive as a
  // directory, so isFile() on it is not a usable test.
  const resources = path.join(path.dirname(exe), 'resources')
  if (!fs.existsSync(resources)) {
    return { exe: undefined, reason: `no resources directory beside the executable: ${resources}` }
  }
  return { exe, reason: `desktop app (electron ${process.versions?.electron ?? 'unknown'})` }
}

/**
 * Ask `launch.ps1` to create the restarter outside the job object.
 * @param {string} exePath absolute desktop executable path
 * @param {boolean} dryRun log the plan without killing anything
 * @param {(result: { ok: boolean, pid?: number, error?: string }) => void} done
 */
function launchRestart(exePath, dryRun, done) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    LAUNCH_PATH,
    '-ExePath',
    exePath,
    '-DelaySeconds',
    String(DEFAULT_DELAY_SECONDS),
  ]
  if (dryRun) args.push('-DryRun')

  execFile(
    'powershell.exe',
    args,
    { windowsHide: true, timeout: LAUNCH_TIMEOUT_MS, cwd: os.tmpdir() },
    (error, stdout, stderr) => {
      const tail = String(stderr ?? '').trim()
      const line = String(stdout ?? '')
        .trim()
        .split(/\r?\n/u)
        .filter((entry) => entry.trim() !== '')
        .pop()
      if (line !== undefined) {
        try {
          const parsed = JSON.parse(line)
          if (parsed && typeof parsed === 'object') {
            done(parsed)
            return
          }
        } catch {
          /* fall through to the error below */
        }
      }
      const reason = error ? describe(error) : 'launcher produced no JSON result'
      done({ ok: false, error: tail === '' ? reason : `${reason} / ${tail}` })
    },
  )
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function replyJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const detected = desktopExecutable()
  const exePath = detected.exe
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* logging must never be a failure path */
    }
  }

  if (exePath === undefined) {
    warn(`desktop executable not detected (${detected.reason}); the restart route stays unavailable`)
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() =>
      child.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          const method = String(req.method ?? 'GET').toUpperCase()
          let dryRun = false
          try {
            dryRun = new URL(req.url ?? '/', 'http://localhost').searchParams.get('dry') === '1'
          } catch {
            dryRun = false
          }

          if (method === 'GET' || method === 'HEAD') {
            replyJson(res, 200, {
              ok: true,
              available: exePath !== undefined,
              exe: exePath ?? null,
              reason: detected.reason,
              runningFrom: process.execPath,
              launcher: LAUNCH_PATH,
              script: RESTART_PATH,
              log: LOG_PATH,
              delaySeconds: DEFAULT_DELAY_SECONDS,
            })
            return
          }

          if (method !== 'POST') {
            replyJson(res, 405, { ok: false, error: 'use POST to restart, GET for status' })
            return
          }

          if (exePath === undefined) {
            replyJson(res, 409, {
              ok: false,
              error: `not running as the desktop app; refusing to restart (${detected.reason})`,
              runningFrom: process.execPath,
            })
            return
          }

          // Answer only after the out-of-job restarter exists, so the browser never shows
          // a success for a restart that was never created.
          launchRestart(exePath, dryRun, (result) => {
            if (result.ok === true) {
              replyJson(res, 200, {
                ok: true,
                dryRun,
                pid: result.pid,
                script: RESTART_PATH,
                log: LOG_PATH,
              })
              return
            }
            warn(`restart launcher failed: ${result.error}`)
            replyJson(res, 500, { ok: false, error: result.error ?? 'launcher failed', log: LOG_PATH })
          })
        },
      }),
    )
  })

  try {
    ctx.logger?.info?.(
      `[${name}] ${exePath === undefined ? 'inactive (not the desktop app)' : `ready: POST ${ROUTE}`}`,
    )
  } catch {
    /* ignore */
  }
}
