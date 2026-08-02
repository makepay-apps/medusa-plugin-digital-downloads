#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const wrapper = fileURLToPath(
  new URL("./run-command-with-timeout.mjs", import.meta.url),
)

const grandchildSource = `
  process.on("SIGINT", () => {})
  process.on("SIGTERM", () => {})
  process.stdout.write("READY\\n")
  setInterval(() => {}, 1_000)
`
const parentSource = `
  const { spawn } = require("node:child_process")
  process.stdout.write("PARENT:" + process.pid + "\\n")
  const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(
    grandchildSource,
  )}], { stdio: ["ignore", "pipe", "ignore"] })
  grandchild.stdout.once("data", () => {
    process.stdout.write("GRANDCHILD:" + grandchild.pid + "\\n")
  })
  process.on("SIGINT", () => process.exit(0))
  process.on("SIGTERM", () => process.exit(0))
  setInterval(() => {}, 1_000)
`

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    throw error
  }
}

function processIdentity(pid) {
  if (!processExists(pid)) return undefined
  const identity = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8" },
  )
  const group = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
  })
  if (identity.status !== 0 || group.status !== 0) return undefined
  const value = identity.stdout.trimEnd()
  const pgid = Number(group.stdout.trim())
  if (!value || !Number.isSafeInteger(pgid) || pgid < 1) return undefined
  return { value, pgid }
}

function exactIdentityMatches(pid, expected) {
  const current = processIdentity(pid)
  return Boolean(
    current &&
      expected &&
      current.value === expected.value &&
      current.pgid === expected.pgid,
  )
}

function killDirectChild(child, expected, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!exactIdentityMatches(child.pid, expected)) {
    throw new Error(`refusing to signal wrapper PID ${child.pid}: identity changed`)
  }
  child.kill(signal)
}

async function cleanupProbeGroup(state) {
  const candidates = [
    [state.parentPid, state.parentIdentity],
    [state.grandchildPid, state.grandchildIdentity],
  ].filter(([pid]) => pid && processExists(pid))
  if (!candidates.length) return
  if (!state.parentPid) {
    throw new Error("refusing process-group cleanup without the recorded parent PID")
  }
  const verified = candidates.some(
    ([pid, identity]) =>
      exactIdentityMatches(pid, identity) && identity.pgid === state.parentPid,
  )
  if (!verified) {
    throw new Error("refusing process-group cleanup after probe identity changed")
  }
  process.kill(-state.parentPid, "SIGKILL")
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (
      ![state.parentPid, state.grandchildPid].some(
        (pid) => pid && processExists(pid),
      )
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("probe process group survived identity-guarded SIGKILL")
}

async function runWrapper({
  timeout,
  commandArgs,
  signalAfterGrandchild,
  signalRepeats = 1,
}) {
  const child = spawn(
    process.execPath,
    [wrapper, String(timeout), process.execPath, ...commandArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const wrapperIdentity = processIdentity(child.pid)
  assert.ok(wrapperIdentity, "could not record timeout wrapper identity")
  let stdout = ""
  let stderr = ""
  let parentPid
  let parentIdentity
  let grandchildPid
  let grandchildIdentity
  let signalSent = false
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    stdout += chunk
    const parentMatch = /PARENT:(\d+)/.exec(stdout)
    if (parentMatch && !parentPid) {
      parentPid = Number(parentMatch[1])
      parentIdentity = processIdentity(parentPid)
    }
    const grandchildMatch = /GRANDCHILD:(\d+)/.exec(stdout)
    if (grandchildMatch && !grandchildPid) {
      grandchildPid = Number(grandchildMatch[1])
      grandchildIdentity = processIdentity(grandchildPid)
    }
    if (grandchildMatch && signalAfterGrandchild && !signalSent) {
      signalSent = true
      for (let index = 0; index < signalRepeats; index += 1) {
        setTimeout(() => child.kill(signalAfterGrandchild), index * 100)
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  try {
    const result = await new Promise((resolve, reject) => {
      const safety = setTimeout(() => {
        try {
          killDirectChild(child, wrapperIdentity, "SIGKILL")
        } catch (error) {
          reject(error)
          return
        }
        reject(new Error(`timeout-wrapper probe hung\n${stderr}`))
      }, 20_000)
      child.once("error", (error) => {
        clearTimeout(safety)
        reject(error)
      })
      child.once("close", (code, signal) => {
        clearTimeout(safety)
        resolve({ code, signal })
      })
    })
    return {
      ...result,
      stdout,
      stderr,
      parentPid,
      grandchildPid,
      parentSurvived: Boolean(parentPid && processExists(parentPid)),
      grandchildSurvived: Boolean(grandchildPid && processExists(grandchildPid)),
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      killDirectChild(child, wrapperIdentity, "SIGKILL")
    }
    await cleanupProbeGroup({
      parentPid,
      parentIdentity,
      grandchildPid,
      grandchildIdentity,
    })
  }
}

function assertProbeGroupGone(result) {
  assert.ok(result.parentPid, `probe did not report its parent\n${result.stderr}`)
  assert.ok(result.grandchildPid, `probe did not report a grandchild\n${result.stderr}`)
  assert.equal(result.parentSurvived, false, `parent ${result.parentPid} survived`)
  assert.equal(
    result.grandchildSurvived,
    false,
    `grandchild ${result.grandchildPid} survived`,
  )
}

const success = await runWrapper({
  timeout: 5,
  commandArgs: ["-e", "process.exit(0)"],
})
assert.equal(success.code, 0)
assert.equal(success.signal, null)

const timedOut = await runWrapper({
  timeout: 1,
  commandArgs: ["-e", parentSource],
})
assert.equal(timedOut.code, 124, timedOut.stderr)
assert.match(timedOut.stderr, /exceeded 1s deadline/)
assertProbeGroupGone(timedOut)

const interrupted = await runWrapper({
  timeout: 30,
  commandArgs: ["-e", parentSource],
  signalAfterGrandchild: "SIGTERM",
  signalRepeats: 2,
})
assert.equal(interrupted.code, 143, interrupted.stderr)
assertProbeGroupGone(interrupted)

process.stdout.write("Timeout wrapper process-group probes passed.\n")
