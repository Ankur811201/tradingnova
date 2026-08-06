'use strict';

/**
 * Symbol normalization layer between Nova Trade's internal symbols (e.g.
 * "BTCUSD", used throughout RiskEngine/PaperEngine/BotInstance/Model 001)
 * and Delta Exchange's actual product symbols.
 *
 * Verified against official Delta docs (docs.delta.exchange, "Symbology" /
 * "Products" sections): Delta's perpetual futures symbols for major pairs
 * are already exactly "BTCUSD", "ETHUSD" (e.g. product_id 27 = symbol
 * "BTCUSD"), so for the default configuration this is an identity mapping.
 * The override table below exists for cases where a Nova symbol should map
 * to a *different* Delta product symbol — populate it explicitly rather
 * than guessing; nothing here invents an unverified mapping.
 *
 * Nova Trade never needs to know Delta-specific product IDs outside this
 * module and DeltaAdapter — Model 001 and the rest of the core only ever
 * see the Nova symbol.
 */

// Explicit overrides only. Empty by default = identity mapping (Nova symbol === Delta symbol).
const NOVA_TO_DELTA_OVERRIDES = {
  // Example, if ever needed: 'BTCUSD': 'BTCUSD',
};

function novaToDeltaSymbol(novaSymbol) {
  if (!novaSymbol || typeof novaSymbol !== 'string') {
    throw new Error('novaToDeltaSymbol requires a non-empty symbol string');
  }
  return NOVA_TO_DELTA_OVERRIDES[novaSymbol] || novaSymbol;
}

function deltaToNovaSymbol(deltaSymbol) {
  if (!deltaSymbol) return deltaSymbol;
  const entry = Object.entries(NOVA_TO_DELTA_OVERRIDES).find(([, v]) => v === deltaSymbol);
  return entry ? entry[0] : deltaSymbol;
}

class UnsupportedSymbolError extends Error {
  constructor(novaSymbol, detail) {
    super(`Symbol "${novaSymbol}" is not a supported/tradable Delta Exchange product${detail ? `: ${detail}` : ''}`);
    this.code = 'UNSUPPORTED_SYMBOL';
    this.status = 400;
  }
}

module.exports = { novaToDeltaSymbol, deltaToNovaSymbol, UnsupportedSymbolError };
