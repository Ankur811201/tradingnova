# Recording lifecycle fixes — 2026-10-10

This patch is based on the current Recording Timeline UI project ZIP and preserves its timeline UI changes.

## Changes
- Forward committed position closes to RecordingService from BotManager's closed-position detector, the central stop-loss tick handler, and Target T4.
- Deduplicate close processing by Trade ID so overlapping close hooks do not count the same loss twice.
- Use the configured bot timeframe first so it matches CandlePersistenceService candle events.
- Stop recordings with no trade after six matching completed candles instead of leaving them active until the 24-hour hard limit.
- Keep captured PNG frames when finalization/encoding fails; log their exact path and write FAILED metadata when MongoDB is available.
- Encode VP9 using realtime deadline, cpu-used 8 and row multithreading; compute timeout from frame count.
- Decode/validate the generated WebM before storing READY metadata and deleting temporary frames.
- On SIGTERM/SIGINT, await active recording finalizers before closing the HTTP server. Concurrent stop triggers share the same stop promise.
- Added source-level lifecycle regression tests for these behaviors.

## No changes
- Trading entry/exit rules, risk sizing, order execution, and permanent WebM retention policy are unchanged.
