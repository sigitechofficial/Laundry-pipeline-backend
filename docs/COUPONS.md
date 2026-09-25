# Coupons (enterprise contract)

## What a coupon discounts

- **Laundry / services merchandise only** (agent invoice `servicesSubtotal`).
- **Never** zone prepaid: minimum order hold + service fee + driver tip.
- Checkout **reserves** the code only (`discountAmt = 0`). Money discount is applied when the **invoice** is built.

## Zones

- `coupons.zoneIds` JSON: `null` / `[]` = **all zones**; otherwise list of zone ids.
- `applyCoupon` / `createBooking` must pass `zoneId` for zone-specific codes.

## Min order amount

- Minimum **laundry** total on the invoice (not prepaid).
- Checked at invoice finalize. If laundry &lt; min, discount = £0 (promo still reserved / used).

## Pay Now / Stripe

- Auth hold = full prepaid.
- Promo never zeros Pay Now.
- Customer apps show a short message: discount applies after inspection / on invoice.

## APIs

- `POST /customer/applyCoupon` `{ code, zoneId?, laundryCartAmount? }`
  - Returns `appliesAt: "invoice"`, `discountAmt: 0`, `customerMessage`.
- `createBooking` + `couponCode`: records redemption with `discountAmt: 0`.
- Invoice totals: `resolveBookingDiscount(bookingId, laundrySubtotal, …, zoneId)`.
