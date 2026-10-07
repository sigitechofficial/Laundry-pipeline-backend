'use strict';

/**
 * Promotions module — clean boundary per master plan section 2.
 * All public API surfaces exported from here.
 */

const promotionEngine = require('./promotionEngine');
const conditionEvaluator = require('./conditionEvaluator');
const benefitHandlers = require('./benefitHandlers');
const stackingResolver = require('./stackingResolver');
const redemptionService = require('./redemptionService');
const moneyUtils = require('./moneyUtils');

module.exports = {
  // Engine (main orchestrator)
  evaluatePromotions: promotionEngine.evaluatePromotions,
  simulatePromotions: promotionEngine.simulatePromotions,
  getCustomerOffers: promotionEngine.getCustomerOffers,
  loadCandidatePromotions: promotionEngine.loadCandidatePromotions,
  validateCouponCodes: promotionEngine.validateCouponCodes,
  buildOfferLabel: promotionEngine.buildOfferLabel,

  // Condition evaluation
  evaluateConditions: conditionEvaluator.evaluateConditions,

  // Benefit calculation
  calculateBenefit: benefitHandlers.calculateBenefit,

  // Stacking
  resolveStacking: stackingResolver.resolveStacking,
  detectConflicts: stackingResolver.detectConflicts,

  // Redemption ledger
  reserveRedemption: redemptionService.reserveRedemption,
  commitRedemption: redemptionService.commitRedemption,
  releaseRedemption: redemptionService.releaseRedemption,
  reverseRedemption: redemptionService.reverseRedemption,
  cleanupExpiredReservations: redemptionService.cleanupExpiredReservations,
  writeOrderAdjustments: redemptionService.writeOrderAdjustments,

  // Money utilities
  ...moneyUtils,
};
