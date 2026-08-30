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
    'MODEL_002': (checks) => {
      // Renders the real `checks` object produced by MODEL_002's current
      // same-side pattern strategy (bot-models/model-002/Model002.js
      // _emitDecision -> bot:decision payload). MODEL_002 uses no Daily
      // BOS, 1H confirmation, or EMA — trend is supplied directly by the
      // user, and support/resistance are the user's own configured
      // levels, not auto-detected. Every field here is something the
      // strategy actually computed — nothing invented, matching the same
      // "unavailable, not fake" rule as MODEL_001's renderer above.
      //
      // Candle 2's boundaries (fixed at Candle2.high/low the moment
      // Candle 2 validates) are shown once known and stay unchanged until
      // BUY/SELL/INVALID resolves the pattern.
      if (!checks) {
        return '<div class="text-gray-500 italic">No analysis available for this decision yet.</div>';
      }

      const row = (label, valueHtml) =>
        '<div class="flex justify-between"><span class="text-gray-400">' + label + ':</span>' + valueHtml + '</div>';

      const trendSpan = (status) => {
        const color = status === 'BULLISH' ? 'text-emerald-400' : status === 'BEARISH' ? 'text-rose-400' : 'text-gray-400';
        return '<span class="' + color + ' font-bold">' + status + '</span>';
      };

      const touchSpan = (status, level) => {
        const color = status === 'TOUCHED' ? 'text-emerald-400' : 'text-gray-400';
        const levelText = level != null ? ' (' + Number(level).toFixed(2) + ')' : '';
        return '<span class="' + color + '">' + (status || 'NOT_TOUCHED') + levelText + '</span>';
      };

      const candleSpan = (candle, label) => candle
        ? '<span class="text-gray-300">' + label + ' O:' + candle.open + ' H:' + candle.high + ' L:' + candle.low + ' C:' + candle.close + '</span>'
        : '<span class="text-gray-500">—</span>';

      const patternStateSpan = (state) => {
        const color = state === 'TRADE_CONFIRMED' ? 'text-emerald-400'
          : state === 'WAITING_FOR_BOUNDARY_BREAK' || state === 'WAITING_FOR_CANDLE2' ? 'text-amber-400'
          : 'text-gray-400';
        return '<span class="' + color + '">' + (state || 'IDLE') + '</span>';
      };

      // LEVEL STATE and PATTERN STATE are separate concepts and are shown
      // as separate rows. Support/Resistance are persistent latches
      // supplied by the backend (Model002 -> utils/levelTouchState.js):
      // once a level has been touched it stays TOUCHED here even while the
      // pattern below reads INVALID/IDLE. They are NOT derived from the
      // latest decision's activeLevel.
      let out =
        row('Trend (user-provided)', trendSpan(checks.trend.status)) +
        row('Support', touchSpan(checks.support && checks.support.status, checks.support && checks.support.level)) +
        row('Resistance', touchSpan(checks.resistance && checks.resistance.status, checks.resistance && checks.resistance.level)) +
        row('Pattern State', patternStateSpan(checks.patternState));

      // Direction of the ACTIVE pattern, exactly as the backend routed it
      // (checks.patternVisual.direction). A BULLISH bot whose Resistance is
      // touched runs an opposite-side SELL pattern, so this row is not a
      // restatement of the trend — and it is the same field the chart's
      // boundary captions use, so panel and chart can never disagree.
      if (checks.patternVisual && checks.patternVisual.direction) {
        const dir = checks.patternVisual.direction;
        out += row('Direction', '<span class="' + (dir === 'BUY' ? 'text-emerald-400' : 'text-rose-400') + ' font-bold">' + dir + '</span>');
      }

      // Visual-only helper reference: candle A's BODY high (bullish) or
      // BODY low (bearish) — the exact value the A/B validation compares
      // against, and the price the chart's helper line is drawn at. Wick
      // high/low is never used.
      if (checks.bodyReference && checks.bodyReference.price != null) {
        const br = checks.bodyReference;
        const brLabel = br.side === 'BODY_LOW' ? 'A Body Low (ref)' : 'A Body High (ref)';
        out += row(brLabel, '<span class="text-violet-300">' + Number(br.price).toFixed(2) + '</span>');
      }

      // Pattern candles. The label prefix is the backend's OWN role code
      // (checks.patternVisual.labels[].code / .touch / .trigger) — the
      // panel never invents or infers a role. Previously candleSpan() was
      // called without its `label` argument, which is what rendered the
      // literal text "undefined" in front of every OHLC line.
      const roleLabels = {};
      if (checks.patternVisual && Array.isArray(checks.patternVisual.labels)) {
        checks.patternVisual.labels.forEach((l) => {
          roleLabels[l.role] = l.code + (l.touch ? ' TOUCH' : '') + (l.trigger ? ' ' + l.trigger : '');
        });
      }
      const roleFor = (role, fallback) => roleLabels[role] || fallback;

      if (checks.candle1) out += row('Candle 1', candleSpan(checks.candle1, roleFor('CANDLE_1', 'C1')));
      if (checks.candle2) out += row('Candle 2', candleSpan(checks.candle2, roleFor('CANDLE_2', 'C2')));
      if (checks.candle3) out += row('Candle 3 (latest)', candleSpan(checks.candle3, roleFor('CANDLE_3', 'C3')));

      if (checks.points) {
        const p = checks.points;
        const maxLabel = p.bodyP >= p.upperP && p.bodyP >= p.lowerP ? 'BodyP' : (p.upperP > p.lowerP ? 'UpperP' : 'LowerP');
        out +=
          row('UpperP', '<span class="text-gray-300">' + Number(p.upperP).toFixed(2) + '</span>') +
          row('LowerP', '<span class="text-gray-300">' + Number(p.lowerP).toFixed(2) + '</span>') +
          row('Body', '<span class="text-gray-300">' + Number(p.body).toFixed(2) + '</span>') +
          row('BodyP (2.5x Body)', '<span class="text-gray-300">' + Number(p.bodyP).toFixed(2) + '</span>') +
          row('Maximum', '<span class="' + (maxLabel === 'BodyP' ? 'text-emerald-400' : 'text-rose-400') + '">' + maxLabel + (maxLabel === 'BodyP' ? ' (valid)' : ' (invalid — BodyP must be max)') + '</span>');
      }

      if (checks.boundaries) {
        out +=
          row('Upper Boundary (fixed)', '<span class="text-emerald-400">' + Number(checks.boundaries.upper).toFixed(2) + '</span>') +
          row('Lower Boundary (fixed)', '<span class="text-rose-400">' + Number(checks.boundaries.lower).toFixed(2) + '</span>');
      }

      return out;
    }
  },

  render(modelId, containerEl, checks) {
    const renderer = this.renderers[modelId];
    if (!renderer) {
      // An unrecognized model must never silently render as if it were
      // MODEL_001 — that would show fabricated-looking fields (EMA, Daily
      // Trend) for a strategy that never computed them. Honest unknown
      // state instead, matching the "never fabricate" rule used throughout
      // this panel.
      containerEl.innerHTML = '<div class="text-gray-500 italic">No renderer available for model "' + (modelId || 'unknown') + '".</div>';
      return;
    }
    containerEl.innerHTML = renderer(checks);
  }
};
