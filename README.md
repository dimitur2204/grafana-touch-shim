# Grafana touch shim

Touch support for Grafana's time series panels: check values with a
long-press and zoom into a time range, on phones and tablets.

Grafana's time series panels are drawn by [uPlot](https://github.com/leeoniya/uPlot),
which only listens for mouse events, so on a touchscreen you can neither
hover for a tooltip nor drag to zoom
([grafana/grafana#8799](https://github.com/grafana/grafana/issues/8799)).
This small script translates touch gestures into the mouse events uPlot
already understands. It is a stopgap until Grafana supports touch natively.

## Demo

https://github.com/user-attachments/assets/b7dc5c60-d87b-4652-8a92-5e95a7c17ba5

Long-press for the tooltip, then hold and tap a second finger to select a time
range and zoom (Android Chrome, Grafana 13.1).

## Gestures

| Gesture | Result |
|---|---|
| One-finger swipe | Scrolls the page, as usual |
| Two-finger pinch | Zooms the page, as usual |
| Long-press (300 ms), then slide | Crosshair snaps onto the top line at that time, so only your finger's horizontal position matters and it can stay off the data; the tooltip stays after you lift |
| While holding, tap a second finger anywhere | Marks the start of a time range |
| Keep sliding the first finger | The selection band follows, as on desktop |
| Lift the first finger | Zooms to the selection |
| Tap the second finger again | Cancels the selection, back to the tooltip |
| Touch outside the chart | Hides the tooltip |

One finger does all the positioning; the second finger is only a button, so
its position and jitter don't matter. A plain tap behaves exactly as before.

## Install

**Userscript (per device).** Install
[`grafana-touch.user.js`](grafana-touch.user.js) in a userscript manager:
Tampermonkey (Android, desktop) or Userscripts (iOS Safari). It matches every
site but does nothing unless the page is Grafana; narrow `@match` to your
Grafana's address if you prefer.

**Reverse proxy (every device, no extension).** [`proxy/`](proxy) runs nginx
in Docker in front of an existing Grafana and adds the script to every page.
Grafana itself is not changed.

```sh
cd proxy
GRAFANA_UPSTREAM=http://192.168.1.10:3000 docker compose up -d
# open http://<docker host>:3011
```

Consider who can reach the proxy port: it serves the same Grafana, with the
same access rules, on another port.

## How it works

- A `MutationObserver` attaches `touchstart` listeners to every uPlot overlay
  (`.u-over`) as panels mount.
- Nothing is cancelled until a gesture has started, so normal scrolling stays
  smooth; listeners that need `preventDefault()` are registered with
  `{ passive: false }`.
- Gestures are dispatched to the overlay as `mouseenter`/`mousemove`/`mousedown`/`mouseup`.
- Synthetic events carry real `movementX`/`movementY`. uPlot ignores
  `mousemove` with zero movement during a drag (a guard against spurious
  Chrome events), which otherwise freezes the selection.
- After a gesture the browser's own tap→click is suppressed, since Grafana
  pins the tooltip on click.
- Snapping: the time series panel shows a single cursor dot, on the line
  nearest the cursor and only within 30 px of it. On every finger move the
  shim sends a few hidden cursor moves down from the top of the chart, at most
  28 px apart, until the dot appears; the first dot found is on the top line.
  It then moves the cursor onto that dot, and checks that uPlot still shows it
  there (with very dense data the dot's pixel can map to a neighbouring data
  point).
- uPlot rounds the dot's position up to whole pixels, so it sits slightly
  right of and below the data point; the shim shifts it back half a pixel.

On a **stacked** chart the top line is the stack total, so it is always the
same series whatever the values. Turn stacking off if you want the tooltip to
follow the series with the biggest value.

Tested with Grafana 13.1 on Android Chrome. It relies on Grafana and uPlot
internals (the `.u-over` element, the cursor dot and their mouse handling), so
a Grafana update can break it.

## Development

```sh
bun test
```

[`test/`](test) runs the script against a fake time series panel that mimics
the uPlot behaviour the shim relies on, and drives it with touch events:
gestures (tap, swipe, pinch, hover, zoom, cancel) and snapping, including
randomised stress tests with dense, spiky and bunched-together lines. It does
not render anything, so check visual changes on a real device.

## Disclosure

Written with the help of an AI coding assistant (Claude); tested by hand on a
real device.

## License

[MIT](LICENSE)
