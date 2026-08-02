#!/usr/bin/env node

import assert from "node:assert/strict"
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const launcher = fileURLToPath(new URL("./launch-detached.mjs", import.meta.url))
const probeRoot = mkdtempSync(
  path.join(tmpdir(), "makepay-digital-downloads-detached-"),
)
const logPath = path.join(probeRoot, "probe.log")

function processIdentity(pid) {
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "pgid=", "-o", "command="],
    { encoding: "utf8" },
  )
  if (result.status !== 0 || !result.stdout.trim()) return undefined
  return result.stdout.trimEnd()
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

let probePid
let probeIdentity
try {
  const launched = spawnSync(
    process.execPath,
    [
      launcher,
      logPath,
      process.execPath,
      "-e",
      'process.stdout.write("READY\\n"); setInterval(() => {}, 1000)',
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
  assert.equal(launched.status, 0, launched.stderr)
  assert.match(launched.stdout, /^[1-9][0-9]*\n$/)
  probePid = Number(launched.stdout.trim())
  probeIdentity = processIdentity(probePid)
  assert.ok(probeIdentity, "detached probe exited with its launcher")

  await waitFor(
    () => {
      try {
        return readFileSync(logPath, "utf8").includes("READY")
      } catch {
        return false
      }
    },
    "detached probe readiness",
  )

  const currentIdentity = processIdentity(probePid)
  assert.equal(currentIdentity, probeIdentity, "detached probe identity changed")
  const fields = currentIdentity.trim().split(/\s+/)
  const processGroup = Number(fields[5])
  assert.equal(
    processGroup,
    probePid,
    "detached probe did not become its own process-group leader",
  )
  assert.equal(lstatSync(logPath).mode & 0o777, 0o600)
} finally {
  if (probePid && probeIdentity && processIdentity(probePid) === probeIdentity) {
    process.kill(probePid, "SIGTERM")
    await waitFor(
      () => processIdentity(probePid) === undefined,
      "detached probe cleanup",
    ).catch(() => {
      if (processIdentity(probePid) === probeIdentity) {
        process.kill(probePid, "SIGKILL")
      }
    })
  }
  chmodSync(probeRoot, 0o700)
  rmSync(probeRoot, { recursive: true, force: true })
}

process.stdout.write("Detached launcher survival and cleanup probe passed.\n")
