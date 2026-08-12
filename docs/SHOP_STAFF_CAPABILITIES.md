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
| `canAssignStaff` | `PATCH /assignBookingStaff`, `/unassignBookingStaff`, `/reassignBookingStaff`, `/agentAssignBookingToLaundryDriver` |
| `canAssignStaff` **or** `canRunAssignedJobs` | `GET /staffJobs` |
| `canRunAssignedJobs` | `PATCH /agentPickupOrderBySelf` |
| `requireBookingAssignee` (pickup) | `PATCH /agentBookingStatusOnTheWay/:bookingId`, `/driverStatusArrived/:bookingId`, `/reachedAtDeliveryShopStatus/:bookingId` |
| `requireBookingAssignee` (delivery) | `PATCH /laundryDeliverToCustomer/:bookingId`, `/driverReachedForDelivery/:bookingId`, `/bookingDeliverToCustomer/:bookingId` |
| `requireBookingAssignee` (either) | `POST /AddPickupDeliveryProof` |
| `canViewStaffActivity` | `GET /staffActivity` |
| `canManageAutoAssign` | `GET/PUT /autoAssignSettings` |
| `canManageTeam` | `PUT/GET /employeeCapabilities/:employeeId` (+ existing team CRUD) |
| `canManageFinance` (owner) | wallet / settlement / bank routes via `requireShopOwner` |

Assignee gate notes:

- Owner/manager with `canViewShopOrders` or `canAssignStaff` may mutate trip progress without being the assigned driver.
- Drivers must match `driverId` (pickup) and/or `deliveryDriverId` (delivery) per route `types`.

## Auto-assign

After a successful accept (`agentAcceptOrderService`), `autoAssignService.tryAutoAssignAfterAccept` runs when settings are enabled. Failures are logged and do not roll back accept. Audit rows use `source=auto`.
