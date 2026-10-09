# Cashback as customer credit

Status: C1–C6 done on branch `promotions-checkout` in all 5 repos (not pushed). Ships with the promotions rollout.

## Decisions

- **When:** cashback is credited **after delivery** (booking reaches Completed, status 17), and only when the
  invoice is paid. Business decision, 2026-10-09.
- **What:** in-app credit only. It is never paid out as cash.
- **Spending (default):** credit is applied automatically on the customer's next invoice, after promotions,
  capped at what is still payable (same rule as promotions). Pay Now at checkout never changes.
- **Expiry (default):** 365 days from when it was earned (`CUSTOMER_CREDIT_EXPIRY_DAYS`, 0 = never).
- **Cost:** the platform pays, like promotions: the shop's commission stays on the gross amount.
- **Refunds:**
  - A full refund of the order that earned cashback takes back the part of that cashback still unspent.
    A part the customer already spent is not clawed back (the balance never goes negative).
  - A full refund of an order paid partly with credit gives that credit back.
  - Partial refunds do not change credit.
- **Kill switch:** spending follows `PROMOTIONS_CHECKOUT_ENABLED` / zone list. Flag off = no credit is applied
  to unpaid invoices. Balances are kept.

## Ledger

Table `customer_credit_entries`, one row per movement, never edited except `remainingAmount` / `status`:

| type | amount | notes |
|---|---|---|
| EARN | + | cashback from a promotion on a booking. A "lot": `remainingAmount`, `expiresAt` |
| ADJUST | + or − | admin, with reason. A positive adjust is a lot too |
| SPEND | − | credit used on a booking's invoice: HELD → COMMITTED, or HELD → RELEASED |
| REVERSE | − | cashback taken back after a full refund |
| RESTORE | + | credit given back after a full refund of an order paid with credit (new lot) |
| EXPIRE | − | unspent part of a lot after `expiresAt` |

- Spending takes from lots oldest-expiry first (FIFO). Table `customer_credit_allocations` records which lots a
  SPEND used, so releasing a hold puts the money back in the same lots.
- Balance = sum of `remainingAmount` of live lots. Every write locks the customer's lots (`FOR UPDATE`).
- `idempotencyKey` is unique: `cashback-booking-{id}-promo-{promotionId}`, `spend-booking-{id}`, etc.

## Flow

1. Admin creates a Cashback promotion (10% or £X, optional cap, min subtotal, zones, limits).
2. Customer sees "10% cashback" in offers. Booking holds the promotion (as today).
3. Invoice: the engine prices the cashback on the real lines. It is not a discount, so the invoice total does
   not change. The hold stores the expected cashback.
4. Paid: the hold is committed (usage + campaign budget count the cashback amount).
5. Completed (delivered) + paid: an EARN lot is created. Customer is notified.
6. Next order's invoice: credit is held against the payable balance and shown as "Credit used".
   Paid → committed. Cancelled → released back to the lots.
7. Job (every minute): issue cashback for completed bookings a hook missed, expire lots, release holds of
   cancelled bookings, commit holds of paid bookings.

## Phases

- [x] C1 Backend ledger: migration + models, `customerCreditService` (earn, hold/commit/release spend,
      reverse, restore, expire, adjust, balance, history), unit tests.
- [x] C2 Backend wiring: cashback amount on the hold at invoice, commit on payment, earn on Completed
      (delivery + admin complete + job), refund hooks, credit spend in `resolveInvoiceDiscount`, job.
- [x] C3 Backend API: customer `GET /customer/credit` (balance + history), `promotionSummary` gets
      `cashback` and `creditUsed`; admin customer credit view + manual adjust (audited), cashback in reports;
      allow Cashback in admin validation. Integration + e2e tests (positive and negative).
      Tests: `npm run test:credit-db` (14), `npm run test:cashback-e2e` (37, needs the flag on for the test zone).
      Endpoints: `GET /customer/credit`, `GET /admin/customerCredit/:customerId`,
      `POST /admin/customerCredit/:customerId/adjust { amount, reason, requestId? }` (platform admins only).
      `promotionSummary` gains `cashback { amount, status: pending|credited|taken_back, message }` and
      `creditUsed { amount, status: held|paid }`; each promotion gains `benefitType` and `cashback`.
- [x] C4 Admin panel: Cashback benefit enabled, customer Credit tab (balance, history, adjust), order card
      shows cashback + credit used, report shows cashback issued.
- [x] C5 Customer app + website: credit balance + history screen, booking detail "Cashback £X (after
      delivery)" / "Credit used −£X". Agent app: "Credit used" on the invoice card.
- [x] C6 Full test run (flag on and off), mobile screenshots, docs.
      2026-10-09: npm test, credit-db 14, promotions-api 165 (flag on and off), promotions-e2e 16,
      promotions-cases 33, cashback-e2e 38; kill switch checked (flag off → held credit released).
      Screens checked at 375px: customer booking detail (credited / taken back / credit returned),
      Credit screen, order summary credit note; agent invoice card; website order detail; admin
      Credit tab + adjust, order card, cashback report data.

Known limits:
- Partial refunds do not change credit (decision above).
- The agent cancel endpoint sets status 13, not 19 (old bug). Credit is released by the hook and a
  cancel record blocks re-holding, but the job only sees status 19/21.
- A held credit restored into a lot that expired meanwhile expires on the next job run.

Old apps cannot be force-updated: credit used is part of `billingDetail.discount`, so old apps show it as
discount and charge the right amount. Every API change is additive.
