// Runs cover.sh (and through it fetch.sh) with a stub curl that serves the
// bytes in $STUB_FILE: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, utimesSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync, spawn } from "node:child_process"

const script = new URL("../cover.sh", import.meta.url).pathname
const NAME = "evt-U925QBQtzBf2iX3-full.webp"

// WebP headers as the spec lays them out; cover.sh reads only the first 30
// bytes, so a header plus padding stands in for a whole image.
const le = (n, bytes) => Array.from({ length: bytes }, (_, i) => (n >> (8 * i)) & 0xff)
const riff = (fourcc, payload) => Buffer.from([...Buffer.from("RIFF"), ...le(4 + 8 + payload.length, 4),
  ...Buffer.from("WEBP"), ...Buffer.from(fourcc), ...le(payload.length, 4), ...payload, ...new Array(64).fill(0)])
const vp8 = (w, h) => riff("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le(w, 2), ...le(h, 2)])
const vp8l = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14)
  return riff("VP8L", [0x2f, ...le(bits, 4)])
}
const vp8x = (w, h, flags = 0) => riff("VP8X", [flags, 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3)])
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "meetups-cover-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_LOG"
[ "\${STUB_EXIT:-0}" != 0 ] && exit "$STUB_EXIT"
out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
cat "$STUB_FILE" > "$out"
`)
  chmodSync(join(bin, "curl"), 0o755)
  // od reads the header inside cover.sh's lock, between the download and the
  // move. This stub notes when two runs are in there at once (mkdir is
  // atomic), which the lock forbids, and $OD_SLEEP keeps each one there.
  writeFileSync(join(bin, "od"), `#!/usr/bin/env bash
if [ -n "\${OD_SLEEP:-}" ]; then
  mkdir "$STUB_INSIDE" 2>/dev/null || echo overlap >> "$STUB_OVERLAP"
  sleep "$OD_SLEEP"
  rmdir "$STUB_INSIDE" 2>/dev/null
fi
exec ${spawnSync("bash", ["-c", "command -v od"], { encoding: "utf8" }).stdout.trim()} "$@"
`)
  chmodSync(join(bin, "od"), 0o755)
  const dir = join(root, "covers")
  const body = join(root, "body")
  const overlap = join(root, "overlap")
  const args = (name, age) => ["-c", `umask 022; exec bash "$0" "$@"`, script, dir, name,
    "https://omarchy.org/images/meetups/" + name, age, "1000000"]
  const env = extra => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(root, "log"), STUB_FILE: body,
    STUB_INSIDE: join(root, "inside"), STUB_OVERLAP: overlap, ...extra })
  const run = (bytes, extra = {}, age = "10080", name = NAME) => {
    writeFileSync(body, bytes)
    return spawnSync("bash", args(name, age), { env: env(extra), encoding: "utf8" }).status
  }
  const start = (extra = {}) => new Promise(done => spawn("bash", args(NAME, "0"), { env: env(extra) }).on("exit", done))
  return { dir, run, start, overlap, body, file: join(dir, NAME), incoming: join(dir, ".incoming") }
}

test("a still WebP of each kind is let through, privately", () => {
  for (const img of [vp8(800, 800), vp8l(800, 221), vp8x(2000, 2000), vp8(1, 1)]) {
    const s = sandbox()
    assert.equal(s.run(img), 0)
    assert.deepEqual(readFileSync(s.file), img)
    assert.equal(statSync(s.file).mode & 0o777, 0o600)
    assert.equal(statSync(s.dir).mode & 0o777, 0o700)
    assert.equal(statSync(s.incoming).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(s.incoming).filter(f => !f.startsWith(".")), [], "nothing left in incoming")
  }
})

test("anything but a still WebP of sane size never reaches the panel's folder", () => {
  const cases = {
    "a PNG named .webp": png,
    "a JPEG": Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]),
    "an animated WebP": vp8x(100, 100, 0x02),
    "too wide": vp8(2001, 10),
    "too tall (lossless)": vp8l(10, 2001),
    "too big (extended)": vp8x(16384, 16384),
    "a lossy WebP without its start code": riff("VP8 ", [0x10, 0x02, 0x00, 0, 0, 0, ...le(10, 2), ...le(10, 2)]),
    "a lossless WebP without its signature": riff("VP8L", [0, 0, 0, 0, 0]),
    "an unknown chunk": riff("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    "a WebP chunk without the RIFF header": Buffer.concat([Buffer.from("XXXX"), vp8(10, 10).subarray(4)]),
    "a RIFF file that isn't WebP": Buffer.concat([vp8(10, 10).subarray(0, 8), Buffer.from("AVI "), vp8(10, 10).subarray(12)]),
    "a short file": Buffer.from("RIFF"),
    "an empty file": Buffer.alloc(0),
    "HTML": Buffer.from("<html><body>not an image</body></html>".padEnd(64)),
  }
  for (const [what, bytes] of Object.entries(cases)) {
    const s = sandbox()
    assert.equal(s.run(bytes), 1, what)
    assert.ok(!existsSync(s.file), what)
    assert.deepEqual(readdirSync(s.incoming).filter(f => !f.startsWith(".")), [], `${what}: removed from incoming too`)
  }
})

test("a bad replacement or no network keeps the last good cover", () => {
  const s = sandbox()
  s.run(vp8(800, 800))
  assert.equal(s.run(png, {}, "0"), 0, "a cover is still ready")
  assert.deepEqual(readFileSync(s.file), vp8(800, 800))
  assert.equal(s.run(vp8(10, 10), { STUB_EXIT: "6" }, "0"), 0, "offline: the cached cover is still shown")
  assert.deepEqual(readFileSync(s.file), vp8(800, 800))
  const fresh = sandbox()
  assert.equal(fresh.run(vp8(10, 10), { STUB_EXIT: "6" }), 1, "offline with nothing cached: no cover")
})

test("a cached cover that fails the check is removed, not shown", () => {
  const s = sandbox()
  mkdirSync(s.dir, { recursive: true })
  writeFileSync(s.file, png)
  assert.equal(s.run(vp8(10, 10), { STUB_EXIT: "6" }), 1, "offline: no cover")
  assert.ok(!existsSync(s.file))
  writeFileSync(s.file, png)
  assert.equal(s.run(vp8(10, 10)), 0, "fresh by age, but fetched again")
  assert.deepEqual(readFileSync(s.file), vp8(10, 10))
})

test("a cover younger than the age limit isn't fetched again", () => {
  const s = sandbox()
  s.run(vp8(800, 800))
  assert.equal(s.run(vp8(10, 10)), 0)
  assert.deepEqual(readFileSync(s.file), vp8(800, 800), "kept")
  const old = Date.now() / 1000 - 8 * 86400
  utimesSync(s.file, old, old)
  assert.equal(s.run(vp8(10, 10)), 0)
  assert.deepEqual(readFileSync(s.file), vp8(10, 10), "a week old: fetched again")
})

test("refuses a name that isn't a plain .webp file name", () => {
  for (const bad of ["../x.webp", "x.png", "a/b.webp", ".webp", "x.webp\n", "-x.webp ", "x y.webp", "a".repeat(81) + ".webp"]) {
    const s = sandbox()
    assert.equal(s.run(vp8(10, 10), {}, "10080", bad), 1, JSON.stringify(bad))
    assert.ok(!existsSync(s.dir) || readdirSync(s.dir).length === 0, JSON.stringify(bad))
  }
})

test("two bars fetching the same cover never check and move it at the same time", async () => {
  const s = sandbox()
  writeFileSync(s.body, vp8(10, 10))
  const first = s.start({ OD_SLEEP: "0.6" })
  await new Promise(r => setTimeout(r, 200))
  const codes = await Promise.all([first, s.start({ OD_SLEEP: "0.6" })])
  assert.ok(!existsSync(s.overlap), "never two runs between the download and the move")
  assert.deepEqual(codes, [0, 2], "the second leaves it to the first")
  assert.deepEqual(readFileSync(s.file), vp8(10, 10))
})
