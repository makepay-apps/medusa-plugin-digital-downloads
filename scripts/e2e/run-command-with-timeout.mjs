#!/usr/bin/env node

import { spawn } from "node:child_process"

const timeoutSeconds = Number(process.argv[2])
const command = process.argv[3]
const args = process.argv.slice(4)

if (
  !Number.isSafeInteger(timeoutSeconds) ||
  timeoutSeconds < 1 ||
  timeoutSeconds > 3_600 ||
  !command
) {
  process.stderr.write(
    "Usage: run-command-with-timeout.mjs <1-3600 seconds> <command> [args...]\n",
  )
  process.exit(2)
}

const child = spawn(command, args, {
  detached: true,
  env: process.env,
  stdio: "inherit",
})

const FORCE_AFTER_MS = 5_000
const VERIFY_AFTER_FORCE_MS = 5_000
const GROUP_POLL_MS = 50

let termination
let finalized = false
let forceTimer
let verificationTimer
let groupPoll

function signalGroup(signal) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

function groupExists() {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    if (error?.code === "EPERM") return true
    throw error
  }
}

function clearTerminationTimers() {
  if (forceTimer) clearTimeout(forceTimer)
  if (verificationTimer) clearTimeout(verificationTimer)
  if (groupPoll) clearInterval(groupPoll)
}

function finalize(code) {
  if (finalized) return
  finalized = true
  clearTimeout(deadline)
  clearTerminationTimers()
  process.off("SIGINT", handleInterrupt)
  process.off("SIGTERM", handleTerminate)
  process.exitCode = code
}

function finishWhenGroupIsGone() {
  if (!termination || finalized) return
  try {
    if (!groupExists()) finalize(termination.exitCode)
  } catch (error) {
    process.stderr.write(
      `Unable to inspect ${command} process group: ${error.message}\n`,
    )
  }
}

function beginTermination({ signal, exitCode, message }) {
  if (termination || finalized) return
  termination = { exitCode }
  clearTimeout(deadline)
  if (message) process.stderr.write(message)
  signalGroup(signal)

  // The direct child may exit while one of its descendants ignores the first
  // signal. Keep this wrapper alive until the entire detached process group is
  // gone; never cancel the force timer merely because the direct child exited.
  groupPoll = setInterval(finishWhenGroupIsGone, GROUP_POLL_MS)
  forceTimer = setTimeout(() => {
    signalGroup("SIGKILL")
    verificationTimer = setTimeout(() => {
      if (groupExists()) {
        signalGroup("SIGKILL")
        process.stderr.write(
          `Unable to verify termination of ${command} process group after SIGKILL\n`,
        )
        finalize(125)
        return
      }
      finalize(termination.exitCode)
    }, VERIFY_AFTER_FORCE_MS)
  }, FORCE_AFTER_MS)
  finishWhenGroupIsGone()
}

const deadline = setTimeout(() => {
  beginTermination({
    signal: "SIGTERM",
    exitCode: 124,
    message: `Command exceeded ${timeoutSeconds}s deadline: ${command}\n`,
  })
}, timeoutSeconds * 1_000)

function handleInterrupt() {
  beginTermination({ signal: "SIGINT", exitCode: 130 })
}

function handleTerminate() {
  beginTermination({ signal: "SIGTERM", exitCode: 143 })
}

process.on("SIGINT", handleInterrupt)
process.on("SIGTERM", handleTerminate)

child.once("error", (error) => {
  process.stderr.write(`Unable to start ${command}: ${error.message}\n`)
  finalize(127)
})

child.once("exit", (code, signal) => {
  clearTimeout(deadline)
  if (termination) {
    finishWhenGroupIsGone()
    return
  }
  if (signal) {
    process.stderr.write(`${command} exited after ${signal}\n`)
    finalize(128)
    return
  }
  finalize(code ?? 1)
})
