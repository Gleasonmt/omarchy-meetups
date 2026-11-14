// Runs fetch.sh with a stub curl first on PATH: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, utimesSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync, spawn } from "node:child_process"

const script = new URL("../fetch.sh", import.meta.url).pathname

// A stub curl: writes $STUB_BODY to the -o file (or fails with $STUB_EXIT),
// logs its arguments, and can sleep to stand in for a slow download.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "meetups-fetch-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_LOG"
[ -n "\${STUB_SLEEP:-}" ] && sleep "$STUB_SLEEP"
[ "\${STUB_EXIT:-0}" != 0 ] && { printf partial > "\${@: -1}"; exit "$STUB_EXIT"; }
out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
printf '%s' "$STUB_BODY" > "$out"
`)
  chmodSync(join(bin, "curl"), 0o755)
  const dir = join(root, "cache")
  const log = join(root, "curl-args")
  const run = (env = {}, age = "0", bytes = "2000000", url = "https://example.org/meetups.json") =>
    spawnSync("bash", ["-c", `umask 022; exec bash "$0" "$@"`, script, dir, "meetups.json", url, age, bytes], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_BODY: '{"events":[]}', ...env },
      encoding: "utf8",
    })
  return { root, bin, dir, log, run, file: join(dir, "meetups.json") }
}

test("downloads into place, private under umask 022", () => {
  const s = sandbox()
  assert.equal(s.run().status, 0)
  assert.equal(readFileSync(s.file, "utf8"), '{"events":[]}')
  assert.equal(statSync(s.file).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(s.dir).filter(f => f.startsWith(".dl.")), [], "no temporary file left")
})

test("passes the byte cap, https-only and a deadline to curl", () => {
  const s = sandbox()
  s.run({}, "0", "4096")
  const args = readFileSync(s.log, "utf8").split("\n")
  assert.equal(args[args.indexOf("--max-filesize") + 1], "4096")
  assert.equal(args[args.indexOf("--proto") + 1], "=https")
  assert.ok(args.includes("--max-time"))
})

test("a failed download keeps the old copy and cleans up", () => {
  const s = sandbox()
  s.run({ STUB_BODY: "old" })
  assert.equal(s.run({ STUB_EXIT: "63" }).status, 1)
  assert.equal(readFileSync(s.file, "utf8"), "old")
  assert.deepEqual(readdirSync(s.dir).filter(f => f.startsWith(".dl.")), [])
})

test("a fresh enough copy isn't downloaded again", () => {
  const s = sandbox()
  s.run({ STUB_BODY: "first" })
  assert.equal(s.run({ STUB_BODY: "second" }, "360").status, 0)
  assert.equal(readFileSync(s.file, "utf8"), "first")
  const old = (Date.now() - 7 * 3600 * 1000) / 1000
  utimesSync(s.file, old, old)
  s.run({ STUB_BODY: "second" }, "360")
  assert.equal(readFileSync(s.file, "utf8"), "second")
})

test("refuses anything but https and non-numeric limits", () => {
  const s = sandbox()
  assert.equal(s.run({}, "0", "2000000", "http://example.org/x").status, 1)
  assert.equal(s.run({}, "0", "1e9").status, 1)
  assert.equal(existsSync(s.log), false, "curl never ran")
})

test("temporary files from a killed download are removed later", () => {
  const s = sandbox()
  s.run()
  const stale = join(s.dir, ".dl.abcdef")
  writeFileSync(stale, "x".repeat(1000))
  const old = (Date.now() - 10 * 60 * 1000) / 1000
  utimesSync(stale, old, old)
  s.run()
  assert.equal(existsSync(stale), false)
})

test("a second bar finds the download already running and leaves it", async () => {
  const s = sandbox()
  const env = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, STUB_LOG: s.log, STUB_BODY: "slow", STUB_SLEEP: "1" }
  const first = spawn("bash", [script, s.dir, "meetups.json", "https://example.org/m.json", "0", "2000000"], { env })
  await new Promise(r => setTimeout(r, 300))
  assert.equal(s.run().status, 2)
  await new Promise(r => first.on("exit", r))
  assert.equal(readFileSync(s.file, "utf8"), "slow")
})
