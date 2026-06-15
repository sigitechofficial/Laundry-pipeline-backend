/**
 * Amount collected at pickup (minimum order hold + service fee).
 */
function getPickupChargeAmount(upfrontAmount, serviceCharge) {
    const upfront = parseFloat(upfrontAmount) || 0;
    const service = parseFloat(serviceCharge) || 0;
    return parseFloat((upfront + service).toFixed(2));
}

/**
 * Prepaid amount to deduct from final invoice (same as pickup charge).
 */
function getPrepaidInvoiceDeduction(upfrontAmount, serviceCharge) {
    return getPickupChargeAmount(upfrontAmount, serviceCharge);
}

module.exports = {
    getPickupChargeAmount,
    getPrepaidInvoiceDeduction,
};
