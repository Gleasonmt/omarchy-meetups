// Runs remind.sh with a stub omarchy-notification-send first on PATH: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, utimesSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync, spawn } from "node:child_process"

const script = new URL("../remind.sh", import.meta.url).pathname
const KEY = "0123456789abcdef0123456789abcdef"

// The stub appends its arguments, one per line, then "--" to $STUB_LOG.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "meetups-remind-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "omarchy-notification-send"), `#!/usr/bin/env bash
[ -n "\${STUB_SLEEP:-}" ] && sleep "$STUB_SLEEP"
{ printf '%s\\n' "$@"; echo --; } >> "$STUB_LOG"
# Stand-in for the shell being killed mid-send: the whole process group goes.
if [ -n "\${STUB_KILL:-}" ]; then kill -9 0; fi
`)
  chmodSync(join(bin, "omarchy-notification-send"), 0o755)
  // find runs inside the lock, just before the check. This stub notes when
  // two runs are in there at once (mkdir is atomic), which the lock forbids,
  // and $FIND_SLEEP keeps each one there long enough to collide without it.
  writeFileSync(join(bin, "find"), `#!/usr/bin/env bash
if [ -n "\${FIND_SLEEP:-}" ]; then
  mkdir "$STUB_INSIDE" 2>/dev/null || echo overlap >> "$STUB_OVERLAP"
  sleep "$FIND_SLEEP"
  rmdir "$STUB_INSIDE" 2>/dev/null
fi
exec ${spawnSync("bash", ["-c", "command -v find"], { encoding: "utf8" }).stdout.trim()} "$@"
`)
  chmodSync(join(bin, "find"), 0o755)
  const dir = join(root, "state", "reminded")
  const log = join(root, "sent")
  const overlap = join(root, "overlap")
  const env = extra => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log,
    STUB_INSIDE: join(root, "inside"), STUB_OVERLAP: overlap, ...extra })
  const args = (key = KEY) => ["-c", `umask 022; exec setsid -w bash "$0" "$@"`, script, dir, key, "Omarchy meetup tomorrow", "Body", "--exec", "omarchy-launch-browser", "https://luma.com/x"]
  const run = (key, extra = {}) => spawnSync("bash", args(key), { env: env(extra), encoding: "utf8" })
  const start = (key, extra = {}) => new Promise(done => spawn("bash", args(key), { env: env(extra) }).on("exit", done))
  const sent = () => existsSync(log) ? readFileSync(log, "utf8").split("--\n").filter(Boolean) : []
  return { dir, run, start, sent, overlap }
}

test("sends once, passing the arguments through unchanged", () => {
  const s = sandbox()
  assert.equal(s.run().status, 0)
  assert.equal(s.run().status, 0)
  assert.deepEqual(s.sent(), ["Omarchy meetup tomorrow\nBody\n--exec\nomarchy-launch-browser\nhttps://luma.com/x\n"])
})

test("different reminders are each sent", () => {
  const s = sandbox()
  s.run(KEY)
  s.run("f".repeat(32))
  assert.equal(s.sent().length, 2)
})

test("two bars asking at the same moment send one notification", async () => {
  const s = sandbox()
  const codes = await Promise.all([s.start(KEY, { FIND_SLEEP: "0.3" }), s.start(KEY, { FIND_SLEEP: "0.3" }), s.start(KEY, { FIND_SLEEP: "0.3" })])
  assert.deepEqual(codes, [0, 0, 0])
  assert.equal(s.sent().length, 1)
  assert.ok(!existsSync(s.overlap), "never two runs between the check and the record")
})

test("records are private under umask 022", () => {
  const s = sandbox()
  s.run()
  assert.equal(statSync(s.dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(s.dir, KEY)).mode & 0o777, 0o600)
  assert.equal(statSync(join(s.dir, ".lock")).mode & 0o777, 0o600)
})

test("refuses a key that isn't 32 hex characters", () => {
  const s = sandbox()
  for (const bad of ["../../etc/passwd", "", "ABCDEF0123456789ABCDEF0123456789", KEY + "0", KEY.slice(1), "-" + KEY.slice(1)]) {
    assert.equal(s.run(bad).status, 1, bad)
  }
  assert.deepEqual(s.sent(), [])
  assert.ok(!existsSync(s.dir) || readdirSync(s.dir).every(f => f === ".lock"))
})

test("records older than 60 days are removed, newer ones kept", () => {
  const s = sandbox()
  const old = "a".repeat(32), recent = "b".repeat(32)
  mkdirSync(s.dir, { recursive: true })
  writeFileSync(join(s.dir, old), "")
  writeFileSync(join(s.dir, recent), "")
  writeFileSync(join(s.dir, "notes.txt"), "")
  const past = Date.now() / 1000 - 61 * 86400
  utimesSync(join(s.dir, old), past, past)
  utimesSync(join(s.dir, "notes.txt"), past, past)
  s.run()
  assert.ok(!existsSync(join(s.dir, old)))
  assert.ok(existsSync(join(s.dir, recent)))
  assert.ok(existsSync(join(s.dir, "notes.txt")), "only its own records are touched")
})

test("the record is written before sending: killed mid-send, it is never sent again", () => {
  const s = sandbox()
  s.run(KEY, { STUB_KILL: "1" })
  assert.equal(s.sent().length, 1, "the first attempt reached the sender")
  assert.equal(s.run().status, 0)
  assert.equal(s.sent().length, 1, "no second notification")
})
