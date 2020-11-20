/* eslint-disable no-param-reassign */
import { BigInt, ethereum, log } from '@graphprotocol/graph-ts';
import {
  FixedProductMarketMaker,
  MarketPosition,
  Transaction,
  Condition,
} from '../types/schema';
import {
  PositionsMerge,
  PositionSplit,
  PayoutRedemption,
} from '../types/ConditionalTokens/ConditionalTokens';
import {
  FPMMFundingAdded,
  FPMMFundingRemoved,
} from '../types/templates/FixedProductMarketMaker/FixedProductMarketMaker';
import { bigZero } from './constants';
import { max } from './maths';

/*
 * Returns the user's position for the given market and outcome
 * If no such position exists then a null position is generated
 */
export function getMarketPosition(
  user: string,
  market: string,
  outcomeIndex: BigInt,
): MarketPosition {
  let positionId = user + market + outcomeIndex.toString();
  let position = MarketPosition.load(positionId);
  if (position == null) {
    position = new MarketPosition(positionId);
    position.market = market;
    position.user = user;
    position.outcomeIndex = outcomeIndex;
    position.quantityBought = bigZero;
    position.quantitySold = bigZero;
    position.netQuantity = bigZero;
    position.valueBought = bigZero;
    position.valueSold = bigZero;
    position.netValue = bigZero;
  }
  return position as MarketPosition;
}

function updateNetPositionAndSave(position: MarketPosition): void {
  position.netQuantity = position.quantityBought.minus(position.quantitySold);
  position.netValue = position.valueBought.minus(position.valueSold);

  // A user has somehow sold more tokens then they have received
  // This means that we're tracking balances incorrectly.
  //
  // Note: this can also be tripped by someone manually transferring tokens
  //       to another address in order to sell them.
  if (position.netQuantity.lt(bigZero)) {
    log.error(
      'Invalid position: user {} has negative netQuantity on outcome {} on market {}',
      [position.user, position.outcomeIndex.toString(), position.market],
    );
  }

  position.save();
}

export function updateMarketPositionFromTrade(event: ethereum.Event): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction == null) {
    log.error('Could not find a transaction with hash: {}', [
      event.transaction.hash.toString(),
    ]);
    throw new Error('Could not find transaction with hash');
  }

  let position = getMarketPosition(
    transaction.user,
    transaction.market,
    transaction.outcomeIndex,
  );

  if (transaction.type == 'Buy') {
    position.quantityBought = position.quantityBought.plus(
      transaction.outcomeTokensAmount,
    );
    position.valueBought = position.valueBought.plus(transaction.tradeAmount);
  } else {
    position.quantitySold = position.quantitySold.plus(
      transaction.outcomeTokensAmount,
    );
    position.valueSold = position.valueSold.plus(transaction.tradeAmount);
  }

  updateNetPositionAndSave(position);
}

/*
 * Updates a user's market position after manually splitting collateral
 *
 * WARNING: This is only valid for markets which have a single condition
 * It assumes that the number of outcome slots on the market maker is equal to that on the condition
 */
export function updateMarketPositionsFromSplit(
  marketMakerAddress: string,
  event: PositionSplit,
): void {
  let userAddress = event.params.stakeholder.toHexString();
  let marketMaker = FixedProductMarketMaker.load(
    marketMakerAddress,
  ) as FixedProductMarketMaker;
  let totalSlots = marketMaker.outcomeSlotCount;
  for (let outcomeIndex = 0; outcomeIndex < totalSlots; outcomeIndex += 1) {
    let position = getMarketPosition(
      userAddress,
      marketMakerAddress,
      BigInt.fromI32(outcomeIndex),
    );
    // Event emits the amount of collateral to be split as `amount`
    position.quantityBought = position.quantityBought.plus(event.params.amount);

    // The user is essentially buys all tokens at an equal price
    let mergeValue = event.params.amount.div(BigInt.fromI32(totalSlots));
    position.valueBought = position.valueBought.plus(mergeValue);

    updateNetPositionAndSave(position);
  }
}

/*
 * Updates a user's market position after a merge
 *
 * WARNING: This is only valid for markets which have a single condition
 * It assumes that the number of outcome slots on the market maker is equal to that on the condition
 */
export function updateMarketPositionsFromMerge(
  marketMakerAddress: string,
  event: PositionsMerge,
): void {
  let userAddress = event.params.stakeholder.toHexString();
  let marketMaker = FixedProductMarketMaker.load(
    marketMakerAddress,
  ) as FixedProductMarketMaker;
  let totalSlots = marketMaker.outcomeSlotCount;
  for (let outcomeIndex = 0; outcomeIndex < totalSlots; outcomeIndex += 1) {
    let position = getMarketPosition(
      userAddress,
      marketMakerAddress,
      BigInt.fromI32(outcomeIndex),
    );
    // Event emits the amount of outcome tokens to be merged as `amount`
    position.quantitySold = position.quantitySold.plus(event.params.amount);

    // We treat it as the user selling tokens for equal values
    // TODO: weight for the prices in the market maker.
    let mergeValue = event.params.amount.div(BigInt.fromI32(totalSlots));
    position.valueSold = position.valueSold.plus(mergeValue);

    updateNetPositionAndSave(position);
  }
}

/*
 * Updates a user's market position after redeeming a position
 *
 * WARNING: This is only valid for markets which have a single condition
 * It assumes that the number of outcome slots on the market maker is equal to that on the condition
 */
export function updateMarketPositionsFromRedemption(
  marketMakerAddress: string,
  event: PayoutRedemption,
): void {
  let userAddress = event.params.redeemer.toHexString();
  let condition = Condition.load(
    event.params.conditionId.toHexString(),
  ) as Condition;

  let payoutNumerators = condition.payoutNumerators as BigInt[];
  let payoutDenominator = condition.payoutDenominator as BigInt;

  if (payoutNumerators == null || payoutDenominator == null) {
    log.error(
      'Failed to update market positions: condition {} has not resolved',
      [condition.id],
    );
    return;
  }

  let indexSets = event.params.indexSets;
  for (let i = 0; i < indexSets.length; i += 1) {
    // Each element of indexSets is the decimal representation of the binary slot of the given outcome
    // i.e. For a condition with 4 outcomes, ["1", "2", "4"] represents the first 3 slots as 0b0111
    // We can get the relevant slot by shifting a bit until we hit the correct index, e.g. 4 = 1 << 3
    let outcomeIndex = 0;
    // eslint-disable-next-line no-bitwise
    while (1 << outcomeIndex < indexSets[i].toI32()) {
      outcomeIndex += 1;
    }

    let position = getMarketPosition(
      userAddress,
      marketMakerAddress,
      BigInt.fromI32(outcomeIndex),
    );

    // Redeeming a position is an all or nothing operation so use full balance for calculations
    let numerator = payoutNumerators[outcomeIndex];
    let redemptionValue = position.netQuantity
      .times(numerator)
      .div(payoutDenominator);

    // position gets zero'd out
    position.quantitySold = position.quantitySold.plus(position.netQuantity);
    position.valueSold = position.valueSold.plus(redemptionValue);

    updateNetPositionAndSave(position);
  }
}

export function updateMarketPositionFromLiquidityAdded(
  event: FPMMFundingAdded,
): void {
  let fpmmAddress = event.address.toHexString();
  let funder = event.params.funder.toHexString();
  let amountsAdded = event.params.amountsAdded;

  // The amounts of outcome token are limited by the cheapest outcome.
  // This will have the full balance added to the market maker
  // therefore this is the amount of collateral that the user has split.
  let addedFunds = max(amountsAdded);

  // Calculate the full number of outcome tokens which are refunded to the funder address
  let totalRefundedOutcomeTokens = bigZero;
  for (
    let outcomeIndex = 0;
    outcomeIndex < amountsAdded.length;
    outcomeIndex += 1
  ) {
    let refundedAmount = addedFunds.minus(amountsAdded[outcomeIndex]);
    totalRefundedOutcomeTokens = totalRefundedOutcomeTokens.plus(
      refundedAmount,
    );
  }

  let outcomeTokenPrices = (FixedProductMarketMaker.load(
    fpmmAddress,
  ) as FixedProductMarketMaker).outcomeTokenPrices;

  // Funder is refunded with any excess outcome tokens which can't go into the market maker.
  // This means we must update the funder's market position for each outcome.
  for (
    let outcomeIndex = 0;
    outcomeIndex < amountsAdded.length;
    outcomeIndex += 1
  ) {
    // Event emits the number of outcome tokens added to the market maker
    // Subtract this from the amount of collateral added to get the amount refunded to funder
    let refundedAmount: BigInt = addedFunds.minus(amountsAdded[outcomeIndex]);
    if (refundedAmount.gt(bigZero)) {
      // Only update positions which have changed
      let position = getMarketPosition(
        funder,
        fpmmAddress,
        BigInt.fromI32(outcomeIndex),
      );

      position.quantityBought = position.quantityBought.plus(refundedAmount);

      let refundValue = refundedAmount
        .toBigDecimal()
        .times(outcomeTokenPrices[outcomeIndex])
        .truncate(0).digits;
      position.valueBought = position.valueBought.plus(refundValue);

      updateNetPositionAndSave(position);
    }
  }
}

export function updateMarketPositionFromLiquidityRemoved(
  event: FPMMFundingRemoved,
): void {
  let fpmmAddress = event.address.toHexString();
  let funder = event.params.funder.toHexString();
  let amountsRemoved = event.params.amountsRemoved;

  // We value each share at 1 USDC
  // so number of shares burnt is equal to price paid for all outcome tokens
  let sharesBurnt = event.params.sharesBurnt;

  // Outcome tokens are removed in proportion to their balances in the market maker
  // Therefore the withdrawal of each outcome token should have the same value.
  let pricePaidForTokens = sharesBurnt.div(
    BigInt.fromI32(amountsRemoved.length),
  );

  // The funder is sent all of the outcome tokens for which they were providing liquidity
  // This means we must update the funder's market position for each outcome.
  for (
    let outcomeIndex = 0;
    outcomeIndex < amountsRemoved.length;
    outcomeIndex += 1
  ) {
    let position = getMarketPosition(
      funder,
      fpmmAddress,
      BigInt.fromI32(outcomeIndex),
    );
    position.quantityBought = position.quantityBought.plus(
      amountsRemoved[outcomeIndex],
    );
    position.valueBought = position.valueBought.plus(pricePaidForTokens);

    updateNetPositionAndSave(position);
  }
}
