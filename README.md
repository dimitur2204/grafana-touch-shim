# Grafana touch shim

Touch support for Grafana's time series panels: check values with a
long-press and zoom into a time range, on phones and tablets.

Grafana's time series panels are drawn by [uPlot](https://github.com/leeoniya/uPlot),
which only listens for mouse events, so on a touchscreen you can neither
hover for a tooltip nor drag to zoom
([grafana/grafana#8799](https://github.com/grafana/grafana/issues/8799)).
This small script translates touch gestures into the mouse events uPlot
already understands. It is a stopgap until Grafana supports touch natively.

## Gestures

| Gesture | Result |
|---|---|
| One-finger swipe | Scrolls the page, as usual |
| Two-finger pinch | Zooms the page, as usual |
| Long-press (300 ms), then slide | Crosshair and tooltip follow your finger; the tooltip stays after you lift |
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

Tested with Grafana 13.1 on Android Chrome. It relies on Grafana and uPlot
internals (the `.u-over` element and their mouse handling), so a Grafana
update can break it.

## Disclosure

Written with the help of an AI coding assistant (Claude); tested by hand on a
real device.

## License

[MIT](LICENSE)
