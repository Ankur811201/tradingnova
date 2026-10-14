'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const recordingSrc = fs.readFileSync(path.join(root, 'services', 'recording', 'RecordingService.js'), 'utf8');
const tradeRecordingSrc = fs.readFileSync(path.join(root, 'models', 'TradeRecording.js'), 'utf8');

test('all six configured S/R levels can start recordings', () => {
  assert.match(recordingSrc, /MAX_LEVEL_TOUCH_INDEX = 3/);
  assert.match(recordingSrc, /i < MAX_LEVEL_TOUCH_INDEX/);
  assert.match(recordingSrc, /levelKey = manual \? null : `\$\{side === 'SUPPORT' \? 'S' : 'R'\}\$\{index\}`/);
});

test('a level touch starts only once; only the first loss can create Trade 2 recording', () => {
  assert.match(recordingSrc, /this\.levelStates = new Map\(\)/);
  assert.match(recordingSrc, /if \(!allowRepeat && levelState\) return null/);
  assert.match(recordingSrc, /allowRepeat && \(!levelState \|\| levelState\.blocked \|\| levelState\.losses !== 1 \|\| levelState\.tradesStarted !== 1\)/);
  assert.match(recordingSrc, /state\.losses = Number\(state\.losses \|\| 0\) \+ 1/);
  assert.match(recordingSrc, /state\.losses >= 2/);
});

test('recording stops after three completed candles following trade entry', () => {
  assert.match(recordingSrc, /ENTRY_CANDLE_CLOSE_LIMIT = 3/);
  assert.match(recordingSrc, /session\.entryCandleCloseCount = Number\(session\.entryCandleCloseCount \|\| 0\) \+ 1/);
  assert.match(recordingSrc, /entryCandleCloseCount >= ENTRY_CANDLE_CLOSE_LIMIT/);
  assert.match(recordingSrc, /THREE_CANDLES_AFTER_ENTRY/);
});

test('recordings are single files with no chunk rotation', () => {
  assert.doesNotMatch(recordingSrc, /CHUNK_MS/);
  assert.doesNotMatch(recordingSrc, /_rotateChunkIfNeeded/);
  assert.doesNotMatch(recordingSrc, /_scheduleChunkRotation/);
  assert.match(recordingSrc, /\$\{session\.id\}\.webm/);
});

test('completed video is stored permanently on the local filesystem', () => {
  assert.match(tradeRecordingSrc, /storageType: \{ type: String, enum: \['FILESYSTEM'\]/);
  assert.match(recordingSrc, /storageType: 'FILESYSTEM'/);
  assert.match(recordingSrc, /filePath: relativeVideoPath/);
  assert.doesNotMatch(recordingSrc, /GridFSBucket/);
  assert.doesNotMatch(recordingSrc, /tradeRecordingVideos/);
});

test('profit close blocks the level retry path', () => {
  assert.match(recordingSrc, /state\.profitable = true/);
  assert.match(recordingSrc, /state\.blocked = true/);
  assert.match(recordingSrc, /PROFIT_EXIT/);
});


test('recordings without an entry are bounded by completed candles', () => {
  assert.match(recordingSrc, /NO_ENTRY_CANDLE_CLOSE_LIMIT = 6/);
  assert.match(recordingSrc, /NO_ENTRY_CANDLE_LIMIT/);
  assert.match(recordingSrc, /noEntryCandleCloseCount/);
});

test('recording finalization preserves frames and validates WebM before READY', () => {
  assert.match(recordingSrc, /source frames preserved for retry/);
  assert.match(recordingSrc, /Recorded WebM failed media validation/);
  assert.match(recordingSrc, /'-deadline', 'realtime'/);
  assert.match(recordingSrc, /'-cpu-used', '8'/);
  assert.match(recordingSrc, /FFMPEG_TIMEOUT_PER_FRAME_MS/);
});

test('close events and graceful shutdown are wired to RecordingService', () => {
  const botManagerSrc = fs.readFileSync(path.join(root, 'services', 'botManager', 'BotManager.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const targetSrc = fs.readFileSync(path.join(root, 'services', 'TargetExitManager.js'), 'utf8');
  assert.match(recordingSrc, /async handleClosedTrade\(instanceId, positionId\)/);
  assert.match(recordingSrc, /CLOSED_TRADE_LOOKUP_ATTEMPTS = 6/);
  assert.match(recordingSrc, /closed Trade lookup could not be applied|has no linked Trade after/);
  assert.match(botManagerSrc, /recordingService\.handleClosedTrade\(instanceId, pending\.positionId\)/);
  assert.match(serverSrc, /recordingService\.handleClosedTrade\(null, result\.positionId\)/);
  assert.match(targetSrc, /recordingService\.handleClosedTrade\(String\(closedDoc\.instanceId\), closedDoc\._id\)/);
  assert.match(serverSrc, /await recordingService\.stopAll/);
});
