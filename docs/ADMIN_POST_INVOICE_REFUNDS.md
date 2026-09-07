# Admin post-invoice refunds

## Product rule

Admin can issue **full or partial** refunds after invoice generation / payment — without cancelling via the customer cancel path (blocked at status ≥ 10).

| Channel | Customer money | Settlement |
|---|---|---|
| Card | Stripe `refunds.create` → original card/bank | Commission clawback + optional extra-tip clawback |
| Cash | Manual cash return + ledger mark | `cash_refunded` credit + commission clawback |

**Share rule:** `refundShare = thisRefund / remainingRefundable`. Agent commission (laundry share + booking tip) and platform laundry share reduce by that share. Extra tip is clawed only when that Stripe/cash tip bucket is actually refunded. Service fee is not in the agent base; on a Stripe refund that covers the original charge the customer still receives it.

Card orders have **two** Stripe charges: pickup prepaid (zone minimum + service fee + booking tip) and invoice balance. Invoice success used to overwrite `bookings.paymentIntentId`, so refunds only saw the balance. Refund discovery now includes `pickupPaymentIntentId`, invoice attempts, and Stripe PaymentIntents for that customer with `metadata.bookingId`. `pickupPaymentIntentId` is preserved before overwrite and self-healed on preview.

## APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/bookings/:bookingId/refund-preview?amount=` | Live breakdown before confirm |
| POST | `/admin/bookings/:bookingId/refund` | Issue refund |
| GET | `/admin/bookings/:bookingId/refunds` | History |

### POST body

```json
{
  "mode": "full" | "partial",
  "amount": 12.5,
  "reason": "Damaged garment",
  "note": "optional",
  "idempotencyKey": "admin-ui-123-…"
}
```

## Ledger `referenceType`s

| Type | Direction | Effect |
|---|---|---|
| `customer_refund` | customer credit | Audit of Stripe return |
| `commission_clawback` | agent debit | Reduces net commission / payable |
| `cash_refunded` | agent credit | Reduces cash due |
| `extra_tip_clawback` | agent debit | Reduces payable for post-complete tips |

## Schema

- `booking_refunds` — `20260907120000-create-booking-refunds.js` (`tableExists`)
- `bookings.pickupPaymentIntentId` — `20260907140000-add-pickup-payment-intent-to-bookings.js` (`addColumnIfMissing`)

Deploy path already runs `ensure-live-migrations.js`.

## Admin UI

Order details → **Issue refund** → modal with economics, charge buckets, customer/agent/platform impact, settlement deltas.

After confirm, customer and shop agent get a push with the refund amount. Customer order details include a public `refunds` summary (`totalRefunded`, `history`). Agent is notified because commission is clawed and cash refunds must be handed back.
