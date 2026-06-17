/**
 * Amount collected at pickup (minimum order hold + service fee + driver tip).
 */
function getPickupChargeAmount(upfrontAmount, serviceCharge, driverTip = 0) {
    const upfront = parseFloat(upfrontAmount) || 0;
    const service = parseFloat(serviceCharge) || 0;
    const tip = parseFloat(driverTip) || 0;
    return parseFloat((upfront + service + tip).toFixed(2));
}

/**
 * Prepaid amount to deduct from final invoice (same as pickup charge).
 */
function getPrepaidInvoiceDeduction(upfrontAmount, serviceCharge, driverTip = 0) {
    return getPickupChargeAmount(upfrontAmount, serviceCharge, driverTip);
}

module.exports = {
    getPickupChargeAmount,
    getPrepaidInvoiceDeduction,
};
