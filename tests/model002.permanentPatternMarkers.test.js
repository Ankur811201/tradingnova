'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMarkerManager() {
  const applied = { markers: [] };
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const series = { setMarkers: (markers) => { applied.markers = markers.slice(); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/marker-manager.js'), 'utf8'), sandbox);
  return { manager: new sandbox.MarkerManager(series), applied };
}

const marker = (id, time, text) => ({ id, time, position: 'belowBar', color: '#fff', shape: 'circle', text });

test('MODEL_002 pattern markers remain after later pattern updates', () => {
  const { manager, applied } = loadMarkerManager();
  manager.setPatternMarkers([
    marker('model002-pattern:P1:CANDLE_1:C1:100', 100, '① C1'),
    marker('model002-pattern:P1:CANDLE_2:C2:101', 101, '② C2'),
    marker('model002-pattern:P1:CANDLE_3:C3:102', 102, '③ C3'),
  ]);
  manager.setPatternMarkers([
    marker('model002-pattern:P2:CANDLE_1:C1:200', 200, '① C1'),
    marker('model002-pattern:P2:CANDLE_2:C2:201', 201, '② C2'),
    marker('model002-pattern:P2:CANDLE_3:C3:202', 202, '③ C3'),
  ]);
  assert.equal(applied.markers.filter((m) => String(m.id).startsWith('model002-pattern:')).length, 6);
  assert.ok(applied.markers.some((m) => m.time === 102));
  assert.ok(applied.markers.some((m) => m.time === 202));
});

test('clearing active pattern state does not erase permanent pattern markers', () => {
  const { manager, applied } = loadMarkerManager();
  manager.setPatternMarkers([marker('model002-pattern:P1:CANDLE_3:C3:102', 102, '③ BUY')]);
  manager.clearPatternMarkers();
  assert.equal(applied.markers.length, 1);
  assert.equal(applied.markers[0].time, 102);
});
