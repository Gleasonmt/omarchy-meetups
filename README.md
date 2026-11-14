# Omarchy Meetups

The next [Omarchy meetup](https://omarchy.org/meetups/) near you, in your bar. Pick how far you're
willing to go (300 miles by default) and how far ahead to look (90 days), and the widget shows
how soon the next meetup in range is ("Tonight", "Tomorrow", "in 3 days"). Hover for its name and
time; click it for every upcoming meetup in range, each one a click from its sign-up page. A
reminder pops up the day before and on the day, and if nothing is near you, the list shows you how
to host one.

![The widget in the bar, reading "Tonight"](media/bar.png)

```bash
omarchy plugin add https://github.com/Gleasonmt/omarchy-meetups --enable
```

## What it looks like

The list, with each meetup's cover image, and its settings folded under **Filter options**. It
wears whatever theme you're using:

| Tokyo Night | Another theme |
|---|---|
| ![The meetups list in Tokyo Night](media/panel-tokyo-night.png) | ![The same list in a yellow theme](media/panel-other-theme.png) |

What the bar shows:

| When | Bar |
|---|---|
| Happening right now | Now |
| Today, from 5 PM | Tonight |
| Today, before 5 PM | Today |
| Tomorrow | Tomorrow |
| 2 days or more | in 3 days, in 45 days |
| Nothing in range | the icon, dimmed |

## How it works

- **Meetups** come from omarchy.org's own list, which it refreshes from the
  [Omarchy Luma calendar](https://luma.com/omarchy). The widget downloads it when its copy is more
  than six hours old, or when you refresh, into `${XDG_CACHE_HOME:-~/.cache}/gleasonmt-meetups/`.
  Every monitor's bar shares that one copy and one download.
- **Your location** is your Weather location: the place you set in the Weather panel (or with
  `omarchy-weather-location`). Distances need its coordinates, which the Weather panel's search
  adds. A location set by name only (`omarchy-weather-location --set Malibu`) is still respected:
  the widget asks you to add coordinates rather than looking you up. Only with no Weather location
  at all does it use the city [geo.omarchy.org](https://geo.omarchy.org/) places your network in,
  the same lookup the Weather panel makes. Change your Weather location and the meetups follow
  within the hour, or as soon as you open the list.
- **Times** are shown in your own time zone.
- **Reminders**: for each meetup in range, one notification the day before and one on the day,
  from 9 AM (or within 3 hours of an earlier start). Click it to open the meetup's page. Each is sent
  once, however many monitors you have, and recorded as an empty file in
  `${XDG_STATE_HOME:-~/.local/state}/gleasonmt-meetups/reminded/` (removed after 60 days). Turn
  them off in the list.
- **Nothing nearby?** The list offers "Host a meetup near you", which opens the Omarchy calendar on
  Luma, where new meetups are submitted. omarchy.org/meetups has the guidelines.

## Dependencies and network

Everything it needs comes with Omarchy: `curl` and `bash` to fetch, `omarchy-launch-browser` to
open links, `omarchy-notification-send` for reminders, and `omarchy-bar` to save the settings you
change in the panel. It makes two kinds of
request, both plain HTTPS GETs:

- `raw.githubusercontent.com/omacom/omarchy-site/master/src/data/meetups.json`, omarchy.org's
  meetup list, when the cached copy is over six hours old or you refresh (capped at 2 MB; it is
  about 63 KB)
- `geo.omarchy.org`, only when no Weather location is set at all, at most once a day (capped at
  4 KB)
- `omarchy.org/images/meetups/…`, the cover image of each meetup in your list, kept a week
  (capped at 1 MB; they are about 100 KB). Only image paths of exactly that form are fetched, and
  covers are removed from the cache 30 days after their last download.

Both answers are read as JSON, every field is cut to a length the panel can show, and nothing
downloaded is ever run. A meetup's name and place are escaped before they go into a reminder, so
they always show as written. Cached files and reminder records are readable only by you.

## Settings

The settings are under **Filter options** at the bottom of the widget's list (click it, or press
Enter on it, to open them):

- **Distance** and **Look ahead**: click to step up through common values, right-click to step
  back (or use the arrow keys).
- **Units**: miles or kilometers. Switching converts the distance, so 300 mi becomes 485 km.
- **Online meetups**: shown or hidden (hidden by default, since they have no distance).
- **Reminders**: on or off (on by default).

Everything can also be set from a terminal with `omarchy bar set`, and the widget updates right
away. Add `--json` for numbers and true/false:

```bash
omarchy bar set gleasonmt.meetups radius 150 --json          # distance
omarchy bar set gleasonmt.meetups days 30 --json             # how far ahead
omarchy bar set gleasonmt.meetups includeOnline true --json
omarchy bar set gleasonmt.meetups reminders false --json
omarchy bar set gleasonmt.meetups unit km
```

They're stored on the widget's entry in `~/.config/omarchy/shell.json`, which you can also edit by hand:

| key | default | |
|---|---|---|
| `radius` | `300` | how far to look (5–5000) |
| `days` | `90` | how many days ahead to look (7–365) |
| `unit` | `mi` | `mi` or `km` |
| `includeOnline` | `false` | also list online meetups |
| `reminders` | `true` | a notification the day before and on the day |
| `hideWhenNone` | `false` | hide the widget when nothing is in range |

Click the widget to open the list, middle-click to refresh it now. In the list, the arrow keys
move, Enter opens a meetup, and `r` refreshes. For a keybinding:
`omarchy-shell gleasonmt.meetups toggle`. `omarchy-shell gleasonmt.meetups refresh` answers
`started`, or `busy` when a download is already running.

## Removing

```bash
omarchy plugin remove gleasonmt.meetups
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/gleasonmt-meetups" "${XDG_STATE_HOME:-$HOME/.local/state}/gleasonmt-meetups"
```

## Development

The logic lives in `Model.js`, the download in `fetch.sh` and the send-once reminder in
`remind.sh`; all three are tested under Node (the script tests use a stub `curl` and a stub
`omarchy-notification-send`):

```bash
node --test tests/*.test.mjs
```

## License

MIT. Meetup listings belong to their hosts and come from omarchy.org.
