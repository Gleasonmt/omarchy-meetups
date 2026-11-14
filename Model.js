.pragma library

// Pure logic for the Meetups widget: parsing the omarchy.org feed, measuring
// distance, choosing what to show. No QML here, so tests/model.test.mjs can
// run it under Node.

var KM_PER_MILE = 1.609344

// Every string from the network is cut to a length the panel can show, so a
// huge field can't stall the shell laying it out. Real titles run to about 80
// characters; links longer than MAX_URL are dropped rather than cut.
var MAX_TEXT = 200
var MAX_SHORT = 80
var MAX_URL = 2048

function text(value, max) {
  return String(value === undefined || value === null ? "" : value).slice(0, max).trim()
}

function coordinate(value, limit) {
  var n = parseFloat(value)
  return isNaN(n) || Math.abs(n) > limit ? null : n
}

// The feed is omarchy.org's own data file, not a promised API, so read it
// defensively: anything without a title, a link and a start time is dropped,
// and a changed shape gives an empty list rather than an error.
function parseFeed(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return { ok: false, refreshed: "", events: [] }
  }
  var list = data && Array.isArray(data.events) ? data.events : null
  if (!list) return { ok: false, refreshed: "", events: [] }
  var events = []
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (!e || typeof e !== "object") continue
    var start = Date.parse(text(e.start, MAX_SHORT))
    var title = text(e.title, MAX_TEXT)
    var url = String(e.url || "")
    if (!title || isNaN(start) || url.length > MAX_URL || !/^https:\/\//.test(url)) continue
    var end = Date.parse(text(e.end, MAX_SHORT))
    var geo = e.geo && typeof e.geo === "object" ? e.geo : null
    var lat = geo ? coordinate(geo.lat, 90) : null
    var lon = geo ? coordinate(geo.lon, 180) : null
    events.push({
      id: text(e.id, MAX_SHORT) || url,
      title: title,
      url: url,
      start: start,
      end: isNaN(end) ? start + 2 * 3600 * 1000 : end,
      city: text(e.city, MAX_SHORT),
      country: text(e.country, MAX_SHORT),
      online: e.online === true,
      lat: lat === null || lon === null ? null : lat,
      lon: lat === null || lon === null ? null : lon
    })
  }
  return { ok: true, refreshed: text(data.refreshed, MAX_SHORT), events: events }
}

// weather.json, owned by omarchy-weather-location, and geo.omarchy.org both
// answer {"name", "latitude", "longitude"}. A name with no coordinates is a
// location too (`omarchy-weather-location --set Malibu` writes one, and the
// Weather panel honours it), just one distances can't be measured from: it
// comes back with lat and lon null. Nothing usable at all gives null.
function parseLocation(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  var name = text(data.name, MAX_SHORT)
  var lat = coordinate(data.latitude, 90)
  var lon = coordinate(data.longitude, 180)
  var located = lat !== null && lon !== null
  if (!located && !name) return null
  return { name: name, lat: located ? lat : null, lon: located ? lon : null }
}

function hasCoordinates(location) {
  return !!location && location.lat !== null && location.lon !== null
}

// Settings set with `omarchy bar set` but without --json arrive as text.
function toBool(value) {
  return value === true || value === "true"
}

function clampInt(value, min, max, fallback) {
  var n = Math.round(Number(value))
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function distanceKm(lat1, lon1, lat2, lon2) {
  var r = 6371.0088
  var toRad = Math.PI / 180
  var dLat = (lat2 - lat1) * toRad
  var dLon = (lon2 - lon1) * toRad
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)))
}

function toKm(value, unit) {
  return unit === "km" ? value : value * KM_PER_MILE
}

function fromKm(km, unit) {
  return unit === "km" ? km : km / KM_PER_MILE
}

// Upcoming meetups within the radius that start in the next `days` days,
// soonest first. A meetup stays listed until it ends, so tonight's is still
// there while it runs. Online meetups have no distance and are included only
// when asked for.
function upcoming(events, origin, radius, unit, includeOnline, now, days) {
  var radiusKm = toKm(Math.max(0, Number(radius) || 0), unit)
  var horizon = now + Math.max(1, Number(days) || 90) * 86400000
  var out = []
  for (var i = 0; i < events.length; i++) {
    var e = events[i]
    if (e.end <= now || e.start > horizon) continue
    var km = null
    if (e.online) {
      if (!includeOnline) continue
    } else {
      if (!origin || e.lat === null || e.lon === null) continue
      km = distanceKm(origin.lat, origin.lon, e.lat, e.lon)
      if (km > radiusKm) continue
    }
    out.push({
      id: e.id, title: e.title, url: e.url, start: e.start, end: e.end,
      city: e.city, country: e.country, online: e.online,
      distance: km === null ? null : fromKm(km, unit)
    })
  }
  out.sort(function(a, b) { return a.start - b.start })
  return out
}

function formatDistance(distance, unit) {
  if (distance === null || distance === undefined) return "Online"
  var n = distance < 10 ? Math.round(distance * 10) / 10 : Math.round(distance)
  return n + " " + (unit === "km" ? "km" : "mi")
}

function startOfDay(ms) {
  var d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Whole calendar days from now to the meetup, in local time: 0 is today.
function daysUntil(start, now) {
  return Math.round((startOfDay(start) - startOfDay(now)) / 86400000)
}

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function formatTime(ms) {
  var d = new Date(ms)
  var h = d.getHours()
  var m = d.getMinutes()
  var suffix = h < 12 ? "AM" : "PM"
  var h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + (m ? ":" + (m < 10 ? "0" : "") + m : "") + " " + suffix
}

function formatDate(ms) {
  var d = new Date(ms)
  return DAYS[d.getDay()] + " " + MONTHS[d.getMonth()] + " " + d.getDate()
}

// "Tonight" for a meetup that starts from 5 PM, else "Today".
function todayWord(meetup) {
  return new Date(meetup.start).getHours() >= 17 ? "Tonight" : "Today"
}

// Short form for the bar: how far away the meetup is, never a clock time, so
// it can't be mistaken for the bar's clock. "Now", "Tonight" (or "Today" for
// one before 5 PM), "Tomorrow", then whole days ("in 3 days", "in 45 days"):
// exact, where weeks would round.
function barLabel(meetup, now) {
  if (!meetup) return ""
  if (meetup.start <= now) return "Now"
  var days = daysUntil(meetup.start, now)
  if (days === 0) return todayWord(meetup)
  if (days === 1) return "Tomorrow"
  return "in " + days + " days"
}

// One line under a meetup's title: "Mon Nov 9 · 6 PM · Frisco · 12 mi".
function detailLine(meetup, unit) {
  var parts = [formatDate(meetup.start), formatTime(meetup.start)]
  if (meetup.online) parts.push("Online")
  else {
    if (meetup.city) parts.push(meetup.city)
    parts.push(formatDistance(meetup.distance, unit))
  }
  return parts.join(" · ")
}

// The preset after (direction 1) or before (-1) the current value, wrapping
// around. A value between presets steps to the nearest one that way.
function cyclePreset(current, presets, direction) {
  var v = Number(current)
  if (direction < 0) {
    for (var i = presets.length - 1; i >= 0; i--) if (presets[i] < v) return presets[i]
    return presets[presets.length - 1]
  }
  for (var j = 0; j < presets.length; j++) if (presets[j] > v) return presets[j]
  return presets[0]
}

// The same distance in the other unit, rounded to the 5 the setting steps in,
// so switching miles to km keeps the area you chose (300 mi becomes 485 km).
function convertRadius(radius, from, to) {
  var r = clampInt(radius, 5, 5000, 300)
  if (from === to) return r
  var v = to === "km" ? r * KM_PER_MILE : r / KM_PER_MILE
  return clampInt(Math.round(v / 5) * 5, 5, 5000, 300)
}

// Reminders: one the day before and one on the day, each from 9 AM local
// time (or within 3 hours of an early start). "" when none is due. A meetup
// that has started gets none.
var REMIND_HOUR = 9
function reminderDue(meetup, now) {
  if (!meetup || meetup.start <= now) return ""
  var days = daysUntil(meetup.start, now)
  var morning = new Date(now).getHours() >= REMIND_HOUR
  if (days === 0) return morning || meetup.start - now <= 3 * 3600000 ? "today" : ""
  if (days === 1) return morning ? "tomorrow" : ""
  return ""
}

// A notification body is markup to the notification service, so text from
// the feed is escaped and always shows as written.
function escapeMarkup(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Headline (plain text, our own words) and body (markup) for a reminder.
function reminderText(meetup, kind, unit) {
  var when = kind === "tomorrow" ? "tomorrow" : todayWord(meetup).toLowerCase()
  return {
    headline: "Omarchy meetup " + when,
    body: escapeMarkup(meetup.title) + "\n" + escapeMarkup(detailLine(meetup, unit))
  }
}
