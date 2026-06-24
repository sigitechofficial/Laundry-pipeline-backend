# Agent App — Admin Assign & Reassign

> **Audience:** Flutter agent app developers  
> **Backend:** Laundry Pipeline API  
> **Last updated:** May 2026

This document describes how the agent app should behave when an admin **assigns** or **reassigns** an order from the admin panel. It is separate from the normal zone-broadcast **accept** flow.

---

## Quick summary

| Scenario | Agent must Accept? | Where order appears |
|----------|-------------------|---------------------|
| Normal zone order (broadcast) | **Yes** | `getBookingHome` → Accept → active list |
| Admin assign / reassign | **No** | Directly in active / assigned lists |

When admin assigns or reassigns:

- Backend sets `bookingStatusId = 3` (Accepted)
- `laundryShopId` and `driverId` are set immediately
- **Do not** call `POST /agent/acceptOrder` for admin-assigned orders
- **Do not** expect the order on `getBookingHome` after admin assign

---

## API reference

**Base URL (production):** `https://prodlaundry.sigisolutions.net:8989`

### Endpoints involved

| Method | Path | Role in admin assign |
|--------|------|----------------------|
| `GET` | `/agent/getBookingHome` | Pending pool only (`status = 1`, `laundryShopId = null`). Admin-assigned orders **do not** appear here. |
| `GET` | `/agent/agentBookingFilters` | Active orders for the shop (`laundryShopId = shop`, status not in `1, 13, 17`). Admin-assigned orders **appear here**. |
| `POST` | `/agent/acceptOrder` | **Only** for normal zone pending orders. **Not** for admin assign. |
| `POST` | `/agent/rejectOrder` | Decline a pending broadcast order (unchanged). |

### Booking state after admin assign

```text
laundryShopId     → selected shop address id
bookingStatusId   → 3 (Accepted)
driverId          → shop owner user id
adminAssignedShopId → null
```

---

## Socket events

The app should listen for these events on the existing agent socket connection.

### 1. `AcceptedOrder` — new assigned agent

Sent when admin assigns or reassigns an order **to your shop**.

```json
{
  "type": "AcceptedOrder",
  "data": {
    "data": 12345,
    "message": "Order assigned to your shop by admin"
  }
}
```

| Field | Description |
|-------|-------------|
| `data.data` | `bookingId` (number) |
| `data.message` | Human-readable message |

**App actions:**

1. Remove `bookingId` from pending / home / accept queue (if present).
2. Refresh assigned / active order lists (`agentBookingFilters` or equivalent).
3. Optionally show a snackbar or navigate to order detail.

> This event is also used when an agent **normally accepts** a zone order. The message differs (`"Order accepted successfully"` vs admin message). Handle both with the same listener.

---

### 2. `orderReassignedFromYou` — previous agent (reassign only)

Sent when admin moves an order **away from your shop** to another shop.

```json
{
  "type": "orderReassignedFromYou",
  "data": {
    "bookingId": 12345,
    "message": "Order #ORD-12345 was reassigned to another shop by admin."
  }
}
```

A **push notification** is also sent with `type: orderReassignedFromYou`.

**App actions:**

1. Remove the order from **all** local lists (active, pickup, in-progress, history cache if applicable).
2. If the user is viewing that order, navigate back and show an explanatory message.
3. Do not allow further actions on that `bookingId` from this agent session.

---

### 3. `orderTakenByOtherAgent` — other zone shops (optional)

Sent to other shop owners in the same zone (not the newly assigned shop, not the previous owner on reassign).

```json
{
  "type": "orderTakenByOtherAgent",
  "data": {
    "bookingId": 12345,
    "message": "This order was assigned by admin to another shop"
  }
}
```

**App actions:** Remove the order from pending / home lists if it was visible there.

---

### Events **not** used for admin assign

| Event | Status |
|-------|--------|
| `adminOrderPendingAccept` | **Not sent** for admin assign. Remove or ignore if previously implemented. |

---

## Normal accept flow (unchanged)

For orders broadcast to the zone (not admin-assigned):

1. `GET /agent/getBookingHome` — pending orders (`status = 1`, `laundryShopId = null`)
2. Agent taps Accept → `POST /agent/acceptOrder` with body:

```json
{
  "bookingId": 12345,
  "timeZone": "Asia/Karachi",
  "clientTimeZone": "Asia/Karachi"
}
```

3. On success, socket `AcceptedOrder` is emitted to the accepting agent.
4. Other zone agents receive `orderTakenByOtherAgent`.

Admin assign **bypasses** steps 1–2 entirely.

---

## Reassign — business rules

When admin **reassigns** an already-assigned order:

| Aspect | Backend behavior | Agent app implication |
|--------|------------------|------------------------|
| Eligibility | Only while `bookingStatusId < 4` (before Driver Out for PickUp) | After status 4, reassign will not happen — no `orderReassignedFromYou` |
| Pickup proofs | Cleared on reassign (if any existed) | Unlikely before status 4 |
| Card payment at pickup | `paymentConfirmed` and Stripe fields **retained** if already charged | UI should still show prior payment state |
| Cash payment | Unchanged | Full bill at delivery per cash rules |
| Invoice | Assign also blocked if `invoiceStatus = finalized` | N/A |

---

## Admin assign eligibility (for context)

Admin can assign or reassign only when **all** of the following are true:

| Rule | Allowed |
|------|---------|
| `bookingStatusId < 4` (before **Driver Out for PickUp**) | ✅ Status 1, 2, or 3 |
| `bookingStatusId >= 4` | ❌ Blocked |
| Invoice **not** finalized | ✅ `draft` allowed |
| Order **not** completed / cancelled | ❌ Status 17, 19, 21 blocked |

### Status reference

| ID | Title | Assign / Reassign |
|----|--------|-------------------|
| 1 | Order Created | ✅ Assign |
| 2 | Confirmed | ✅ |
| 3 | Awaiting Collection | ✅ Reassign |
| **4** | **Driver Out for PickUp** | ❌ **Blocked from here** |
| 5+ | Reached pickup, in transit, delivery… | ❌ |

The agent app does not call admin APIs; this explains when admin actions can occur.

---

## Recommended implementation checklist

### Socket listeners

- [ ] `AcceptedOrder` — refresh assigned list; handle admin message text
- [ ] `orderReassignedFromYou` — **new listener**; remove order everywhere
- [ ] `orderTakenByOtherAgent` — remove from pending list (if not already)

### Remove / avoid

- [ ] Do not show an Accept step for admin-assigned orders
- [ ] Do not call `POST /agent/acceptOrder` after admin assign
- [ ] Remove `adminOrderPendingAccept` handling if added for a previous backend version

### List refresh strategy

After `AcceptedOrder` or `orderReassignedFromYou`:

```text
Refresh: agentBookingFilters / active order APIs
Do not rely on: getBookingHome for admin-assigned orders
```

---

## Testing checklist

| # | Test | Expected result |
|---|------|-----------------|
| 1 | Admin assigns unassigned order to shop A | Shop A sees order in active list; **no** Accept step |
| 2 | Shop A receives `AcceptedOrder` socket | Lists update without manual refresh (if listener implemented) |
| 3 | Admin reassigns from shop A → shop B | Shop A gets `orderReassignedFromYou`; order removed from A |
| 4 | Shop B gets `AcceptedOrder` | Order in B's active list |
| 5 | Normal zone order (no admin) | Still on `getBookingHome`; Accept still required |
| 6 | Reassign at status 3 (before driver out) | Allowed; shop B gets `AcceptedOrder` |
| 7 | Reassign at status 4+ (driver out for pickup) | **Blocked** by admin API |

---

## Debugging

If something looks wrong, report to backend with:

- `bookingId`
- `orderTrackId`
- Agent `userId` (shop owner)
- Timestamp of admin action
- Which socket events were (or were not) received

---

## Related backend files

| File | Purpose |
|------|---------|
| `services/Admin/adminBookingAssignService.js` | Admin assign / reassign logic |
| `utils/bookingTakenNotify.js` | `AcceptedOrder` + `orderTakenByOtherAgent` |
| `utils/bookingAdminAssignNotify.js` | `orderReassignedFromYou` + customer push |
| `utils/bookingAgentWindow.js` | `canAdminAssignOrReassignBooking` — status `< 4` gate |
| `services/Agent/agentAcceptOrderService.js` | Normal zone accept only |

---

## Changelog

| Date | Change |
|------|--------|
| May 2026 | Assign/reassign blocked at status 4 (Driver Out for PickUp) and later. |
| May 2026 | Admin assign reverted to direct accept (`status 3`). No pending accept step. `orderReassignedFromYou` added for previous agent on reassign. |
