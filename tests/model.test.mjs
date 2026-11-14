// Runs Model.js under Node: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

process.env.TZ = "America/Chicago"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*$/m, "")
const M = {}
vm.runInNewContext(source, M)
// Objects made inside the vm context have their own prototypes; compare plain copies.
const plain = x => JSON.parse(JSON.stringify(x))

const feed = (events, extra = {}) => JSON.stringify({ source: "luma-api", refreshed: "2026-11-08", events, ...extra })
const frisco = { lat: 33.1551055, lon: -96.830513 }
const carrollton = { name: "Carrollton", lat: 32.95373, lon: -96.89028 }
const dfw = {
  id: "evt-dfw", title: "Omarchy DFW 001", url: "https://luma.com/dfw",
  start: "2026-11-10T00:00:00.000Z", end: "2026-11-10T02:00:00.000Z",
  city: "Frisco", country: "US", online: false, geo: frisco
}
const austin = { ...dfw, id: "evt-atx", title: "Omarchy Austin", url: "https://luma.com/atx",
  start: "2026-12-01T00:00:00.000Z", end: "2026-12-01T02:00:00.000Z", city: "Austin",
  geo: { lat: 30.2649261, lon: -97.7474086 } }
const online = { ...dfw, id: "evt-web", title: "Online hangout", url: "https://luma.com/web",
  start: "2026-11-20T00:00:00.000Z", end: "2026-11-20T01:00:00.000Z", city: "", online: true, geo: null }

test("parseFeed keeps valid events and drops broken ones", () => {
  const raw = feed([dfw, { title: "No link", start: dfw.start }, { ...dfw, url: "javascript:alert(1)" }, null, { ...dfw, start: "soon" }])
  const parsed = M.parseFeed(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.refreshed, "2026-11-08")
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].city, "Frisco")
})

test("parseFeed survives garbage and a changed shape", () => {
  assert.deepEqual(plain(M.parseFeed("not json").events), [])
  assert.equal(M.parseFeed("{}").ok, false)
  assert.equal(M.parseFeed(JSON.stringify({ events: "nope" })).ok, false)
})

test("parseLocation reads weather.json and geo.omarchy.org", () => {
  assert.deepEqual(plain(M.parseLocation('{"name":"Carrollton","latitude":32.95373,"longitude":-96.89028,"country":"US"}')),
    { name: "Carrollton", lat: 32.95373, lon: -96.89028 })
  // A name-only location (what `omarchy-weather-location --set Malibu` writes)
  // is a location to respect, just one without coordinates.
  assert.deepEqual(plain(M.parseLocation('{"name":"Malibu"}')), { name: "Malibu", lat: null, lon: null })
  assert.equal(M.hasCoordinates(M.parseLocation('{"name":"Malibu"}')), false)
  assert.equal(M.parseLocation('{"latitude":"x"}'), null)
  assert.equal(M.parseLocation('[1,2]'), null)
  assert.equal(M.hasCoordinates(M.parseLocation('{"name":"Bad","latitude":95,"longitude":10}')), false, "out-of-range latitude")
  assert.equal(M.parseLocation(""), null)
})

test("distance from Carrollton to the Frisco venue is about 23 km", () => {
  const km = M.distanceKm(carrollton.lat, carrollton.lon, frisco.lat, frisco.lon)
  assert.ok(km > 22 && km < 24, String(km))
})

test("upcoming filters by radius, sorts, and keeps a meetup until it ends", () => {
  const events = M.parseFeed(feed([austin, dfw, online])).events
  const beforeDfw = Date.parse("2026-11-09T20:00:00Z")
  let list = M.upcoming(events, carrollton, 50, "mi", false, beforeDfw)
  assert.deepEqual(plain(list.map(e => e.id)), ["evt-dfw"])
  list = M.upcoming(events, carrollton, 300, "mi", true, beforeDfw)
  assert.deepEqual(plain(list.map(e => e.id)), ["evt-dfw", "evt-web", "evt-atx"])
  const duringDfw = Date.parse("2026-11-10T01:00:00Z")
  assert.equal(M.upcoming(events, carrollton, 50, "mi", false, duringDfw).length, 1)
  const afterDfw = Date.parse("2026-11-10T03:00:00Z")
  assert.equal(M.upcoming(events, carrollton, 50, "mi", false, afterDfw).length, 0)
})

test("radius in km is smaller than the same number in miles", () => {
  const events = M.parseFeed(feed([dfw])).events
  const now = Date.parse("2026-11-09T20:00:00Z")
  assert.equal(M.upcoming(events, carrollton, 20, "mi", false, now).length, 1)
  assert.equal(M.upcoming(events, carrollton, 20, "km", false, now).length, 0)
})

test("no location means only online meetups can show", () => {
  const events = M.parseFeed(feed([dfw, online])).events
  const now = Date.parse("2026-11-09T20:00:00Z")
  assert.deepEqual(plain(M.upcoming(events, null, 100, "mi", true, now).map(e => e.id)), ["evt-web"])
})

test("tonight's 6 PM Central meetup, stored as Nov 10 UTC, is tonight in local time", () => {
  const meetup = M.upcoming(M.parseFeed(feed([dfw])).events, carrollton, 50, "mi", false, Date.parse("2026-11-09T15:00:00Z"))[0]
  assert.equal(M.barLabel(meetup, Date.parse("2026-11-09T15:00:00Z")), "Tonight")
  assert.equal(M.barLabel(meetup, Date.parse("2026-11-08T15:00:00Z")), "Tomorrow")
  assert.equal(M.barLabel(meetup, Date.parse("2026-11-06T15:00:00Z")), "in 3 days")
  assert.equal(M.barLabel(meetup, Date.parse("2026-10-12T15:00:00Z")), "in 4 wks")
  assert.equal(M.barLabel(meetup, Date.parse("2026-11-10T00:30:00Z")), "Now")
  const lunch = { ...meetup, start: Date.parse("2026-11-09T18:00:00Z") }
  assert.equal(M.barLabel(lunch, Date.parse("2026-11-09T15:00:00Z")), "Today", "a noon meetup isn't tonight")
  assert.equal(M.detailLine(meetup, "mi"), "Mon Nov 9 · 6 PM · Frisco · 14 mi")
})

test("formatDistance and formatTime", () => {
  assert.equal(M.formatDistance(null, "mi"), "Online")
  assert.equal(M.formatDistance(123.4, "km"), "123 km")
  assert.equal(M.formatTime(Date.parse("2026-11-09T18:30:00-06:00")), "6:30 PM")
  assert.equal(M.formatTime(Date.parse("2026-11-09T00:05:00-06:00")), "12:05 AM")
})

test("only meetups starting within the look-ahead window are listed", () => {
  const events = M.parseFeed(feed([dfw, austin])).events
  const now = Date.parse("2026-11-09T15:00:00Z")
  assert.deepEqual(plain(M.upcoming(events, carrollton, 300, "mi", false, now, 90).map(e => e.id)), ["evt-dfw", "evt-atx"])
  assert.deepEqual(plain(M.upcoming(events, carrollton, 300, "mi", false, now, 14).map(e => e.id)), ["evt-dfw"])
  assert.deepEqual(plain(M.upcoming(events, carrollton, 300, "mi", false, now).map(e => e.id)), ["evt-dfw", "evt-atx"], "defaults to 90 days")
})

test("cyclePreset steps through presets both ways and wraps", () => {
  const p = [25, 50, 100, 300, 500, 1000]
  assert.equal(M.cyclePreset(300, p, 1), 500)
  assert.equal(M.cyclePreset(300, p, -1), 100)
  assert.equal(M.cyclePreset(1000, p, 1), 25)
  assert.equal(M.cyclePreset(25, p, -1), 1000)
  assert.equal(M.cyclePreset(150, p, 1), 300, "a hand-set value steps to the next preset")
  assert.equal(M.cyclePreset(150, p, -1), 100)
})

test("every string from the network is capped, so a huge field can't stall the shell", () => {
  const huge = "x".repeat(5_000_000)
  const parsed = M.parseFeed(feed([{ ...dfw, title: huge, city: huge, country: huge, id: huge }], { refreshed: huge }))
  const e = parsed.events[0]
  assert.equal(e.title.length, M.MAX_TEXT)
  assert.equal(e.city.length, M.MAX_SHORT)
  assert.equal(e.country.length, M.MAX_SHORT)
  assert.equal(e.id.length, M.MAX_SHORT)
  assert.equal(parsed.refreshed.length, M.MAX_SHORT)
  assert.equal(M.parseLocation(JSON.stringify({ name: huge, latitude: 1, longitude: 2 })).name.length, M.MAX_SHORT)
  assert.equal(M.parseFeed(feed([{ ...dfw, url: "https://luma.com/" + huge }])).events.length, 0, "an over-long link is dropped, not cut")
})

test("hostile names and coordinates don't break parsing", () => {
  const parsed = M.parseFeed(feed([{ ...dfw, title: "<img src=x onerror=alert(1)>", id: "__proto__", geo: { lat: 200, lon: 0 } }]))
  assert.equal(parsed.events[0].title, "<img src=x onerror=alert(1)>", "kept as text; the panel shows it as plain text")
  assert.equal(parsed.events[0].lat, null, "latitude 200 is not a place")
})

test("settings set from a terminal without --json still work", () => {
  assert.equal(M.toBool(true), true)
  assert.equal(M.toBool("true"), true)
  assert.equal(M.toBool("false"), false)
  assert.equal(M.toBool(false), false)
  assert.equal(M.clampInt("500", 5, 5000, 300), 500)
  assert.equal(M.clampInt(99999, 5, 5000, 300), 5000)
  assert.equal(M.clampInt("lots", 5, 5000, 300), 300)
})
