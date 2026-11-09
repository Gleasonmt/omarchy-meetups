.pragma library

// Pure logic for the Meetups widget: parsing the omarchy.org feed, measuring
// distance, choosing what to show. No QML here, so tests/model.test.mjs can
// run it under Node.

var KM_PER_MILE = 1.609344

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
    var start = Date.parse(e.start)
    var title = String(e.title || "").trim()
    var url = String(e.url || "")
    if (!title || isNaN(start) || !/^https:\/\//.test(url)) continue
    var end = Date.parse(e.end)
    var geo = e.geo && typeof e.geo === "object" ? e.geo : null
    var lat = geo ? parseFloat(geo.lat) : NaN
    var lon = geo ? parseFloat(geo.lon) : NaN
    events.push({
      id: String(e.id || url),
      title: title,
      url: url,
      start: start,
      end: isNaN(end) ? start + 2 * 3600 * 1000 : end,
      city: String(e.city || ""),
      country: String(e.country || ""),
      online: e.online === true,
      lat: isNaN(lat) ? null : lat,
      lon: isNaN(lon) ? null : lon
    })
  }
  return { ok: true, refreshed: String(data.refreshed || ""), events: events }
}

// weather.json, owned by omarchy-weather-location, and geo.omarchy.org both
// answer {"name", "latitude", "longitude"}. Missing coordinates mean unknown.
function parseLocation(raw) {
  var data
  try {
    data = JSON.parse(String(raw || ""))
  } catch (e) {
    return null
  }
  if (!data || typeof data !== "object") return null
  var lat = parseFloat(data.latitude)
  var lon = parseFloat(data.longitude)
  if (isNaN(lat) || isNaN(lon)) return null
  return { name: String(data.name || ""), lat: lat, lon: lon }
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

// Short form for the bar: how far away the meetup is, never a clock time, so
// it can't be mistaken for the bar's clock. "Now", "Tonight" (or "Today" for
// one before 5 PM), "Tomorrow", "in 3 days", "in 4 wks".
function barLabel(meetup, now) {
  if (!meetup) return ""
  if (meetup.start <= now) return "Now"
  var days = daysUntil(meetup.start, now)
  if (days === 0) return new Date(meetup.start).getHours() >= 17 ? "Tonight" : "Today"
  if (days === 1) return "Tomorrow"
  if (days < 14) return "in " + days + " days"
  return "in " + Math.round(days / 7) + " wks"
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
