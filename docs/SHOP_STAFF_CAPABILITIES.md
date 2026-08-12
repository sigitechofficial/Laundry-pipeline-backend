# Shop staff capabilities

Role presets and per-employee overrides (`employeeCapabilityOverrides`) gate agent routes.
Effective caps = role preset ⊕ overrides, clamped by `ROLE_CAPABILITY_CEILINGS`.

## Role presets (locked defaults)

| Capability | Owner | Manager | Driver |
|---|---|---|---|
| `canManageShopOps` | yes | **no** | no |
| `canAcceptOrders` | yes | yes | no |
| `canAssignStaff` | yes | yes | no |
| `canManageTeam` | yes | yes | no |
| `canRunAssignedPickup` | yes | yes | yes |
| `canRunAssignedDelivery` | yes | yes | yes |
| `canRunAssignedJobs` | yes (derived) | yes | yes |
| `canManageFinance` | yes | no | no |
| `canViewShopOrders` | yes | yes | no |
| `canAccessInvoice` | yes | yes | no |
| `canAccessProcessing` | yes | yes | no |
| `canViewStaffActivity` | yes | yes | no |
| `canManageAutoAssign` | yes | no | no |

`canRunAssignedJobs` = `canRunAssignedPickup` OR `canRunAssignedDelivery` (kept for backward compat).

Ceilings: Driver cannot be granted finance / accept / assign / team. Manager cannot be granted finance or auto-assign config. Finance is never grantable to non-owner employees.

## Capability ↔ route matrix

| Capability | Routes (representative) |
|---|---|
| `canAcceptOrders` | `POST /acceptOrder`, `POST /rejectOrder` |
| `canAssignStaff` | `PATCH /assignBookingStaff`, `PATCH /reassignBookingStaff`, `PATCH /agentAssignBookingToLaundryDriver`, `PATCH /agentPickupOrderBySelf` |
| `canAssignStaff` **or** `canRunAssignedJobs` (self only) | `PATCH /unassignBookingStaff` — drivers may only return a leg assigned to them (status 3 or later; no trip-start gate) |
| `canAssignStaff` **or** `canRunAssignedJobs` | `GET /staffJobs` — drivers are forced to their own jobs |
| `requireBookingAssignee` (pickup) | `PATCH /agentBookingStatusOnTheWay/:bookingId`, `/driverStatusArrived/:bookingId`, `/reachedAtDeliveryShopStatus/:bookingId` |
| `requireBookingAssignee` (delivery) | `PATCH /laundryDeliverToCustomer/:bookingId`, `/driverReachedForDelivery/:bookingId`, `/bookingDeliverToCustomer/:bookingId` |
| `requireBookingAssignee` (either) | `POST /AddPickupDeliveryProof` |
| `canViewStaffActivity` | `GET /staffActivity` |
| `canManageAutoAssign` | `GET/PUT /autoAssignSettings` |
| `canManageTeam` | `PUT/PATCH/GET /employeeCapabilities/:employeeId` (+ existing team CRUD) |
| `canManageFinance` (owner) | wallet / settlement / bank routes via `requireShopOwner` |

Assignee gate notes:

- Owner/manager with `canViewShopOrders` or `canAssignStaff` may mutate trip progress without being the assigned driver.
- Drivers must match `driverId` (pickup) and/or `deliveryDriverId` (delivery) per route `types`.

## Auto-assign

After a successful accept (`agentAcceptOrderService`), `autoAssignService.tryAutoAssignAfterAccept` runs when settings are enabled. Failures are logged and do not roll back accept. Audit rows use `source=auto`.

Post-accept sheet (Owner/Manager): **Assign pickup**, **I'll do pickup**, or **Keep with shop owner**. Keep unassigns pickup and delivery back to the shop owner if auto-assign already wrote a driver.

## Driver self-unassign

A driver who cannot work today taps **Unassign me** on each assigned leg (or **Unassign me from this job** when both legs are theirs). Allowed before leaving (status 3) and after trip start. The leg returns to the shop owner (`driverId` / `deliveryDriverId` = owner). Audit `source=self_return`. This is not a customer attempt-fail. Mid-trip unassign reassigns any active live-tracking session to the shop owner. Unassign is **blocked** for delivered / completed / cancelled / refunded (16, 17, 19, 21).

Unassign / Return / Unassign me requires:
- `GET /agent/staffUnassignReasons` — pick a reason
- `PATCH /agent/unassignBookingStaff` body: `{ bookingId, assignmentType, reasonId, note? }` (`note` required when reason `isOther`)

## Assign pickup / delivery (independent)

`PATCH /assignBookingStaff` with `assignmentType: "pickup"` sets **pickup only**.  
`assignmentType: "delivery"` sets **delivery only**.  
Use `assignmentType: "both"` or `alsoAssignDelivery: true` only when you want the same staff on both legs.

Assign / unassign / auto-assign notify the affected staff via socket + FCM (`staffJobAssigned` / `staffJobUnassigned`).

## Admin visibility

- Order details show **Shop owner** when a leg is shop-held (assignee = shop address `userId`), not the owner's personal name as if they were a driver.
- Order details Activity includes `bookingAssignmentEvents` (assign / unassign / auto / self_return).
- Action Required reason **Needs staff driver** (`needs_staff`): trip already started (pickup 4–7 or delivery 13–14) but the leg is still shop-held / null — e.g. after driver self-unassign mid-route.

## Ops checklist

- Run migration `20260812150000-shop-staff-enterprise.js` before assign/unassign on a fresh DB (`bookingAssignmentEvents`, capability overrides, auto-assign settings).
- `GET /agent/orderDetailsById` is shop-scoped; drivers may only open bookings assigned to them.
