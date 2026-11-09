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
  readonly property int radius: Math.max(1, Math.min(20000, Number(setting("radius", 300)) || 300))
  readonly property int days: Math.max(1, Math.min(365, Number(setting("days", 90)) || 90))
  readonly property bool includeOnline: setting("includeOnline", false) === true
  readonly property bool hideWhenNone: setting("hideWhenNone", false) === true

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

  // Where you are: Omarchy's weather location when one is set
  // (omarchy-weather-location), else where geo.omarchy.org places this
  // network, the same lookup the weather panel uses.
  property var configuredLocation: null
  property var detectedLocation: null
  property bool configuredLoaded: false
  readonly property var origin: configuredLocation || detectedLocation
  readonly property bool usingWeatherLocation: configuredLocation !== null

  property double now: Date.now()

  readonly property var meetups: Model.upcoming(feed.events, origin, radius, unit, includeOnline, now, days)
  readonly property var next: meetups.length > 0 ? meetups[0] : null
  readonly property string barLabel: Model.barLabel(next, now)

  // ---- Panel cursor ---------------------------------------------------------

  property int rowIndex: 0
  property bool cursorActive: false
  readonly property int rowCount: Math.min(meetups.length, maxRows) + 1
  readonly property int maxRows: 8

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function openUrl(url) {
    if (!/^https:\/\//.test(String(url))) return
    Quickshell.execDetached(["omarchy-launch-browser", url])
    root.close()
  }

  function activateRow(i) {
    if (i < Math.min(meetups.length, maxRows)) openUrl(meetups[i].url)
    else openUrl("https://omarchy.org/meetups/")
  }

  function refresh(force) {
    if (fetchProc.running) return
    fetchProc.command = ["bash", "-c", fetchScript, "meetups-fetch",
      cacheDir, "meetups.json", feedUrl, String(force ? 0 : feedMaxAgeMinutes)]
    fetchProc.running = true
  }

  function detectLocation() {
    if (geoProc.running || !configuredLoaded || configuredLocation !== null) return
    geoProc.command = ["bash", "-c", fetchScript, "meetups-geo",
      cacheDir, "location.json", "https://geo.omarchy.org/", String(geoMaxAgeMinutes)]
    geoProc.running = true
  }

  // Downloads $3 to $1/$2 unless that copy is younger than $4 minutes. Writes
  // to a temporary file first, so a reader never sees half a download, and
  // keeps the old copy when the download fails.
  readonly property string fetchScript: 'dir=$1; file=$dir/$2; url=$3; age=$4
mkdir -p "$dir" || exit 1
if [ "$age" -gt 0 ] && [ -n "$(find "$file" -mmin -"$age" 2>/dev/null)" ]; then exit 0; fi
tmp=$(mktemp "$dir/.dl.XXXXXX") || exit 1
if curl -fsSL --max-time 15 --max-filesize 5000000 "$url" -o "$tmp"; then mv -f "$tmp" "$file"; else rm -f "$tmp"; exit 1; fi'

  Process {
    id: fetchProc
    onExited: function(code) {
      root.fetchFailed = code !== 0
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
      root.detectLocation()
    }
  }

  // "Today" and "Now" in the bar follow the clock; once a minute is plenty.
  Timer {
    interval: 60 * 1000
    running: true
    repeat: true
    onTriggered: root.now = Date.now()
  }

  Component.onCompleted: refresh(false)

  // ---- Bar ------------------------------------------------------------------

  visible: !(hideWhenNone && next === null)
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    now = Date.now()
    cursorActive = false
    rowIndex = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(true); return "ok" }
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
    tooltipText: root.next ? root.next.title : "No Omarchy meetups within " + root.radius + " " + root.unit + " in the next " + root.days + " days"
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
                 : "Waiting for your location")
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

          MeetupRow {
            width: parent.width
            rowIndex: Math.min(root.meetups.length, root.maxRows)
            glyph: "\u{f0349}"
            label: "All meetups on omarchy.org"
            caption: "Host one: omarchy.org/meetups"
            onActivated: root.openUrl("https://omarchy.org/meetups/")
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
              var where = root.origin
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
    signal activated()

    hasCursor: root.cursorActive && root.rowIndex === rowIndex
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: { root.cursorActive = true; root.rowIndex = row.rowIndex }
      onClicked: row.activated()
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
