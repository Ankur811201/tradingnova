# Nova Trade Recording Changes

Recording-only changes. The live Lightweight Charts UI is intentionally untouched.

- 10 completed candles + 1 live candle in the recording SVG renderer.
- Live candle remains centered.
- Recording chart is chart-only; the text/data side panel is excluded.
- Server-side SVG -> Sharp PNG -> ffmpeg-static WebM; no Chrome/Chromium/Puppeteer/Playwright.
- Symbol validation prevents cross-symbol prices from corrupting a recording candle.
- Valid OHLC filtering protects the renderer from malformed candles.
- Authoritative bot execution markers are retained for recording frames.
- Delete All recordings endpoint/UI is included from the current project version.
- Recording capture interval: 2000 ms (0.5 FPS).
- Chunk duration: 10 minutes.
- At 0.5 FPS, a 10-minute chunk is approximately 300 frames.
- Recording fonts are bundled as DejaVu Sans/Mono and selected through fontconfig for server consistency.
