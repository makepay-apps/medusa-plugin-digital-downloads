#!/usr/bin/env node

import { constants, closeSync, openSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

const logPath = process.argv[2]
const command = process.argv[3]
const args = process.argv.slice(4)

if (!logPath || !path.isAbsolute(logPath) || !command) {
  process.stderr.write(
    "Usage: launch-detached.mjs /absolute/path/to/log command [args...]\n",
  )
  process.exit(2)
}

let logFd
try {
  logFd = openSync(
    logPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  )

  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  })

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })

  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw new Error("detached child did not receive a valid PID")
  }

  child.unref()
  process.stdout.write(`${child.pid}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Unable to launch detached command: ${message}\n`)
  process.exitCode = 1
} finally {
  if (logFd !== undefined) closeSync(logFd)
}
