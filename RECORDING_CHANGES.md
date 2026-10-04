# Nova Trade Recording Changes

Recording-only changes. MODEL_002 trading logic is intentionally untouched.

## Recording lifecycle
- S1/R1, S2/R2, S3/R3 can each start a recording once per Node process.
- A level touch starts recording immediately.
- When a bot trade opens for that level, the recorder counts completed candles.
- Recording stops after 3 completed candle closes after the trade opens.
- If Trade 1 closes with a loss, one second recording is started for the same level.
- If Trade 2 also closes with a loss, that level is blocked for recording.
- If a trade closes in profit/target, that level is blocked for the retry path; no Trade 2 recording is created.
- A different configured level has its own independent two-loss lifecycle.
- Manual recording remains supported.

## Video storage
- One recording event produces exactly one WebM video.
- 10-minute chunk rotation has been removed.
- The final WebM is stored permanently on the server filesystem under `src/storage/recordings`.
- MongoDB stores recording metadata and the relative `filePath`; it does not store the video binary.
- Completed WebM files are never deleted automatically.
- Only temporary PNG frame directories are removed after successful encoding.
- Explicit Delete Recording / Delete All actions are the only normal paths that delete completed videos.

## Capture/rendering
- Server-side SVG -> Sharp PNG -> ffmpeg-static WebM.
- No Chrome/Chromium/Puppeteer/Playwright.
- Capture interval remains 2000 ms (0.5 FPS).
- The recording chart uses the same bot creation-time candle boundary as the live chart.
