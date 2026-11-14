import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "gleasonmt.meetups"
  ipcTarget: "gleasonmt.meetups"
  manageIpc: false

  // ---- Settings (inline on the bar entry in shell.json) ---------------------

  readonly property string unit: setting("unit", "mi") === "km" ? "km" : "mi"
  // Ranges match manifest.json. Values may arrive as strings from
  // `omarchy bar set` without --json, so read them leniently.
  readonly property int radius: Model.clampInt(setting("radius", 300), 5, 5000, 300)
  readonly property int days: Model.clampInt(setting("days", 90), 7, 365, 90)
  readonly property bool includeOnline: Model.toBool(setting("includeOnline", false))
  readonly property bool hideWhenNone: Model.toBool(setting("hideWhenNone", false))
  readonly property bool reminders: Model.toBool(setting("reminders", true))

  // ---- Data -----------------------------------------------------------------

  // omarchy.org's meetup list, refreshed there from its Luma calendar.
  readonly property string feedUrl: "https://raw.githubusercontent.com/omacom/omarchy-site/master/src/data/meetups.json"
  readonly property string cacheDir: (Quickshell.env("XDG_CACHE_HOME") || (Quickshell.env("HOME") + "/.cache")) + "/gleasonmt-meetups"
  // The list changes a few times a week; every bar on every monitor shares
  // one cached copy, refreshed when it is older than this.
  readonly property int feedMaxAgeMinutes: 360
  readonly property int geoMaxAgeMinutes: 1440

  property var feed: ({ ok: false, refreshed: "", events: [] })
  property bool feedLoaded: false
  property bool fetchFailed: false

  // Where you are: Omarchy's Weather location when one is set
  // (omarchy-weather-location). Distances need its coordinates; a location
  // set by name only is respected, not replaced, so the widget then asks you
  // to add coordinates. Only with no Weather location at all does it ask
  // geo.omarchy.org where this network is, the lookup the Weather panel makes.
  property var configuredLocation: null
  property var detectedLocation: null
  property bool configuredLoaded: false
  readonly property bool usingWeatherLocation: configuredLocation !== null
  readonly property bool weatherLocationNeedsCoordinates: usingWeatherLocation && !Model.hasCoordinates(configuredLocation)
  readonly property var origin: usingWeatherLocation
    ? (Model.hasCoordinates(configuredLocation) ? configuredLocation : null)
    : detectedLocation

  property double now: Date.now()

  readonly property var meetups: Model.upcoming(feed.events, origin, radius, unit, includeOnline, now, days)
  readonly property var next: meetups.length > 0 ? meetups[0] : null
  readonly property string barLabel: Model.barLabel(next, now)

  // ---- Panel cursor ---------------------------------------------------------

  // Rows, top to bottom: the meetups (or, when there are none, "Host one"),
  // "All meetups", then the settings: Distance, Look ahead, Units, Online
  // meetups, Reminders.
  property int rowIndex: 0
  property bool cursorActive: false
  readonly property int maxRows: 8
  readonly property int shownMeetups: Math.min(meetups.length, maxRows)
  readonly property bool showHost: shownMeetups === 0
  readonly property int hostRow: showHost ? 0 : -1
  readonly property int allRow: shownMeetups + (showHost ? 1 : 0)
  readonly property int distanceRow: allRow + 1
  readonly property int daysRow: allRow + 2
  readonly property int unitRow: allRow + 3
  readonly property int onlineRow: allRow + 4
  readonly property int remindRow: allRow + 5
  readonly property int rowCount: allRow + 6

  readonly property var distancePresets: unit === "km" ? [50, 100, 250, 500, 1000] : [25, 50, 100, 300, 500, 1000]
  readonly property var dayPresets: [14, 30, 90, 180, 365]

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function openUrl(url) {
    if (!/^https:\/\//.test(String(url))) return
    Quickshell.execDetached(["omarchy-launch-browser", url])
    root.close()
  }

  function activateRow(i, direction) {
    if (i < shownMeetups) openUrl(meetups[i].url)
    else if (i === hostRow) openUrl(hostUrl)
    else if (i === allRow) openUrl("https://omarchy.org/meetups/")
    else if (i === distanceRow) setSetting("radius", Model.cyclePreset(radius, distancePresets, direction || 1))
    else if (i === daysRow) setSetting("days", Model.cyclePreset(days, dayPresets, direction || 1))
    else if (i === unitRow) switchUnit()
    else if (i === onlineRow) setSetting("includeOnline", !includeOnline)
    else if (i === remindRow) setSetting("reminders", !reminders)
  }

  // The Omarchy calendar on Luma, where a new meetup is submitted.
  readonly property string hostUrl: "https://luma.com/omarchy"

  // Miles to km and back keeps the same area: the distance is converted and
  // saved first, then the unit, one after the other so neither write is lost.
  function switchUnit() {
    var to = unit === "km" ? "mi" : "km"
    Quickshell.execDetached(["bash", "-c",
      'omarchy-bar set "$0" radius "$1" --json && omarchy-bar set "$0" unit "$2" --json',
      "gleasonmt.meetups", String(Model.convertRadius(radius, unit, to)), JSON.stringify(to)])
  }

  // Settings live on this widget's entry in shell.json. omarchy-bar writes it
  // the same way `omarchy bar set` does, and the shell hands the new value
  // straight back through `settings`.
  // --json stores the number as a number, as the manifest's schema says,
  // rather than as text.
  function setSetting(key, value) {
    Quickshell.execDetached(["omarchy-bar", "set", "gleasonmt.meetups", key, JSON.stringify(value), "--json"])
  }

  // fetch.sh, next to this file. The feed is 63 KB today; 2 MB leaves years of
  // growth, and parseFeed caps every field, so even a full 2 MB stays cheap.
  readonly property string fetchScript: decodeURIComponent(String(Qt.resolvedUrl("fetch.sh")).replace(/^file:\/\//, ""))
  readonly property string feedMaxBytes: "2000000"
  readonly property string geoMaxBytes: "4096"

  // "started", or "busy" when a download is already running in this bar.
  function refresh(force) {
    if (fetchProc.running) return "busy"
    fetchProc.command = ["bash", fetchScript, cacheDir, "meetups.json", feedUrl,
      String(force ? 0 : feedMaxAgeMinutes), feedMaxBytes]
    fetchProc.running = true
    return "started"
  }

  // ---- Reminders ------------------------------------------------------------

  // remind.sh records each reminder it sends, under a lock, so one meetup
  // gets one notification the day before and one on the day, however many
  // monitors have a bar. sentHere only saves asking it again every minute.
  readonly property string remindScript: decodeURIComponent(String(Qt.resolvedUrl("remind.sh")).replace(/^file:\/\//, ""))
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/gleasonmt-meetups/reminded"
  property var sentHere: ({})

  function checkReminders() {
    if (!reminders) return
    for (var i = 0; i < meetups.length; i++) {
      var m = meetups[i]
      var kind = Model.reminderDue(m, now)
      if (!kind) continue
      var key = Qt.md5(m.id + "|" + m.start + "|" + kind)
      if (sentHere[key]) continue
      sentHere[key] = true
      var t = Model.reminderText(m, kind, unit)
      // Clicking the notification opens the meetup's page; the link is the
      // feed's https URL, one argument, never parsed by a shell.
      Quickshell.execDetached(["bash", remindScript, stateDir, key,
        "--app-name", "Omarchy Meetups", "-g", "\u{f0849}", "-u", "normal",
        t.headline, t.body, "--exec", "omarchy-launch-browser", m.url])
    }
  }

  onMeetupsChanged: checkReminders()

  function detectLocation() {
    if (geoProc.running || !configuredLoaded || configuredLocation !== null) return
    geoProc.command = ["bash", fetchScript, cacheDir, "location.json", "https://geo.omarchy.org/",
      String(geoMaxAgeMinutes), geoMaxBytes]
    geoProc.running = true
  }

  Process {
    id: fetchProc
    // 2 means another monitor's bar holds the download; its result reaches
    // this one through the file watch.
    onExited: function(code) {
      if (code !== 2) root.fetchFailed = code !== 0
      feedFile.reload()
    }
  }

  Process {
    id: geoProc
    onExited: geoFile.reload()
  }

  FileView {
    id: feedFile
    path: root.cacheDir + "/meetups.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var parsed = Model.parseFeed(text())
      if (parsed.ok) root.feed = parsed
      root.feedLoaded = true
    }
    onLoadFailed: root.feedLoaded = true
  }

  FileView {
    id: weatherFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.configuredLocation = Model.parseLocation(text())
      root.configuredLoaded = true
      root.detectLocation()
    }
    onLoadFailed: {
      root.configuredLocation = null
      root.configuredLoaded = true
      root.detectLocation()
    }
  }

  FileView {
    id: geoFile
    path: root.cacheDir + "/location.json"
    printErrors: false
    onLoaded: root.detectedLocation = Model.parseLocation(text())
  }

  // Hourly: the fetch script only downloads when the cached copy is stale.
  Timer {
    interval: 60 * 60 * 1000
    running: true
    repeat: true
    onTriggered: {
      root.refresh(false)
      // A watch on weather.json never fires if its folder didn't exist when
      // the shell started, so look again rather than rely on it.
      weatherFile.reload()
      root.detectLocation()
    }
  }

  // "Today" and "Now" in the bar follow the clock; once a minute is plenty.
  Timer {
    interval: 60 * 1000
    running: true
    repeat: true
    onTriggered: {
      root.now = Date.now()
      root.checkReminders()
    }
  }

  Component.onCompleted: refresh(false)

  // ---- Bar ------------------------------------------------------------------

  visible: !(hideWhenNone && next === null)
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    now = Date.now()
    weatherFile.reload()
    cursorActive = false
    rowIndex = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { return root.refresh(true) }
  }

  TextMetrics {
    id: labelMetrics
    font.family: button.fontFamily
    font.pixelSize: Style.bar.iconFont
    text: root.barLabel
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\u{f0849}"
    dimmed: root.next === null
    labelText: root.bar && root.bar.vertical ? "" : root.barLabel
    slotSize: labelText !== "" ? Style.bar.iconSlot + labelMetrics.advanceWidth + Style.space(6) : Style.bar.iconSlot
    tooltipText: root.next ? root.next.title + "\n" + Model.detailLine(root.next, root.unit) : "No Omarchy meetups within " + root.radius + " " + root.unit + " in the next " + root.days + " days"
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh(true)
      else root.toggle()
    }
  }

  // ---- Panel ----------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dx !== 0 && dy === 0 && root.rowIndex >= root.distanceRow) {
          // Left/Right step Distance and Look ahead; on the switches below
          // them either key flips the switch.
          root.activateRow(root.rowIndex, dx > 0 ? 1 : -1)
          return
        }
        root.rowIndex = Math.max(0, Math.min(root.rowCount - 1, root.rowIndex + dy))
      }
      onActivateRequested: if (root.cursorActive) root.activateRow(root.rowIndex)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) { if (t.toLowerCase() === "r") root.refresh(true) }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          x: Style.space(2)
          width: flick.width - Style.space(4)
          spacing: Style.space(10)

          PanelHero {
            width: parent.width
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Text {
                text: "\u{f0849}"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            title: root.next ? root.next.title : "No meetups nearby"
            meta: root.next ? Model.detailLine(root.next, root.unit)
              : (root.origin ? "Nothing within " + root.radius + " " + root.unit + " of " + (root.origin.name || "you") + " in the next " + root.days + " days"
                 : (root.weatherLocationNeedsCoordinates ? "Your Weather location needs coordinates" : "Waiting for your location"))
          }

          PanelSeparator { foreground: root.foreground }

          PanelSectionHeader {
            visible: root.meetups.length > 0
            foreground: root.foreground
            fontFamily: root.fontFamily
            text: "Within " + root.radius + " " + root.unit + " · next " + root.days + " days"
          }

          Column {
            width: parent.width
            spacing: Style.space(2)

            Repeater {
              model: root.meetups.slice(0, root.maxRows)
              MeetupRow {
                required property var modelData
                required property int index
                width: parent.width
                rowIndex: index
                glyph: modelData.online ? "\u{f059f}" : "\u{f034e}"
                label: modelData.title
                caption: Model.detailLine(modelData, root.unit)
                onActivated: root.openUrl(modelData.url)
              }
            }
          }

          // Nothing nearby is a chance to start one.
          MeetupRow {
            visible: root.showHost
            width: parent.width
            rowIndex: root.hostRow
            glyph: "\u{f0415}"
            label: "Host a meetup near you"
            caption: "Put it on Luma, then submit it to the Omarchy calendar"
            onActivated: root.openUrl(root.hostUrl)
          }

          MeetupRow {
            width: parent.width
            rowIndex: root.allRow
            glyph: "\u{f0349}"
            label: "All meetups on omarchy.org"
            caption: "And the guidelines for hosting one"
            onActivated: root.openUrl("https://omarchy.org/meetups/")
          }

          PanelSeparator { foreground: root.foreground }

          // The two settings most people want, changeable right here: click
          // for the next preset, right-click (or Left) for the one before.
          MeetupRow {
            width: parent.width
            rowIndex: root.distanceRow
            glyph: "\u{f08f0}"
            label: "Distance: " + root.radius + " " + root.unit
            caption: "Click for farther, right-click for closer"
            onActivated: function(direction) { root.activateRow(root.distanceRow, direction) }
          }

          MeetupRow {
            width: parent.width
            rowIndex: root.daysRow
            glyph: "\u{f00ed}"
            label: "Look ahead: " + root.days + " days"
            caption: "Click for longer, right-click for shorter"
            onActivated: function(direction) { root.activateRow(root.daysRow, direction) }
          }

          MeetupRow {
            width: parent.width
            rowIndex: root.unitRow
            glyph: "\u{f046d}"
            label: "Units: " + (root.unit === "km" ? "kilometers" : "miles")
            caption: "Click to switch to " + (root.unit === "km" ? "miles" : "kilometers")
            onActivated: root.activateRow(root.unitRow)
          }

          MeetupRow {
            width: parent.width
            rowIndex: root.onlineRow
            glyph: "\u{f059f}"
            label: "Online meetups: " + (root.includeOnline ? "shown" : "hidden")
            caption: "Click to " + (root.includeOnline ? "hide" : "show") + " meetups with no place"
            onActivated: root.activateRow(root.onlineRow)
          }

          MeetupRow {
            width: parent.width
            rowIndex: root.remindRow
            glyph: root.reminders ? "\u{f009a}" : "\u{f009b}"
            label: "Reminders: " + (root.reminders ? "on" : "off")
            caption: "A notification the day before and on the day"
            onActivated: root.activateRow(root.remindRow)
          }

          PanelSeparator { foreground: root.foreground }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            text: {
              var where = root.weatherLocationNeedsCoordinates
                ? "Your Weather location, " + root.configuredLocation.name + ", has no coordinates. Pick it from the Weather panel's search to see distances."
                : root.origin
                ? "Near " + (root.origin.name || "you") + (root.usingWeatherLocation ? " (your weather location)" : " (from your network)")
                : "Location unknown. Set one in the Weather panel."
              var when = root.fetchFailed && !root.feed.ok ? "Couldn't reach omarchy.org. Middle-click to retry."
                : (root.feed.refreshed ? "List updated " + root.feed.refreshed : "Loading meetups…")
              return where + "\n" + when
            }
          }
        }
      }
    }
  }

  component MeetupRow: CursorSurface {
    id: row
    property int rowIndex: 0
    property string glyph: ""
    property string label: ""
    property string caption: ""
    signal activated(int direction)

    hasCursor: root.cursorActive && root.rowIndex === rowIndex
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      onEntered: { root.cursorActive = true; root.rowIndex = row.rowIndex }
      onClicked: function(mouse) { row.activated(mouse.button === Qt.RightButton ? -1 : 1) }
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: row.glyph
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: row.label
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          visible: row.caption !== ""
          textFormat: Text.PlainText
          text: row.caption
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
