/**
 * Model Thinking Registry
 * Polymorphic strategy renderer targeting model-specific rationale.
 *
 * NOVA TRADE -- PART 8: renders the real `checks` object produced by
 * MODEL_001 (see bot-models/model-001/patternEngine.js `analysis` ->
 * Model001._buildChecksFromAnalysis -> bot:decision payload). `checks` is
 * null when no real analysis exists yet (insufficient candle history, or a
 * position is already open and entry evaluation was skipped) -- that is
 * rendered as an explicit "unavailable" state, never as fake PASS/FAIL.
 */
window.ModelThinkingRegistry = {
  renderers: {
    'MODEL_001': (checks) => {
      if (!checks) {
        return '<div class="text-gray-500 italic">No analysis available for this decision yet.</div>';
      }

      const trendColor = checks.trend.status === 'BULLISH' ? 'text-emerald-400'
        : checks.trend.status === 'BEARISH' ? 'text-rose-400'
        : 'text-gray-400';

      const row = (label, valueHtml) =>
        '<div class="flex justify-between"><span class="text-gray-400">' + label + ':</span>' + valueHtml + '</div>';

      const statusSpan = (status, positiveValues) => {
        const positive = positiveValues.includes(status);
        return '<span class="' + (positive ? 'text-emerald-400' : 'text-gray-400') + '">' + status + '</span>';
      };

      return (
        row('Trend', '<span class="' + trendColor + ' font-bold">' + checks.trend.status + '</span>') +
        row('EMA(50)', '<span class="text-gray-200">' + (checks.trend.ema50 != null ? Number(checks.trend.ema50).toFixed(2) : 'N/A') + '</span>') +
        row('Support Check', statusSpan(checks.support.status, ['TOUCHED'])) +
        row('Resistance Check', statusSpan(checks.resistance.status, ['TOUCHED'])) +
        row('Body Expansion (1.5x)', '<span class="' + (checks.bodyExpansion.status === 'PASS' ? 'text-emerald-400' : 'text-rose-400') + '">' + checks.bodyExpansion.status + '</span>') +
        row('Volume Confirmation', '<span class="text-gray-500" title="Canonical candles carry no volume data yet">' + checks.volume.status + '</span>') +
        row('Liquidity Sweep', statusSpan(checks.liquiditySweep.status, ['DETECTED'])) +
        row('3-Candle Cycle', statusSpan(checks.cycle3Candle.status, ['BUY', 'SELL']))
      );
    },
    'Model002': (checks) => {
      // Future model interface mapping (e.g., Mean Reversion / Orderbook Imbalance)
      if (!checks) {
        return '<div class="text-gray-500 italic">No analysis available for this decision yet.</div>';
      }
      return `
        <div class="flex justify-between"><span class="text-gray-400">RSI Divergence:</span><span class="text-emerald-400">${checks.rsiDivergence}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Orderbook Spread:</span><span class="text-gray-200">${checks.orderbookSpread}</span></div>
      `;
    }
  },

  render(modelId, containerEl, checks) {
    const renderer = this.renderers[modelId] || this.renderers['MODEL_001'];
    containerEl.innerHTML = renderer(checks);
  }
};
