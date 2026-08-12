const { Op } = require('sequelize');
const {
    shopAutoAssignSetting,
    users,
    booking,
    bookingAssignmentEvent,
} = require('../../models');
const {
    ValidationError,
    NotFoundError,
} = require('../../middlewares/universalErrorHandler');
const {
    SYSTEM_ROLES,
    CLASSIFIED_AS,
} = require('../../constants/systemRoles');
const assignmentAuditService = require('./assignmentAuditService');

const DRIVER_ROLE_ID = SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER;

/**
 * Shop auto-assign settings + post-accept round-robin assignment.
 */
class AutoAssignService {
    _defaultSettings(shopUserId) {
        return {
            shopUserId: Number(shopUserId),
            enabled: false,
            strategy: 'round_robin',
            scope: 'both',
            fallbackToOwner: true,
        };
    }

    async getSettings(shopUserId) {
        const row = await shopAutoAssignSetting.findOne({
            where: { shopUserId: Number(shopUserId) },
        });
        if (!row) {
            return this._defaultSettings(shopUserId);
        }
        return row.get({ plain: true });
    }

    async setSettings(shopUserId, payload = {}) {
        const existing = await this.getSettings(shopUserId);
        const enabled =
            payload.enabled != null ? Boolean(payload.enabled) : existing.enabled;
        const strategy =
            payload.strategy != null
                ? String(payload.strategy)
                : existing.strategy || 'round_robin';
        let scope =
            payload.scope != null
                ? String(payload.scope).toLowerCase()
                : existing.scope || 'both';
        if (!['pickup', 'delivery', 'both'].includes(scope)) {
            throw new ValidationError('scope must be pickup, delivery, or both');
        }
        const fallbackToOwner =
            payload.fallbackToOwner != null
                ? Boolean(payload.fallbackToOwner)
                : existing.fallbackToOwner !== false;

        await shopAutoAssignSetting.upsert({
            shopUserId: Number(shopUserId),
            enabled,
            strategy,
            scope,
            fallbackToOwner,
        });

        // upsert return shape varies; reload for consistency
        return this.getSettings(shopUserId);
    }

    async _listActiveDrivers(shopAgentId) {
        return users.findAll({
            where: {
                employeeOff: Number(shopAgentId),
                classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
                roleId: DRIVER_ROLE_ID,
                status: true,
            },
            attributes: ['id', 'firstName', 'lastName'],
            order: [['id', 'ASC']],
        });
    }

    /**
     * Pick next driver by round-robin on last auto assignment event (toUserId).
     */
    async _pickRoundRobinDriver(shopAgentId, drivers) {
        if (!drivers.length) return null;
        const driverIds = drivers.map((d) => Number(d.id));

        const lastAuto = await bookingAssignmentEvent.findOne({
            where: {
                source: 'auto',
                toUserId: { [Op.in]: driverIds },
            },
            order: [['createdAt', 'DESC'], ['id', 'DESC']],
            attributes: ['toUserId'],
        });

        if (!lastAuto || lastAuto.toUserId == null) {
            return drivers[0];
        }

        const lastId = Number(lastAuto.toUserId);
        const idx = driverIds.indexOf(lastId);
        const nextIdx = idx >= 0 ? (idx + 1) % drivers.length : 0;
        return drivers[nextIdx];
    }

    /**
     * After accept succeeds — assign pickup/delivery per shop settings.
     * Does not throw to caller of accept; logs and returns null on failure.
     */
    async tryAutoAssignAfterAccept({ shopAgentId, bookingId, actedByUserId }) {
        try {
            const settings = await this.getSettings(shopAgentId);
            if (!settings.enabled) {
                return { skipped: true, reason: 'disabled' };
            }

            const bookingRow = await booking.findByPk(bookingId, {
                attributes: ['id', 'driverId', 'deliveryDriverId', 'orderTrackId'],
            });
            if (!bookingRow) {
                throw new NotFoundError('Booking not found');
            }

            const drivers = await this._listActiveDrivers(shopAgentId);
            let selected = await this._pickRoundRobinDriver(shopAgentId, drivers);

            if (!selected && settings.fallbackToOwner) {
                selected = { id: Number(shopAgentId), isOwnerFallback: true };
            }
            if (!selected) {
                return { skipped: true, reason: 'no_drivers' };
            }

            const scope = String(settings.scope || 'both').toLowerCase();
            const assignPickup = scope === 'pickup' || scope === 'both';
            const assignDelivery = scope === 'delivery' || scope === 'both';
            const toUserId = Number(selected.id);
            const actorId = Number(actedByUserId || shopAgentId);
            const updates = {};
            const events = [];

            if (assignPickup) {
                const fromUserId =
                    bookingRow.driverId != null
                        ? Number(bookingRow.driverId)
                        : null;
                updates.driverId = toUserId;
                events.push({
                    assignmentType: 'pickup',
                    fromUserId,
                    toUserId,
                });
            }
            if (assignDelivery) {
                const fromUserId =
                    bookingRow.deliveryDriverId != null
                        ? Number(bookingRow.deliveryDriverId)
                        : null;
                updates.deliveryDriverId = toUserId;
                events.push({
                    assignmentType: 'delivery',
                    fromUserId,
                    toUserId,
                });
            }

            if (Object.keys(updates).length) {
                await booking.update(updates, { where: { id: bookingId } });
            }

            for (const ev of events) {
                await assignmentAuditService.recordEvent({
                    bookingId,
                    assignmentType: ev.assignmentType,
                    action: 'auto',
                    fromUserId: ev.fromUserId,
                    toUserId: ev.toUserId,
                    actedByUserId: actorId,
                    source: 'auto',
                });
                try {
                    const {
                        notifyStaffAssignmentChange,
                    } = require('../../utils/staffAssignmentNotify');
                    await notifyStaffAssignmentChange({
                        bookingId,
                        orderTrackId: bookingRow.orderTrackId,
                        assignmentType: ev.assignmentType,
                        action: 'auto',
                        toUserId: ev.toUserId,
                        fromUserId: ev.fromUserId,
                        shopOwnerUserId: shopAgentId,
                    });
                } catch (_) {
                    /* non-fatal */
                }
            }

            return {
                skipped: false,
                assignedTo: toUserId,
                scope,
                events: events.length,
            };
        } catch (err) {
            console.error(
                '[autoAssign] tryAutoAssignAfterAccept failed:',
                err.message
            );
            return { skipped: true, reason: 'error', error: err.message };
        }
    }
}

module.exports = new AutoAssignService();
