const dashboardService = require('./dashboardService');
const customerService = require('./customerService');
const driverService = require('./driverService');
const orderService = require('./orderService');
const serviceManagementService = require('./serviceManagementService');
const dataService = require('./dataService');
const shopManagementService = require('./shopManagementService');
const employeeManagementService = require('./employeeManagementService');
const authService = require('./authService');
const prefrencesServices = require('./prefrencesServices');
const zoneManagementService = require('./zoneManagementService');
const vehicleManagementService = require('./vehicleManagementService');
const roleManagementService = require('./roleManagementService');
const featureManagementService = require('./featureManagementService');
const locationManagementService = require('./locationManagementService');
const agentRegistrationService = require('./agentRegistrationService');
const cancellationPolicyService = require('./cancellationPolicyService');

module.exports = {
    dashboardService,
    customerService,
    driverService,
    orderService,
    serviceManagementService,
    dataService,
    shopManagementService,
    employeeManagementService,
    authService,
    prefrencesServices,
    zoneManagementService,
    vehicleManagementService,
    roleManagementService,
    featureManagementService,
    locationManagementService,
    agentRegistrationService,
    cancellationPolicyService
};
