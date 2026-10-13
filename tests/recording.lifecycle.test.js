'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const recordingSrc = fs.readFileSync(path.join(root, 'services', 'recording', 'RecordingService.js'), 'utf8');
const tradeRecordingSrc = fs.readFileSync(path.join(root, 'models', 'TradeRecording.js'), 'utf8');
const botInstanceSrc = fs.readFileSync(path.join(root, 'models', 'BotInstance.js'), 'utf8');
const botManagerSrc = fs.readFileSync(path.join(root, 'services', 'botManager', 'BotManager.js'), 'utf8');
const controllerSrc = fs.readFileSync(path.join(root, 'controllers', 'recordingsController.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(root, 'public', 'js', 'trade-recordings.js'), 'utf8');

test('only S1 or R1 can trigger the one-time automatic recording', () => {
  assert.match(recordingSrc, /MAX_LEVEL_TOUCH_INDEX = 1/);
  assert.match(recordingSrc, /index !== 1/);
  assert.match(recordingSrc, /recordingState\.autoTriggered/);
  assert.match(recordingSrc, /findOneAndUpdate\([\s\S]*recordingState\.autoTriggered/);
  assert.doesNotMatch(recordingSrc, /allowRepeat|TRADE_2_LOSS_RETRY|levelStates/);
});

test('recording intent and one-time trigger are persisted on the bot', () => {
  assert.match(botInstanceSrc, /recordingState: \{ type: mongoose\.Schema\.Types\.Mixed/);
  assert.match(recordingSrc, /recordingState\.desiredOn/);
  assert.match(recordingSrc, /recordingState\.autoTriggeredAt/);
  assert.match(recordingSrc, /recoverPersistedRecordings/);
  assert.match(serverSrc, /recordingService\.recoverPersistedRecordings\(\)/);
});

test('recording rotates every 30 minutes without stopping the active session', () => {
  assert.match(recordingSrc, /CHUNK_DURATION_MS = 30 \* 60 \* 1000/);
  assert.match(recordingSrc, /_scheduleChunkRotation/);
  assert.match(recordingSrc, /async _rotateChunk\(session\)/);
  assert.match(recordingSrc, /CHUNK_STARTED/);
  assert.match(recordingSrc, /_finalizeRecording\(old, 'CHUNK_ROTATION'\)/);
  assert.doesNotMatch(recordingSrc, /MAX_RECORDING_MS|THREE_CANDLES_AFTER_ENTRY|NO_ENTRY_CANDLE_LIMIT/);
});

test('trade and candle events do not automatically stop or restart recording', () => {
  assert.match(recordingSrc, /Trade opens\/closes are visual metadata only/);
  assert.doesNotMatch(recordingSrc, /this\.stop\(session\.instanceId, 'THREE_CANDLES_AFTER_ENTRY'/);
  assert.doesNotMatch(recordingSrc, /this\.stop\(session\.instanceId, 'NO_ENTRY_CANDLE_LIMIT'/);
  assert.doesNotMatch(recordingSrc, /this\.stopSoon\(/);
});

test('manual OFF finalizes the current chunk and persists recording OFF', () => {
  assert.match(recordingSrc, /async stopManual\(instanceId\)/);
  assert.match(recordingSrc, /recordingState\.desiredOn': false/);
  assert.match(recordingSrc, /this\.stop\(instanceId, 'MANUAL_STOP'\)/);
  assert.match(controllerSrc, /recordingService\.stopManual\(instanceId\)/);
});

test('bot pause finalizes the current chunk but preserves intent for resume', () => {
  assert.match(recordingSrc, /async pauseForBot\(instanceId\)/);
  assert.match(recordingSrc, /recordingState\.paused': true/);
  assert.match(recordingSrc, /this\.stop\(instanceId, 'BOT_PAUSE'\)/);
  assert.match(recordingSrc, /async resumeForBot\(instanceId, bot = null\)/);
  assert.match(botManagerSrc, /recordingService\.pauseForBot\(instanceId\)/);
  assert.doesNotMatch(botManagerSrc.match(/async _stopInstanceUnlocked\(instanceId\) \{([\s\S]*?)async restartInstance/)[1], /recordingService\.pauseForBot/);
  assert.match(botManagerSrc, /recordingService\.resumeForBot\(instanceId, dbInstance\)/);
});

test('server shutdown preserves recording intent and startup recovers it', () => {
  assert.match(recordingSrc, /String\(reason\)\.startsWith\('SERVER_SHUTDOWN'\)/);
  assert.match(recordingSrc, /async recoverPersistedRecordings\(\)/);
  assert.match(recordingSrc, /status: \{ \$in: \['RUNNING', 'STOPPED'\] \}/);
  assert.match(serverSrc, /await recordingService\.stopAll/);
});

test('bot deletion removes video files, frame folders, and recording metadata', () => {
  assert.match(recordingSrc, /async deleteInstanceData\(instanceId\)/);
  assert.match(recordingSrc, /await Recording\.deleteMany\(\{ instanceId \}\)/);
  assert.match(botManagerSrc, /recordingService\.deleteInstanceData\(instanceId\)/);
});

test('manual recording UI supports an OFF action while recording is paused', () => {
  assert.match(controllerSrc, /recordingState: bot\.recordingState \|\| \{\}/);
  assert.match(uiSrc, /RECORDING PAUSED/);
  assert.match(uiSrc, /data\.recordingState && data\.recordingState\.desiredOn/);
});

test('completed videos are stored permanently on the local filesystem', () => {
  assert.match(tradeRecordingSrc, /storageType: \{ type: String, enum: \['FILESYSTEM'\]/);
  assert.match(recordingSrc, /storageType: 'FILESYSTEM'/);
  assert.match(recordingSrc, /filePath: relativeVideoPath/);
  assert.doesNotMatch(recordingSrc, /GridFSBucket/);
});
