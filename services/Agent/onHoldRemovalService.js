/**
 * Applies the customer's on-hold decisions to the invoice.
 *
 * OnHoldConfirmation fields:
 *   responseConformation  the customer has answered this row
 *   customerResponse      true = keep / clean as normal, false = remove from the order
 *                         (same meaning in the customer app and the website)
 *   deleted               the shop has dealt with the answer: the removal is applied,
 *                         or a "keep" row was acknowledged by an older agent app build
 *   noOfItems             pieces of that service line the shop put on hold
 */
const { Op } = require("sequelize");
const {
    OnHoldConfirmation,
    customerSelectedService,
    customerSelectedServiceLine,
    customerSelectedServiceAddOn,
    customerSelectedRepairItem,
} = require("../../models");
const invoiceManagementService = require("./invoiceManagementService");

function isTrue(value) {
    return value === true || value === 1 || value === "1";
}

function onHoldKey(serviceId, subCategoryId) {
    return `${Number(serviceId)}:${Number(subCategoryId)}`;
}

function onHoldPieces(row) {
    const qty = Number(row?.noOfItems);
    return Number.isInteger(qty) && qty > 0 ? qty : 1;
}

function isPendingRemoval(row) {
    return (
        isTrue(row.responseConformation) &&
        !isTrue(row.customerResponse) &&
        !isTrue(row.deleted)
    );
}

function isAwaitingCustomer(row) {
    return !isTrue(row.deleted) && !isTrue(row.responseConformation);
}

/**
 * Take `removeQty` pieces off one invoice line. The whole line goes when every
 * piece is removed, or when it is a repair line (its price comes from the
 * garments, not the quantity). Otherwise pieces come off the last split lines
 * first so that sum(split lines) still equals the service quantity.
 * @returns {Promise<number>} pieces actually removed
 */
async function removePiecesFromLine(line, removeQty) {
    const current = Number(line.items) || 0;
    const repairCount = customerSelectedRepairItem
        ? await customerSelectedRepairItem.count({
              where: { customerSelectedServiceId: line.id },
          })
        : 0;

    if (removeQty >= current || repairCount > 0) {
        await line.update({ status: false });
        return current;
    }

    const newItems = current - removeQty;
    const splitLines = await customerSelectedServiceLine.findAll({
        where: { customerSelectedServiceId: line.id },
        order: [
            ["lineNum", "DESC"],
            ["id", "DESC"],
        ],
    });

    let remaining = removeQty;
    for (const split of splitLines) {
        if (remaining <= 0) break;
        const splitItems = Number(split.items) || 0;
        const take = Math.min(splitItems, remaining);
        remaining -= take;
        const left = splitItems - take;
        if (left <= 0) {
            await customerSelectedServiceAddOn.destroy({
                where: { customerSelectedServiceLineId: split.id },
            });
            await split.destroy();
        } else {
            await split.update({ items: left });
            // An add-on can't cover more pieces than its line still has.
            await customerSelectedServiceAddOn.update(
                { items: left },
                {
                    where: {
                        customerSelectedServiceLineId: split.id,
                        items: { [Op.gt]: left },
                    },
                }
            );
        }
    }

    // Legacy flat add-ons (no split line) are capped to the new quantity.
    await customerSelectedServiceAddOn.update(
        { items: newItems },
        {
            where: {
                customerSelectedServiceId: line.id,
                customerSelectedServiceLineId: null,
                items: { [Op.gt]: newItems },
            },
        }
    );

    await line.update({ items: newItems });
    return removeQty;
}

/**
 * Remove the pieces the customer asked to remove, mark those rows handled and
 * recalculate the invoice totals.
 * @param {number} bookingId
 * @param {{ keys?: string[] }} [options] limit to these "serviceId:subCategoryId" keys
 * @returns {Promise<{ changed: boolean, removedPieces: number }>}
 */
async function applyCustomerRemovals(bookingId, { keys = null } = {}) {
    const wanted = Array.isArray(keys) ? new Set(keys) : null;
    const rows = await OnHoldConfirmation.findAll({ where: { bookingId } });

    const groups = new Map();
    for (const row of rows) {
        if (!isPendingRemoval(row)) continue;
        const key = onHoldKey(row.serviceId, row.subCategoryId);
        if (wanted && !wanted.has(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    let removedPieces = 0;
    for (const group of groups.values()) {
        let remaining = group.reduce((sum, row) => sum + onHoldPieces(row), 0);
        const lines = await customerSelectedService.findAll({
            where: {
                bookingId,
                serviceId: group[0].serviceId,
                subCategoryId: group[0].subCategoryId,
                status: true,
            },
            order: [["id", "DESC"]],
        });
        for (const line of lines) {
            if (remaining <= 0) break;
            const removed = await removePiecesFromLine(
                line,
                Math.min(remaining, Number(line.items) || 0)
            );
            remaining -= removed;
            removedPieces += removed;
        }
        await OnHoldConfirmation.update(
            { deleted: true },
            { where: { id: group.map((row) => row.id) } }
        );
    }

    if (removedPieces > 0) {
        await invoiceManagementService.finalizeInvoiceDraftTotals({
            bookingId,
            preserveInvoiceStatus: true,
        });
    }

    return { changed: removedPieces > 0, removedPieces };
}

/**
 * Older agent app builds read customerResponse = true as "remove" and send
 * those rows to agentUpdateInvoice. Nothing is removed for a "keep" answer;
 * the row is only marked handled so the old build can move on.
 */
async function acknowledgeKeptRows(bookingId, keys) {
    const wanted = new Set(keys);
    const rows = await OnHoldConfirmation.findAll({ where: { bookingId } });
    const ids = rows
        .filter(
            (row) =>
                isTrue(row.responseConformation) &&
                isTrue(row.customerResponse) &&
                !isTrue(row.deleted) &&
                wanted.has(onHoldKey(row.serviceId, row.subCategoryId))
        )
        .map((row) => row.id);
    if (ids.length > 0) {
        await OnHoldConfirmation.update({ deleted: true }, { where: { id: ids } });
    }
    return ids.length;
}

module.exports = {
    isTrue,
    onHoldKey,
    isPendingRemoval,
    isAwaitingCustomer,
    applyCustomerRemovals,
    acknowledgeKeptRows,
};
