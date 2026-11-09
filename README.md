# Omarchy Meetups

The next [Omarchy meetup](https://omarchy.org/meetups/) near you, in your bar. Pick how far you're
willing to go (300 miles by default) and how far ahead to look (90 days), and the widget shows
the next meetup in range ("Today 6 PM", "Tomorrow", "Dec 7"). Click it for every upcoming
meetup in range, each one a click from its sign-up page.

```bash
omarchy plugin add https://github.com/Gleasonmt/omarchy-meetups --enable
```

## How it works

- **Meetups** come from omarchy.org's own list, which it refreshes from the
  [Omarchy Luma calendar](https://luma.com/omarchy). The widget downloads it at most every six
  hours into `~/.cache/gleasonmt-meetups/` and shares that copy across every monitor.
- **Your location** is the one Omarchy's Weather panel already uses: the place you set there
  (`omarchy-weather-location`), or, with none set, the city
  [geo.omarchy.org](https://geo.omarchy.org/) places your network in, the same lookup the
  Weather panel makes. Change it in the Weather panel and the meetups follow. Nothing else
  leaves your computer.
- **Times** are shown in your own time zone.

## Settings

Change them with `omarchy bar set`; the widget updates right away:

```bash
omarchy bar set gleasonmt.meetups radius 150   # distance
omarchy bar set gleasonmt.meetups days 30      # how far ahead
omarchy bar set gleasonmt.meetups unit km
```

They're stored on the widget's entry in `~/.config/omarchy/shell.json`, which you can also edit by hand:

| key | default | |
|---|---|---|
| `radius` | `300` | how far to look |
| `days` | `90` | how many days ahead to look (7–365) |
| `unit` | `mi` | `mi` or `km` |
| `includeOnline` | `false` | also list online meetups |
| `hideWhenNone` | `false` | hide the widget when nothing is in range |

Click the widget to open the list, middle-click to refresh it now. In the list, the arrow keys
move, Enter opens a meetup, and `r` refreshes. For a keybinding:
`omarchy-shell gleasonmt.meetups toggle`.

## Removing

```bash
omarchy plugin remove gleasonmt.meetups
rm -rf ~/.cache/gleasonmt-meetups
```

## Development

The logic lives in `Model.js` and is tested under Node:

```bash
node --test tests/*.test.mjs
```

## License

MIT. Meetup listings belong to their hosts and come from omarchy.org.
