'use strict';

/**
 * Promotions module — clean boundary per master plan section 2.
 * All public API surfaces exported from here.
 */

const promotionEngine = require('./promotionEngine');
const contextBuilder = require('./contextBuilder');
const conditionEvaluator = require('./conditionEvaluator');
const benefitHandlers = require('./benefitHandlers');
const stackingResolver = require('./stackingResolver');
const redemptionService = require('./redemptionService');
const moneyUtils = require('./moneyUtils');

module.exports = {
  // Context (server-side facts only)
  buildPromotionContext: contextBuilder.buildPromotionContext,

  // Engine (main orchestrator)
  evaluatePromotions: promotionEngine.evaluatePromotions,
  simulatePromotions: promotionEngine.simulatePromotions,
  toCustomerView: promotionEngine.toCustomerView,
  getCustomerOffers: promotionEngine.getCustomerOffers,
  loadCandidatePromotions: promotionEngine.loadCandidatePromotions,
  validateCouponCodes: promotionEngine.validateCouponCodes,
  buildOfferLabel: promotionEngine.buildOfferLabel,

  // Condition evaluation
  evaluateConditions: conditionEvaluator.evaluateConditions,
  validateCondition: conditionEvaluator.validateCondition,

  // Benefit calculation
  calculateBenefit: benefitHandlers.calculateBenefit,

  // Stacking
  resolveAndApply: stackingResolver.resolveAndApply,
  detectConflicts: stackingResolver.detectConflicts,

  // Redemption ledger
  RedemptionError: redemptionService.RedemptionError,
  reserveRedemption: redemptionService.reserveRedemption,
  commitRedemption: redemptionService.commitRedemption,
  releaseRedemption: redemptionService.releaseRedemption,
  reverseRedemption: redemptionService.reverseRedemption,
  cleanupExpiredReservations: redemptionService.cleanupExpiredReservations,
  writeOrderAdjustments: redemptionService.writeOrderAdjustments,

  // Money utilities
  ...moneyUtils,
};
