'use strict';

/**
 * On-hold items, put in words for the customer (push, email) and the admin
 * (list reason, report, order detail).
 *
 * The shop app saves the issue as "Risk: <risk>. Note: <shop note>" in
 * OnHoldConfirmation.description. Older rows may hold free text, and before
 * customerNote existed the customer's note was appended as "\nCustomer: …".
 */

const RISK_RE = /^\s*Risk:\s*(.*?)\.\s*Note:\s*([\s\S]*)$/i;
const LEGACY_CUSTOMER_RE = /\n?Customer:\s*([\s\S]*)$/;

/** { risk, shopNote, legacyCustomerNote } from a saved description. */
function parseOnHoldDescription(description) {
    let text = typeof description === 'string' ? description : '';
    let legacyCustomerNote = null;
    const legacy = text.match(LEGACY_CUSTOMER_RE);
    if (legacy) {
        legacyCustomerNote = legacy[1].trim() || null;
        text = text.slice(0, legacy.index);
    }
    const m = text.match(RISK_RE);
    if (m) {
        return { risk: m[1].trim() || null, shopNote: m[2].trim() || null, legacyCustomerNote };
    }
    const plain = text.trim();
    return { risk: null, shopNote: plain || null, legacyCustomerNote };
}

const plainRow = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row || {});

/** "Dry Clean · Silk Dress (×2)" */
function itemLabel(row) {
    const r = plainRow(row);
    const serviceName = r.service?.name || null;
    const itemName = r.subCategory?.name || null;
    const pieces = Number(r.noOfItems) || 0;
    const name = [serviceName, itemName].filter(Boolean).join(' · ') || 'Item';
    return pieces > 1 ? `${name} (×${pieces})` : name;
}

/** What is wrong, in a few words: the risk, else the shop's note. */
function issueText(row) {
    const { risk, shopNote } = parseOnHoldDescription(plainRow(row).description);
    if (risk && risk.toLowerCase() !== 'other (see note)') return risk;
    return shopNote || risk || null;
}

/** "Dry Clean · Silk Dress: Colour may run (+1 more)" for lists and reports. */
function summarizeOnHold(rows) {
    const list = (rows || []).map(plainRow).filter((r) => !r.deleted);
    if (!list.length) return null;
    const first = list[0];
    const issue = issueText(first);
    const head = issue ? `${itemLabel(first)}: ${issue}` : itemLabel(first);
    return list.length > 1 ? `${head} (+${list.length - 1} more)` : head;
}

/** Customer's answer in words. */
function answerText(row) {
    const r = plainRow(row);
    if (!r.responseConformation) return 'Waiting for the customer';
    return r.customerResponse ? 'Clean it (customer accepts the risk)' : 'Return it uncleaned and remove from bill';
}

/** One item as the admin order page shows it. */
function toAdminOnHoldItem(row) {
    const r = plainRow(row);
    const { risk, shopNote, legacyCustomerNote } = parseOnHoldDescription(r.description);
    const answered = Boolean(r.responseConformation);
    return {
        id: r.id,
        serviceName: r.service?.name || null,
        itemName: r.subCategory?.name || null,
        pieces: Number(r.noOfItems) || 0,
        photo: r.onHoldImg || null,
        risk,
        shopNote,
        customerAnswered: answered,
        customerKeeps: answered ? Boolean(r.customerResponse) : null,
        customerAnswer: answerText(r),
        customerNote: (r.customerNote && String(r.customerNote).trim()) || legacyCustomerNote,
        heldAt: r.createdAt || null,
        respondedAt: r.respondedAt || (answered ? r.updatedAt || null : null),
        resolvedAt: r.resolvedAt || null,
        handledByShop: Boolean(r.deleted),
    };
}

/** Push text for the customer, naming the item and the issue. */
function onHoldPushBody(rows, orderTrackId) {
    const list = (rows || []).map(plainRow);
    const order = orderTrackId ? ` in order #${orderTrackId}` : '';
    if (!list.length) return `Some items${order} are on hold. Please review them in the app.`;
    const first = list[0];
    const issue = issueText(first);
    const more = list.length > 1 ? ` and ${list.length - 1} more item(s)` : '';
    return `${itemLabel(first)}${issue ? `: ${issue}` : ''}${more}${order}. Open the app to choose what we do.`;
}

module.exports = {
    parseOnHoldDescription,
    itemLabel,
    issueText,
    summarizeOnHold,
    answerText,
    toAdminOnHoldItem,
    onHoldPushBody,
};
