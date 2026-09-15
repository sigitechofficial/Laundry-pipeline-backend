'use strict';

function addOnQty(addon) {
    const parsed = Number(addon && (addon.items ?? addon.qty));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function addOnName(addon) {
    if (!addon) return 'Add-on';
    const nested = addon.addOnService && addon.addOnService.name;
    const raw = nested || addon.name || 'Add-on';
    const name = String(raw).trim();
    return name || 'Add-on';
}

function addOnInstructions(addon) {
    const raw = addon && addon.instructions;
    if (raw == null) return null;
    const text = String(raw).trim();
    return text || null;
}

function formatAddOnTagPart(addon) {
    const qty = addOnQty(addon);
    const label = `${addOnName(addon)} x${qty}`;
    const instructions = addOnInstructions(addon);
    return instructions ? `${label}: ${instructions}` : label;
}

/**
 * Tag payload used by agent Receipt & Tags (58mm). Names alone are not enough —
 * shop floor needs the per-add-on instruction on the same line.
 */
function buildAddOnsForTag(lineAddOns) {
    const list = (lineAddOns || []).map((addon) => {
        const qty = addOnQty(addon);
        return {
            addOnServiceId: addon.addOnServiceId ?? addon.addOnService?.id ?? null,
            name: addOnName(addon),
            items: qty,
            qty,
            instructions: addOnInstructions(addon),
        };
    });
    const display = list.length ? list.map(formatAddOnTagPart).join(', ') : 'No add-ons';
    return { list, display };
}

module.exports = {
    addOnQty,
    addOnName,
    addOnInstructions,
    formatAddOnTagPart,
    buildAddOnsForTag,
};
