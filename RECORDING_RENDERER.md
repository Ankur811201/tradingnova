# NOVA TRADE — S1/R1 Recording Renderer

Recordings are server-side. They start on S1/R1 touch, capture at 1 FPS, rotate every 5 minutes, and encode each chunk with `ffmpeg-static`.

The video chart is rendered directly as **SVG**, from the same canonical candle/decision state used by the live bot-detail page (`RecordingService.js`'s session state — candles, support/resistance, MODEL_002 pattern boundaries/body-reference/role markers, current price). Each frame is rasterized to PNG with `sharp`, then FFmpeg encodes the PNG sequence to WebM (VP9).

**No browser is launched.** There is no Chrome, no Chromium, no Puppeteer, no Playwright and no DevTools Protocol involved anywhere in the recording path.

## Requirements

- Node.js 18+
- `ffmpeg-static` and `sharp`, both installed by `npm install`
- No system-level `ffmpeg`, Chrome, or Chromium required
- No `sudo` / `apt` / `yum` / root access required — works on shared/cPanel Node.js hosting

## Architecture

```
Candle data (Candle model / live Socket.IO ticks)
    |
RecordingService session state (same shape the old renderer consumed)
    |
SvgChartRenderer.renderChartFrame(state)  -- deterministic SVG string
    |
sharp: SVG -> PNG (one frame at a time, written to disk, not buffered)
    |
FFmpeg (ffmpeg-static, libvpx-vp9): PNG sequence -> WebM chunk
    |
TradeRecording document saved, temp frames deleted
```

## Run

```bash
npm install
npm start
```

## Expected log

```text
[RECORDING] starting <id> instance=<instanceId> symbol=<symbol> timeframe=<tf>
[RECORDING] rotating <id> chunk=1 frames=300
[RECORDING] encoding <id> chunk=1 frames=300
[RECORDING] ffmpeg complete <id> chunk=1
[RECORDING] database record ready <id> chunk=1
```

Per-frame (1 FPS) generation is not individually logged to avoid flooding production logs; failures are always logged (`frame generation failed`, `frame rasterization failed`, `ffmpeg failed`, `database save failed`).
