'use strict';

const TARGET_TIMEFRAME = '3m';
const TARGET_COUNT = 4;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function normalizeTargetExitInput(input, side, entryPrice, originalQuantity, originalTimeframe) {
  if (!input || input.enabled !== true) {
    throw new Error('Target Exit must be enabled');
  }
  if (!['LONG', 'SHORT'].includes(side)) throw new Error('Invalid position side');
  if (!finitePositive(entryPrice)) throw new Error('Position entry price is invalid');
  if (!finitePositive(originalQuantity)) throw new Error('Position quantity is invalid');

  const raw = Array.isArray(input.targets) ? input.targets : [];
  if (raw.length !== TARGET_COUNT) throw new Error('Exactly 4 targets are required');

  const targets = raw.map((t, i) => ({
    index: i + 1,
    price: Number(t.price),
    exitPercent: i === 3 ? 100 - raw.slice(0, 3).reduce((sum, x) => sum + Number(x.exitPercent), 0) : Number(t.exitPercent),
  }));

  for (const t of targets) {
    if (!finitePositive(t.price)) throw new Error(`Target ${t.index} price must be a positive number`);
    if (!Number.isFinite(t.exitPercent) || t.exitPercent <= 0 || t.exitPercent > 100) {
      throw new Error(`Target ${t.index} exit percentage is invalid`);
    }
  }

  const sum = targets.reduce((a, t) => a + t.exitPercent, 0);
  if (Math.abs(sum - 100) > 1e-9) throw new Error('Target exit percentages must total 100%');

  for (let i = 1; i < targets.length; i++) {
    if (side === 'LONG' && !(targets[i].price > targets[i - 1].price)) {
      throw new Error('For BUY/LONG, target prices must increase from T1 to T4');
    }
    if (side === 'SHORT' && !(targets[i].price < targets[i - 1].price)) {
      throw new Error('For SELL/SHORT, target prices must decrease from T1 to T4');
    }
  }

  if (side === 'LONG' && targets[0].price <= entryPrice) throw new Error('T1 must be above the LONG entry price');
  if (side === 'SHORT' && targets[0].price >= entryPrice) throw new Error('T1 must be below the SHORT entry price');

  let allocated = 0;
  const withQuantity = targets.map((t, i) => {
    const quantity = i === 3
      ? originalQuantity - allocated
      : originalQuantity * (t.exitPercent / 100);
    allocated += quantity;
    return { ...t, quantity };
  });

  const normalizedOriginalTimeframe = ['1m', '3m'].includes(originalTimeframe) ? originalTimeframe : '3m';

  return {
    enabled: true,
    confirmationTimeframe: TARGET_TIMEFRAME,
    originalTimeframe: normalizedOriginalTimeframe,
    activeTimeframe: TARGET_TIMEFRAME,
    targets: withQuantity,
    activatedAt: new Date(),
    completedAt: null,
  };
}

module.exports = { TARGET_TIMEFRAME, TARGET_COUNT, normalizeTargetExitInput };
