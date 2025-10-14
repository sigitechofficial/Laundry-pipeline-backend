require("dotenv").config();
const { 
    countries, 
    cities, 
    machines, 
    agentSelectServices, 
    service, 
    users, 
    bussinessWorkingHours,
    booking,
    customerSelectedService,
    onHoldOption
} = require('../../models');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Agent Utility Service
 * Handles all agent utility related business logic
 */
class AgentUtilityService {

    /**
     * Get Countries
     * @returns {Object} Countries data
     */
    async getCountries() {
        const countriesFind = await countries.findAll();

        return {
            allCountries: countriesFind,
            message: "Countries Fetched"
        };
    }

    /**
     * Get Cities
     * @returns {Object} Cities data
     */
    async getCities() {
        const getAllCities = await cities.findAll();

        return {
            allCities: getAllCities,
            message: "Fetched All Cities"
        };
    }

    /**
     * Get Business Information
     * @param {Object} data - Business info data
     * @param {number} data.userId - User ID
     * @returns {Object} Business information
     */
    async getBussinessInforMation(data) {
        const { userId } = data;

        const machineInfo = await machines.findAll();

        const findServices = await agentSelectServices.findAll({
            where: {
                agentServiceId: userId,
                status: true,
            },
            include: [
                {
                    model: service,
                    attributes: ["id", "name"],
                },
                {
                    model: users,
                    as: "agentServices",
                    attributes: ["firstName", "lastName", "email"],
                },
            ],
            attributes: ["id", "status"],
        });

        return {
            allMachineInformation: machineInfo,
            agentServices: findServices,
            message: "Information fetched"
        };
    }

    /**
     * Get Business Working Hours
     * @param {Object} data - Working hours data
     * @param {number} data.userId - User ID
     * @returns {Object} Working hours data
     */
    async getBussinessWrkinghours(data) {
        const { userId } = data;

        const bussinesWorkingHours = await bussinessWorkingHours.findAll({
            where: {
                userId: userId,
            },
            attributes: [
                "id",
                "dayOfWeek",
                "openTime",
                "closeTime",
                "status",
                "userId",
            ],
        });

        return {
            bussinesWorkingHours: bussinesWorkingHours,
            message: "Information fetched"
        };
    }

    /**
     * Get On Hold Options
     * @returns {Object} On hold options data
     */
    async getOnHoldOptions() {
        const onHoldOptions = await onHoldOption.findAll({
            where: {
                status: true
            },
            attributes: ["id", "name", "description", "status"]
        });

        return {
            onHoldOptions,
            message: "On hold options fetched"
        };
    }

    /**
     * Print Label Data
     * @param {Object} data - Print label data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Print label data
     */
    async printLabelData(data) {
        const { bookingId } = data;

        const datafind = await booking.findAll({
            where: {
                id: bookingId
            },
            include: [
                {
                    model: users,
                    as: 'customer',
                    attributes: ["id", "firstName", "lastName", "email", "phoneNum"]
                },
                {
                    model: customerSelectedService,
                    where: {
                        bookingId: bookingId
                    },
                    attributes: ['id'],
                    include: [
                        {
                            model: service,
                            attributes: ['id', 'name'],
                        }
                    ]
                }
            ]
        });

        if (!datafind || datafind.length === 0) {
            throw new NotFoundError("Booking not found");
        }

        return {
            datafind,
            message: "Print label data fetched"
        };
    }
}

module.exports = new AgentUtilityService();
