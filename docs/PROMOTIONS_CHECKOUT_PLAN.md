# Promotions → checkout & invoice: implementation plan

Status: in progress (started 2026-10-08). Done: Phase 0, 1, 2, 3, 4. Each phase ships on its own, behind a flag, with tests.

## Decisions (business, 2026-10-08)

| Topic | Decision |
|---|---|
| Free Delivery / Delivery Discount | Keep. They apply to a **delivery fee only**. There is no delivery fee today (home config says "Free 24h"), so they save £0 until one exists. They must never touch the zone **service fee** (`zone.serviceCharge`). |
| Service-fee promotions | Not now. |
| Discount larger than what is still owed | Cap at the balance still payable after the prepaid amount. No refunds. The capped amount is what is recorded and charged to the budget. |
| Legacy systems | Coupons (Legacy) and Service Discounts (Legacy) will be removed and replaced by Promotions. |
| Stacking | Platform discounts on services (automatic promotions) **and** one customer code apply together, following the engine's stacking rules. |
| Who pays for the discount | The platform. Shop/agent commission stays on gross laundry (unchanged). |

## Facts the design relies on

- Customers book services and bags/items without prices; the laundry total is only known when the shop builds the invoice. So money is calculated **at invoice**, eligibility is checked **at booking**.
- Single choke point today: `invoiceManagementService.calculateInvoiceTotals` (~:602) and `getInvoiceDraft` (~:949) call `couponService.resolveBookingDiscount` and store `billingDetails.discount`.
- `utils/invoicePaymentSummary.js:79`: `amountDueNow = max(0, total − paid − discount)`. The agent app charges/collects `amountDueNow`.
- All clients (customer app, website, agent app) already display `billingDetail.discount` / `paymentSummary.orderSummary.discount`. No client has a force update, so **every change must be additive** and keep field names and types (agent app parses `billingDetail.*` as strings).
- Prepaid (minimum + service fee + tip) is held at booking and captured at "On the Way". The balance is charged off-session (`invoiceAutoChargeService`) or collected as cash.
- Booking, invoice and payment code use no DB transactions; the promotions ledger has its own.
- Reservations currently expire after 15 minutes (`RESERVATION_TTL_MINUTES`), which is too short for booking → invoice (days).

## Phases

### Phase 0: Safety rails
- [x] 0.1 Flag `PROMOTIONS_CHECKOUT_ENABLED` + optional `PROMOTIONS_CHECKOUT_ZONE_IDS` allowlist. Off = today's behaviour exactly.
- [x] 0.2 Delivery fee source: engine context uses a delivery fee of £0 (none exists), not `zone.serviceCharge`.
- [x] 0.3 Admin: warn that delivery fee is £0 on delivery promotions; hide Cashback until a wallet payout exists.

### Phase 1: Booking-held reservations (ledger)
- [x] 1.1 Reservations attached to a booking do not expire after 15 minutes; they end by commit, release (cancel) or reverse (refund).
- [x] 1.2 Idempotency key `booking-{id}-promo-{promotionId}` so retries never double-reserve.
- [x] 1.3 Booking helpers (`listBookingRedemptions`, `releaseBookingRedemptions`, `reverseBookingRedemptions`); cleanup releases holds of cancelled/refunded bookings and extends expired holds of open ones.

### Phase 2: Booking stage
- [x] 2.1 One code box: `POST /customer/applyCoupon` and `createBooking.couponCode` accept promotion codes too, with the same response shape (`data.code` always set).
- [x] 2.2 `createBooking`: after the booking row, reserve the coded promotion and customer-level-eligible automatic promotions; store a booking-time snapshot (collection day, booking time, payment method). A promotions error never blocks a booking; an invalid code is reported like today.
- [x] 2.3 Release on Stripe hold failure / status 19 at booking.
- [x] 2.4 Recurring: automatic promotions only, re-checked per generated booking. Reschedule keeps reservations.
- [x] 2.5 Customer facts "as of the booking" (the booking itself never counts as a previous order), and a booking's own holds never count against its per-customer / per-code limits.
- Note: holds count toward a promotion's global limit until invoice. Holds that end up not applying are released when the booking is paid (4.1).

### Phase 3: Invoice stage (money)
- [x] 3.1 New `resolveBookingDiscount` = legacy coupon (existing redemptions) + promotions priced on the real invoice lines. Writes `order_adjustments` (idempotent) and the combined `billingDetails.discount` (string).
- [x] 3.2 Cap to the payable balance (decision above).
- [x] 3.3 Freeze once paid: no re-pricing after the balance is charged/collected.
- [x] 3.4 `agentUpdateInvoice` (on-hold removal) still writes discount 0 with the app's total (legacy handler, left as is), but every later pricing and every charge recomputes through `calculateInvoiceTotals`, which re-applies the promotions. Verified by the invoice tests.
- Rules at invoice: held promotions are honoured even if they expired after the booking; dropped if an admin paused/archived them or their campaign. Usage limits are not re-counted (the hold secured them); campaign budget is re-checked. Customer facts and the clock are taken as of the booking. Repricing policy: every policy recalculates on the final lines (nothing is priced at booking to lock).

### Phase 4: Payment and lifecycle
- [x] 4.1 Commit redemptions with final amounts on payment success (card charge, cash recorded, nothing due); campaign budget moves then.
- [x] 4.2 Release on every cancel path (customer 19, agent 13, no-show 19, on-hold 19, admin status change); reverse on full refund (21).
- [x] 4.3 Fix cash fallback `resolveCashCollectedAmount` using gross instead of net-of-discount.
- How it is wired: direct calls where the money moves (card charge success `markChargeSuccess`, `recordCashPayment` both branches, "nothing due" in `bookingInvoiceGeneratedStatusUpdated`, customer cancel, agent cancel, admin full refund) plus the promotions job every 60s as a safety net: it settles holds of Paid/Completed bookings, reverses committed promotions of Refunded (21) bookings, and releases holds of Cancelled/Refunded bookings. Other Paid paths (agent wallet, paymentService), no-show and on-hold cancels and admin status edits are covered by the job. Partial refunds keep the promotion.

### Phase 5: Admin and reports
- [ ] 5.1 Order detail shows promotion lines.
- [ ] 5.2 Promotion report: uses, unique customers, total discount, by zone, by day.
- [ ] 5.3 Campaign report: budget, spent, remaining, per promotion.

### Phase 6: Remove legacy
- [ ] 6.1 Migrate legacy coupons to promotions (codes, limits, dates, zones, used counts).
- [ ] 6.2 Migrate legacy service-discount rules to automatic item/category/service promotions; catalog prices keep `hasDiscount` / `originalPrice` / `saving` from promotions so apps look the same.
- [ ] 6.3 Legacy pages read-only, then hidden; bookings already holding a legacy coupon are still honoured.

### Phase 7: Client apps (additive, need releases)
- [ ] 7.1 Website checkout shows the promotion properly (today it forces the estimate to 0); check `utilities/URL.js` points at production before deploy.
- [ ] 7.2 Customer app: promotion names on the invoice (new optional field).
- [ ] 7.3 Agent app: use `orderSummary.discount`; refresh the discount after adding services.

### Phase 8: Rollout
- [ ] Stage first, then production with the flag on for one zone, then all zones. Rollback = flag off.

## Test gates (every phase)
- `npm test` and `npm run test:promotions-api` green, plus new end-to-end scenarios: booking → invoice → pay → cancel/refund, with the flag on and off (flag off must match today's numbers exactly).
