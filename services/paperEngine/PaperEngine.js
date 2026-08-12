'use strict';

const mongoose = require('mongoose');
const { env } = require('../../config/env');
const PaperAccount = require('../../models/PaperAccount');
const Order = require('../../models/Order');
const Position = require('../../models/Position');
const Trade = require('../../models/Trade');
const { getMarketDataProvider } = require('../marketData');
const { newOrderId } = require('../../utils/ids');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/apiResponse');
const { computeNotional, computeMargin, computeFee, computePnl, computeMultiTargets } = require('../../utils/pnl');

/**
 * PaperEngine — complete virtual execution engine. Paper trades NEVER reach
 * Delta Exchange. All balances/positions/orders are persisted in MongoDB.
 *
 * P&L formulas (documented assumptions):
 *   notional        = entryPrice * quantity
 *   margin          = notional / leverage
 *   fee             = notional * feeRate   (charged on open AND close, taker rate used for market orders)
 *   LONG  unrealizedPnl = (currentPrice - entryPrice) * quantity
 *   SHORT unrealizedPnl = (entryPrice - currentPrice) * quantity
 *   realizedPnl (on close) = the unrealized formula evaluated at exitPrice, minus total fees (open+close)
 *   equity = availableBalance + lockedMargin + sum(unrealizedPnl of open positions)
 *
 * This is a simplified (but internally consistent) model: it does not
 * simulate slippage, partial fills, order book depth, or funding payments.
 */
class PaperEngine {
  async ensureAccount(userId) {
    let account = await PaperAccount.findOne({ user: userId });
    if (!account) {
      account = await PaperAccount.create({
        user: userId,
        availableBalance: env.PAPER_INITIAL_BALANCE_USD,
        lockedMargin: 0,
      });
      await logger.info('TRADING', `Paper account initialized for user ${userId} with $${env.PAPER_INITIAL_BALANCE_USD}`);
    }
    return account;
  }

  async addFunds(userId, amount, reason = 'manual top-up') {
    if (!amount || amount <= 0) throw new AppError('amount must be positive', 400);
    const account = await this.ensureAccount(userId);
    account.availableBalance += amount;
    account.fundingHistory.push({ amount, reason, at: new Date() });
    await account.save();
    await logger.info('TRADING', `Added $${amount} virtual funds to user ${userId} paper account`, { reason });
    return account;
  }

  /**
   * Opens a paper position (LONG or SHORT) via a simulated market order.
   * @param {object} params { userId, symbol, side: 'LONG'|'SHORT', quantity, leverage, stopLoss, takeProfit, source, modelId, instanceId, commandId }
   */
  async openPosition(params) {
    const {
      userId, symbol, side, quantity, leverage = 1,
      stopLoss = null, takeProfit = null,
      source = 'MANUAL', modelId = null, instanceId = null, commandId = null,
    } = params;

    if (!['LONG', 'SHORT'].includes(side)) throw new AppError('side must be LONG or SHORT', 400);
    if (!quantity || quantity <= 0) throw new AppError('quantity must be positive', 400);
    if (leverage <= 0 || leverage > env.PAPER_MAX_LEVERAGE) {
      throw new AppError(`leverage must be between 0 and ${env.PAPER_MAX_LEVERAGE}`, 400);
    }

    const provider = getMarketDataProvider();
    let priceInfo;
    try {
      priceInfo = await provider.getPrice(symbol);
    } catch (err) {
      throw new AppError(`Cannot open paper position: no valid market price for ${symbol} (${err.message})`, 503);
    }
    if (!provider.isDataFresh(symbol)) {
      throw new AppError(`Cannot open paper position: market data for ${symbol} is stale`, 503);
    }

    const entryPrice = priceInfo.price;
    const notional = computeNotional(entryPrice, quantity);
    const margin = computeMargin(notional, leverage);
    const fee = computeFee(notional, env.PAPER_TAKER_FEE_RATE);

    // Multi-target exits (confirmed rules): 4 R-multiple targets, 25% each,
    // derived from entryPrice/stopLoss alone — requires no change to
    // whichever model produced this command. Positions opened without a
    // stopLoss get no targets (existing single-takeProfit behavior, if any,
    // is unaffected).
    const targets = computeMultiTargets(side, entryPrice, stopLoss, quantity) || [];
    const effectiveTakeProfit = targets.length ? null : takeProfit; // replaced by targets, per confirmed rule

    const account = await this.ensureAccount(userId);
    const requiredFunds = margin + fee;
    if (account.availableBalance < requiredFunds) {
      const order = await Order.create({
        internalOrderId: newOrderId(),
        environment: 'PAPER',
        source,
        user: userId,
        modelId,
        instanceId,
        commandId,
        symbol,
        side: side === 'LONG' ? 'buy' : 'sell',
        type: 'market',
        quantity,
        requestedPrice: entryPrice,
        leverage,
        stopLoss,
        takeProfit,
        status: 'REJECTED',
        rejectionReason: 'Insufficient paper balance',
      });
      await logger.warn('TRADING', `Paper order ${order.internalOrderId} rejected: insufficient balance`);
      throw new AppError(`Insufficient paper balance: available=${account.availableBalance.toFixed(2)}, required=${requiredFunds.toFixed(2)}`, 400);
    }

    const session = await mongoose.startSession();
    let position;
    let order;
    try {
      await session.withTransaction(async () => {
        account.availableBalance -= requiredFunds;
        account.lockedMargin += margin;
        account.totalFeesPaid += fee;
        await account.save({ session });

        const positions = await Position.create(
          [{
            environment: 'PAPER',
            source,
            user: userId,
            modelId,
            instanceId,
            symbol,
            side,
            entryPrice,
            currentPrice: entryPrice,
            quantity,
            originalQuantity: quantity,
            leverage,
            margin,
            stopLoss,
            takeProfit: effectiveTakeProfit,
            targets,
            unrealizedPnl: 0,
            feesPaid: fee,
            status: 'OPEN',
          }],
          { session }
        );
        position = positions[0];

        const orders = await Order.create(
          [{
            internalOrderId: newOrderId(),
            environment: 'PAPER',
            source,
            user: userId,
            modelId,
            instanceId,
            commandId,
            symbol,
            side: side === 'LONG' ? 'buy' : 'sell',
            type: 'market',
            quantity,
            requestedPrice: entryPrice,
            executedPrice: entryPrice,
            leverage,
            stopLoss,
            takeProfit: effectiveTakeProfit,
            fees: fee,
            status: 'FILLED',
            relatedPosition: position._id,
            submittedAt: new Date(),
            filledAt: new Date(),
          }],
          { session }
        );
        order = orders[0];
      });
    } finally {
      session.endSession();
    }

    await logger.info('TRADING', `Paper position opened: ${side} ${quantity} ${symbol} @ ${entryPrice}`, {
      positionId: position._id.toString(), source, instanceId,
    });

    return { position, order, account };
  }

  /**
   * Closes an open paper position at current market price.
   * @param {object} params { positionId, reason }
   */
  async closePosition({ positionId, reason = 'MANUAL', exitPriceOverride = null }) {
    let exitPrice = exitPriceOverride;
    if (exitPrice === null || exitPrice === undefined) {
      // Only used when finalizing a multi-target position whose remaining
      // quantity is already 0 (T4 case) — there is no live market
      // quantity left to price, so the recorded exit is T4's own price.
      // For every other close, a live price is needed, which requires
      // knowing the symbol. This lookup is read-only and used ONLY to
      // pick which symbol to fetch a price for — it is never used to
      // decide whether the position is OPEN or to compute anything else;
      // that authoritative decision happens exclusively via the atomic
      // claim inside the transaction below.
      const peek = await Position.findById(positionId).select('symbol').lean();
      if (!peek) throw new AppError('Position not found', 404);
      const provider = getMarketDataProvider();
      try {
        const priceInfo = await provider.getPrice(peek.symbol);
        exitPrice = priceInfo.price;
      } catch (err) {
        throw new AppError(`Cannot close paper position: no valid market price (${err.message})`, 503);
      }
    }

    // Finalization is now ONE atomic transaction, start to finish: the
    // OPEN->CLOSED claim, account settlement, Position close-field update,
    // Trade creation, and the conditional closing Order are all inside the
    // same session.withTransaction(...) callback. If ANYTHING later in
    // this callback throws — account settlement, Trade creation, whatever
    // — MongoDB rolls back the ENTIRE transaction, including the claim
    // itself. A failed finalization attempt can therefore never leave a
    // position stuck CLOSED with no Trade/Order/account settlement; it is
    // left exactly as it was: OPEN.
    //
    // Concurrent callers: only one of two racing closePosition() calls can
    // ever have its findOneAndUpdate({status:'OPEN'}) match — the other
    // gets null and throws immediately inside its own transaction (which
    // is then trivially rolled back, since it made no writes), never
    // reaching account settlement or Trade creation.
    let closedPosition = null;
    let realizedPnl = null;
    let totalFees = null;
    let tradeQuantity = null;
    let account = null;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const position = await Position.findOneAndUpdate(
          { _id: positionId, status: 'OPEN' },
          { $set: { status: 'CLOSED' } },
          { new: false, session }
        );
        if (!position) {
          const exists = await Position.exists({ _id: positionId }).session(session);
          if (!exists) throw new AppError('Position not found', 404);
          // Exists but wasn't OPEN — either already closed by a concurrent
          // caller (the exact race this fix closes) or a genuine caller
          // error. No writes have been made yet, so throwing here is a
          // pure no-op rollback: nothing to undo.
          throw new AppError('Position is not open', 400);
        }
        if (position.environment !== 'PAPER') {
          throw new AppError('Not a paper position', 400); // rolls back the claim automatically — no manual undo needed
        }

        // quantity remaining on the position right now — for an ordinary
        // (non-multi-target, or SL-before-targets) close this is the
        // full/only quantity, unchanged from before. For a multi-target
        // position whose final target already zeroed it out, this is
        // legitimately 0 — the notional/fee/pnl contribution of THIS call
        // is then correctly 0, and the full result comes entirely from
        // position.realizedPnl already accumulated by the prior partial
        // fills (see _applyPartialTargetFill).
        const closingQuantity = position.quantity;
        const notional = computeNotional(exitPrice, closingQuantity);
        const closeFee = computeFee(notional, env.PAPER_TAKER_FEE_RATE);
        const grossPnl = computePnl(position.side, position.entryPrice, exitPrice, closingQuantity);

        totalFees = position.feesPaid + closeFee;
        // Folds in any PnL already realized by earlier partial target
        // fills — 0 for every existing (non-multi-target) position, so
        // this is fully backward compatible.
        realizedPnl = grossPnl - closeFee + (position.realizedPnl || 0);

        // Trade record quantity: the remaining quantity for a normal
        // close, or the full original size when a multi-target position
        // was fully exited across its 4 tranches (closingQuantity is 0 in
        // that case, which would misleadingly show a "0 quantity" trade).
        tradeQuantity = closingQuantity > 0 ? closingQuantity : (position.originalQuantity || closingQuantity);

        account = await this.ensureAccount(position.user);
        // Atomic $inc rather than read-modify-write-then-save: `account`
        // was just loaded, but if withTransaction ever retries this whole
        // callback (e.g. on a write-conflict with another concurrent
        // transaction touching the same account document), a plain
        // `.save()` of a closure-captured object risks reapplying a stale
        // delta. $inc is a pure relative adjustment — safe under retry,
        // and safe to run concurrently with any other $inc on the same
        // document (MongoDB serializes them; neither can be lost).
        await PaperAccount.updateOne(
          { _id: account._id },
          {
            $inc: {
              lockedMargin: -position.margin,
              availableBalance: position.margin + grossPnl - closeFee,
              totalRealizedPnl: grossPnl - closeFee,
              totalFeesPaid: closeFee,
            },
          },
          { session }
        );

        await Position.updateOne(
          { _id: position._id },
          {
            $set: {
              currentPrice: exitPrice,
              unrealizedPnl: 0,
              realizedPnl,
              feesPaid: totalFees,
              closedAt: new Date(),
              closeReason: reason,
            },
          },
          { session }
        );
        position.closedAt = new Date();

        await Trade.create(
          [{
            environment: 'PAPER',
            source: position.source,
            user: position.user,
            modelId: position.modelId,
            instanceId: position.instanceId,
            position: position._id,
            symbol: position.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            quantity: tradeQuantity,
            leverage: position.leverage,
            realizedPnl,
            fees: totalFees,
            reason,
            openedAt: position.openedAt,
            closedAt: position.closedAt,
          }],
          { session }
        );

        // A closing Order is only meaningful when THIS call actually
        // executes a real fill (closingQuantity > 0). When a multi-target
        // position's 4th target already reduced quantity to exactly 0,
        // this call is a pure bookkeeping finalization — the 4 real fills
        // already have their own Order records from
        // _applyPartialTargetFill. Creating a 5th Order sized by
        // originalQuantity here would misleadingly show a fake 100% fill
        // for an execution that never happened at this moment.
        if (closingQuantity > 0) {
          await Order.create(
            [{
              internalOrderId: newOrderId(),
              environment: 'PAPER',
              source: position.source,
              user: position.user,
              modelId: position.modelId,
              instanceId: position.instanceId,
              symbol: position.symbol,
              side: position.side === 'LONG' ? 'sell' : 'buy',
              type: 'market',
              quantity: tradeQuantity,
              requestedPrice: exitPrice,
              executedPrice: exitPrice,
              leverage: position.leverage,
              fees: closeFee,
              status: 'FILLED',
              relatedPosition: position._id,
              submittedAt: new Date(),
              filledAt: new Date(),
            }],
            { session }
          );
        }

        closedPosition = position; // pre-close snapshot; patched below to reflect the committed final state
      });
    } finally {
      session.endSession();
    }

    // Patch the in-memory snapshot (still showing pre-close values, since
    // `closedPosition` is the PRE-update document returned by the atomic
    // claim) to reflect what was actually committed, for callers that read
    // result.position (e.g. the manual-close API response).
    closedPosition.status = 'CLOSED';
    closedPosition.currentPrice = exitPrice;
    closedPosition.unrealizedPnl = 0;
    closedPosition.realizedPnl = realizedPnl;
    closedPosition.feesPaid = totalFees;
    closedPosition.closeReason = reason;

    await logger.info('TRADING', `Paper position closed: ${closedPosition.side} ${tradeQuantity} ${closedPosition.symbol} @ ${exitPrice}, pnl=${realizedPnl.toFixed(2)}`, {
      positionId: closedPosition._id.toString(), reason,
    });

    return { position: closedPosition, realizedPnl, account };
  }

  /**
   * Updates an open PAPER position's stop-loss (trailing stop). This is the
   * ONLY field this method touches — no margin/notional/account balance
   * changes, since a tighter stop never changes the position's size or
   * locked margin. refreshUnrealizedForSymbol() (below) already re-reads
   * position.stopLoss fresh on every price tick, so writing it here is
   * sufficient for the new stop to take effect on the very next tick — no
   * separate "activate" step needed.
   *
   * Only ever tightens the stop: a LONG's stop may only move up, a SHORT's
   * stop may only move down. This is enforced here (not just trusted from
   * the caller) so a bug in a bot model's own trailing-stop math can never
   * accidentally loosen a stop and increase risk on an open position.
   */
  async updateStopLoss({ positionId, stopLoss }) {
    if (stopLoss === undefined || stopLoss === null || !Number.isFinite(Number(stopLoss)) || Number(stopLoss) <= 0) {
      throw new AppError('stopLoss must be a positive number', 400);
    }
    const position = await Position.findById(positionId);
    if (!position) throw new AppError('Position not found', 404);
    if (position.status !== 'OPEN') throw new AppError('Cannot modify stop-loss on a non-OPEN position', 400);
    if (position.targets && position.targets.length) {
      throw new AppError('Cannot modify stop-loss on a multi-target position — the original SL never changes for these positions', 400);
    }

    const nextStopLoss = Number(stopLoss);
    if (position.stopLoss != null) {
      if (position.side === 'LONG' && nextStopLoss < position.stopLoss) {
        throw new AppError(`Refusing to loosen LONG stop-loss (${position.stopLoss} -> ${nextStopLoss})`, 400);
      }
      if (position.side === 'SHORT' && nextStopLoss > position.stopLoss) {
        throw new AppError(`Refusing to loosen SHORT stop-loss (${position.stopLoss} -> ${nextStopLoss})`, 400);
      }
    }

    const previousStopLoss = position.stopLoss;
    position.stopLoss = nextStopLoss;
    await position.save();

    await logger.info('TRADING', `Paper position ${position._id} stop-loss trailed: ${previousStopLoss} -> ${nextStopLoss}`, {
      positionId: position._id.toString(), symbol: position.symbol,
    });

    return { position };
  }

  /**
   * Applies ONE target's partial fill to an OPEN multi-target position:
   * reduces remaining quantity/margin by that target's slice, credits the
   * account for that slice's PnL/fee immediately (real money movement,
   * same as any other fill), and accumulates the slice's PnL into
   * position.realizedPnl for the eventual single, final Trade record.
   * Does NOT create a Trade document and does NOT change position.status —
   * per the confirmed design, only the position's actual final close
   * (all 4 targets exhausted, or the original SL hit on what remains)
   * creates the one Trade record, with this cumulative total folded in.
   * Runs inside the caller's transaction/session.
   */
  /**
   * Atomically claims and applies ONE target's partial fill. Uses a
   * conditional MongoDB update (`'targets.hit': false` in the filter) as
   * the exactly-once guard — not the in-memory `target.hit` flag alone,
   * which can be stale if two overlapping refreshUnrealizedForSymbol()
   * calls (e.g. two market-data ticks whose async handlers overlap,
   * since the provider does not await each subscriber before firing the
   * next tick) both read the same position before either commits. If this
   * update matches zero documents, another concurrent invocation already
   * claimed this exact target — returns null, and the caller must treat
   * that as "nothing to do," never retry or double-apply it.
   *
   * Also closes the float-residual gap (T1-T4 quantities are each exactly
   * 25% of ORIGINAL quantity by construction — see computeMultiTargets —
   * but four independent sequential subtractions on position.quantity can
   * still leave a ~1e-16 residual instead of exact 0): once this update
   * reveals all 4 targets are now hit, the remaining quantity is pinned to
   * exactly 0 in the same transaction, never left to trust cumulative
   * floating-point subtraction.
   */
  async _applyPartialTargetFill(session, position, account, target) {
    const sliceQuantity = target.quantity;
    const sliceNotionalAtEntry = computeNotional(position.entryPrice, sliceQuantity);
    const sliceMargin = computeMargin(sliceNotionalAtEntry, position.leverage);
    const sliceNotionalAtExit = computeNotional(target.price, sliceQuantity);
    const sliceFee = computeFee(sliceNotionalAtExit, env.PAPER_TAKER_FEE_RATE);
    const slicePnl = computePnl(position.side, position.entryPrice, target.price, sliceQuantity);

    const claimed = await Position.findOneAndUpdate(
      { _id: position._id, targets: { $elemMatch: { rMultiple: target.rMultiple, hit: false } } },
      {
        $set: { 'targets.$.hit': true, 'targets.$.hitAt': new Date() },
        $inc: {
          quantity: -sliceQuantity,
          margin: -sliceMargin,
          realizedPnl: slicePnl - sliceFee,
          feesPaid: sliceFee,
        },
      },
      { new: true, session }
    );
    if (!claimed) {
      // Lost the race — some other concurrent call already filled this
      // exact target. Not an error: skip entirely, no double credit.
      return null;
    }

    if (claimed.targets.every((t) => t.hit) && claimed.quantity !== 0) {
      await Position.updateOne({ _id: position._id }, { $set: { quantity: 0 } }, { session });
      claimed.quantity = 0;
    }

    // Atomic $inc, not read-modify-write-then-save — same reasoning as
    // closePosition(): `account` is loaded once, outside this transaction,
    // in refreshUnrealizedForSymbol's caller loop, and reused across every
    // target processed this tick. If withTransaction ever retries this
    // callback (write conflict with another concurrent transaction on the
    // same account document), a plain `.save()` of this stale
    // closure-captured object would silently reapply the same delta a
    // second time. $inc is a pure relative adjustment — safe under retry,
    // and safe to run concurrently with any other $inc on the same
    // document (MongoDB serializes them; neither delta can be lost).
    await PaperAccount.updateOne(
      { _id: account._id },
      {
        $inc: {
          lockedMargin: -sliceMargin,
          availableBalance: sliceMargin + slicePnl - sliceFee,
          totalRealizedPnl: slicePnl - sliceFee,
          totalFeesPaid: sliceFee,
        },
      },
      { session }
    );

    await Order.create(
      [{
        internalOrderId: newOrderId(),
        environment: 'PAPER',
        source: position.source,
        user: position.user,
        modelId: position.modelId,
        instanceId: position.instanceId,
        symbol: position.symbol,
        side: position.side === 'LONG' ? 'sell' : 'buy',
        type: 'market',
        quantity: sliceQuantity,
        requestedPrice: target.price,
        executedPrice: target.price,
        leverage: position.leverage,
        fees: sliceFee,
        status: 'FILLED',
        relatedPosition: position._id,
        submittedAt: new Date(),
        filledAt: new Date(),
      }],
      { session }
    );

    await logger.info(
      'TRADING',
      `Paper position ${position._id} target T${target.rMultiple} filled: ${sliceQuantity} ${position.symbol} @ ${target.price}, slice pnl=${(slicePnl - sliceFee).toFixed(2)}`,
      { positionId: position._id.toString(), rMultiple: target.rMultiple }
    );

    return claimed;
  }

  /**
   * Refreshes unrealizedPnl for all open paper positions of a symbol using the
   * latest market price. Called from a market-data subscription callback or
   * on an interval. Also checks stop-loss / take-profit triggers.
   */
  async refreshUnrealizedForSymbol(symbol, currentPrice) {
    const openPositions = await Position.find({ environment: 'PAPER', symbol, status: 'OPEN' });
    for (const position of openPositions) {
      const unrealizedPnl = computePnl(position.side, position.entryPrice, currentPrice, position.quantity);

      // Scoped update — touches ONLY currentPrice/unrealizedPnl, never the
      // rest of the document. `position` here was loaded moments ago and
      // may already be stale by the time this write lands (an overlapping
      // tick's target-fill or finalization transaction can commit
      // quantity/margin/targets.hit/realizedPnl changes in between). A
      // plain position.save() risks writing back this now-stale in-memory
      // snapshot's other fields; this update cannot, by construction —
      // there is no way for it to touch anything but the two fields named
      // here, regardless of what changed concurrently underneath it.
      await Position.updateOne(
        { _id: position._id, status: 'OPEN' },
        { $set: { currentPrice, unrealizedPnl } }
      );
      position.currentPrice = currentPrice;
      position.unrealizedPnl = unrealizedPnl;

      if (position.targets && position.targets.length) {
        // Multi-target position: process every not-yet-hit target this
        // tick has crossed, in R order (confirmed rule 5 — targets first),
        // THEN evaluate the untouched original SL against whatever
        // quantity remains. No breakeven, no trailing — stopLoss is never
        // modified here or anywhere else for these positions.
        const crossedTargets = position.targets
          .filter((t) => !t.hit)
          .filter((t) => (position.side === 'LONG' ? currentPrice >= t.price : currentPrice <= t.price))
          .sort((a, b) => a.rMultiple - b.rMultiple);

        if (crossedTargets.length) {
          const account = await this.ensureAccount(position.user);
          const session = await mongoose.startSession();
          try {
            await session.withTransaction(async () => {
              for (const target of crossedTargets) {
                await this._applyPartialTargetFill(session, position, account, target);
              }
            });
          } finally {
            session.endSession();
          }
          // _applyPartialTargetFill updates quantity/targets/margin/
          // realizedPnl atomically in the database directly (see its own
          // doc comment) — the in-memory `position` object loaded at the
          // top of this loop iteration is now stale for those fields.
          // Re-fetch the authoritative state before deciding what happens
          // next; never call position.save() here, which would overwrite
          // the atomic updates with the stale pre-fill snapshot.
          const refreshed = await Position.findById(position._id);
          if (!refreshed || refreshed.status !== 'OPEN') continue; // already finalized by a concurrent call
          Object.assign(position, refreshed.toObject());
        }

        if (position.quantity <= 0) {
          // All 4 targets exhausted — finalize using the LAST target's
          // price (nothing left to fetch a live market price against).
          const lastTarget = position.targets[position.targets.length - 1];
          try {
            await this.closePosition({ positionId: position._id, reason: 'TAKE_PROFIT', exitPriceOverride: lastTarget.price });
          } catch (err) {
            await logger.error('TRADING', `Failed to finalize position ${position._id} after all targets hit: ${err.message}`);
          }
          continue; // position is closed — nothing left to check
        }

        // Remaining quantity still open — evaluate the untouched original SL.
        if (position.stopLoss != null) {
          const slHit = position.side === 'LONG' ? currentPrice <= position.stopLoss : currentPrice >= position.stopLoss;
          if (slHit) {
            try {
              await this.closePosition({ positionId: position._id, reason: 'STOP_LOSS' });
            } catch (err) {
              await logger.error('TRADING', `Failed to auto-close position ${position._id} on STOP_LOSS: ${err.message}`);
            }
          }
        }
        continue;
      }

      // No multi-target plan (stopLoss was not provided at open) — existing
      // single stop-loss / single take-profit behavior, unchanged.
      let triggerReason = null;
      if (position.stopLoss != null) {
        if (position.side === 'LONG' && currentPrice <= position.stopLoss) triggerReason = 'STOP_LOSS';
        if (position.side === 'SHORT' && currentPrice >= position.stopLoss) triggerReason = 'STOP_LOSS';
      }
      if (!triggerReason && position.takeProfit != null) {
        if (position.side === 'LONG' && currentPrice >= position.takeProfit) triggerReason = 'TAKE_PROFIT';
        if (position.side === 'SHORT' && currentPrice <= position.takeProfit) triggerReason = 'TAKE_PROFIT';
      }
      if (triggerReason) {
        try {
          await this.closePosition({ positionId: position._id, reason: triggerReason });
        } catch (err) {
          await logger.error('TRADING', `Failed to auto-close position ${position._id} on ${triggerReason}: ${err.message}`);
        }
      }
    }
  }
}

module.exports = new PaperEngine();
