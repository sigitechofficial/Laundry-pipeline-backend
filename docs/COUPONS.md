# Coupons (enterprise contract)

## What a coupon discounts

- **Laundry / services merchandise only** (customer-selected priced lines at booking estimate, then agent invoice `servicesSubtotal`).
- **Never** zone prepaid: minimum order hold + service fee + driver tip.

## Min order amount

- Admin field = minimum **laundry** total, not prepaid.
- At checkout, bags-only bookings often have £0 laundry estimate → min check is **deferred** until invoice.
- Invoice finalize is authoritative: if laundry &lt; min, discount becomes £0.

## Pay Now / Stripe

- Auth hold = full prepaid (`getPickupChargeAmount`).
- Promo does **not** reduce the hold or Pay Now amount.
- Discount reduces **invoice balance due** via `billingDetails.discount` in `invoicePaymentSummary`.

## APIs

- `POST /customer/applyCoupon` body: `{ code, laundryCartAmount? }`
  - Legacy `orderAmount` is ignored for money math (old clients sent prepaid).
  - `laundryCartAmount` omitted/0 → reserve coupon, `minOrderDeferred: true`, `discountAmt: 0`.
- `createBooking` with `couponCode`: prices lines, validates vs laundry estimate, stores provisional discount, records redemption.
- Invoice totals call `couponService.resolveBookingDiscount(bookingId, servicesSubtotal)`.
