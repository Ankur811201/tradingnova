# NOVA TRADE — S1/R1 Recording Renderer

Recordings are server-side. They start on S1/R1 touch, capture at 1 FPS, rotate every 5 minutes, and encode each chunk with `ffmpeg-static`.

The video chart is rendered with the **same Lightweight Charts + ChartManager + CandleSeriesManager + OverlayManager** used by the live bot-detail page. It is not a separate SVG chart.

## Requirements

- Node.js 18+
- `ffmpeg-static` installed by `npm install`
- Chrome/Chromium available on the server

The renderer auto-detects Chrome/Chromium. If it cannot find it, set:

```env
CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe
```

On Linux, common paths such as `/usr/bin/chromium` and `/usr/bin/google-chrome` are checked automatically.

The renderer uses the same Lightweight Charts 4.1.3 CDN URL as the live page. The recording server therefore needs outbound access to `unpkg.com` when a new headless browser starts.

## Run

```bash
npm install
npm start
```

## Expected log

```text
[RECORDING] live chart renderer ready ...
[RECORDING] rotating ... chunk=1 frames=...
[RECORDING] encoding ... chunk=1 frames=...
[RECORDING] ffmpeg complete ...
[RECORDING] database record ready ...
[RECORDING] chunk ready ... chunk=1
```
