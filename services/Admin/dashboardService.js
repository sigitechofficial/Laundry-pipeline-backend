const { users, booking, billingDetails, bookingHistory } = require('../../models');
const { Op } = require('sequelize');

class DashboardService {
    /**
     * Get admin dashboard statistics
     * @returns {Object} Dashboard data including revenue, counts, and metrics
     */
    async getDashboardData() {
        try {
            // Get total revenue from zone admin commission
            const revenue = await billingDetails.sum("zoneAdminCommission", {
                where: {
                    zoneAdminCommission: {
                        [Op.ne]: null,
                    },
                },
            });

            // Get total counts
            const totalBookings = await booking.count();
            const totalUsers = await users.count();

            const totalCustomer = await users.count({
                where: {
                    userTypeId: 2,
                    status: true,
                },
            });

            const totalAgent = await users.count({
                where: {
                    userTypeId: 4,
                },
            });

            const totalAgentActive = await users.count({
                where: {
                    userTypeId: 4,
                    status: true,
                },
            });

            // Get completed bookings for average completion time calculation
            const completedBookings = await booking.findAll({
                where: {
                    bookingStatusId: 17,
                },
                include: [
                    {
                        model: bookingHistory,
                        where: {
                            bookingStatusId: 17,
                        },
                        required: true,
                    },
                ],
            });

            // Calculate average completion time
            let totalCompletionTime = 0;
            let completedCount = 0;

            for (const bookingItem of completedBookings) {
                const creationHistory = await bookingHistory.findOne({
                    where: {
                        bookingId: bookingItem.id,
                        bookingStatusId: 1,
                    },
                });

                const completionHistory = await bookingHistory.findOne({
                    where: {
                        bookingId: bookingItem.id,
                        bookingStatusId: 17,
                    },
                });

                if (creationHistory && completionHistory) {
                    const creationDateTime = new Date(`${creationHistory.date} ${creationHistory.time}`);
                    const completionDateTime = new Date(`${completionHistory.date} ${completionHistory.time}`);

                    const timeDiff = completionDateTime - creationDateTime;
                    totalCompletionTime += timeDiff;
                    completedCount++;
                }
            }

            const averageCompletionTimeHours =
                completedCount > 0 ? totalCompletionTime / completedCount / (1000 * 60 * 60) : 0;

            // Get agent acceptance metrics
            const acceptedByAgents = await booking.count({
                where: {
                    driverId: {
                        [Op.ne]: null,
                    },
                },
            });

            const assignedToAgents = await booking.count({
                where: {
                    deliveryDriverId: {
                        [Op.ne]: null,
                    },
                },
            });

            const agentAcceptanceRate =
                assignedToAgents > 0
                    ? Math.round((acceptedByAgents / assignedToAgents) * 100) / 100
                    : 0;

            return {
                adminRevenue: revenue,
                totalBookings: totalBookings,
                totalUsers: totalUsers,
                totalCustomers: totalCustomer,
                totalAgents: totalAgent,
                totalAgentActive: totalAgentActive,
                averageOrderCompletionTimeHours: Math.round(averageCompletionTimeHours * 100) / 100,
                completedOrdersCount: completedCount,
                agentAcceptanceRate: agentAcceptanceRate,
            };
        } catch (error) {
            throw new Error(`Dashboard service error: ${error.message}`);
        }
    }
}

module.exports = new DashboardService();
