# Invoice Auto-Charge + OFD Admin Gate

## Product flow (card only)

1. Invoice finalize (`AgentAddSerivces` / generate) → **no collect sheet**
2. Booking moves to **Processing** unpaid
3. **2 hours** later → Stripe off-session auto-charge
4. Soft retries (recoverable declines) up to 3 attempts
5. Fail → notify customer + agent; `paymentDeliveryGate = waiting_admin`
6. **Out for Delivery**: one automatic retry; still fail → block with Waiting for admin
7. Admin (`/orders/payment-failures`): **Shift to Cash** | **Allow Proceed** | **Keep Waiting**
8. Agent proceeds after admin clears

Cash / COD bookings are unchanged.

### Upfront / auth hold

Pickup upfront (or auth hold capture) still sets `paymentConfirmed` as before — **that flow is unchanged**.

Auto-charge scheduling uses **`amountDueNow`**, not `paymentConfirmed`. So a booking can have:
- upfront already captured (`paymentConfirmed = true`)
- invoice balance still due → auto-charge **still schedules** and charges the remaining balance.

## Admin + env

Live values: Admin → Policies → Runtime checks (`platformRuntimeSettings`).
Env vars below are fallbacks when the DB row is missing.

| Variable | Default | Meaning |
|----------|---------|---------|
| `INVOICE_AUTO_CHARGE_ENABLED` | `true` | Master switch |
| `INVOICE_AUTO_CHARGE_DELAY_MS` | `7200000` (2h) | Delay after finalize |
| `INVOICE_AUTO_CHARGE_JOB_INTERVAL_MS` | `60000` | Job poll interval |
| `INVOICE_AUTO_CHARGE_MAX_ATTEMPTS` | `3` | Scheduled attempts |
| `INVOICE_AUTO_CHARGE_RETRY_GAP_MS` | `1800000` (30m) | Soft-retry gap |

## APIs

- Agent: existing generate / OFD (gate inside `laundryDeliverToCustomer`)
- Admin: `GET /admin/payment-failures`
- Admin: `PATCH /admin/payment-failures/:bookingId/resolve` body `{ action, notes? }`
  - `shift_to_cash` | `allow_proceed` | `keep_waiting`

## Migration

`20260806163000-add-invoice-auto-charge-and-payment-attempts.js`
