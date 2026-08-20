'use strict';

const assert = require('assert');
const { Op } = require('sequelize');
const db = require('../models');
const adminController = require('../controllers/Admin/admin');
const agentController = require('../controllers/Agent/agents');
const complianceController = require('../controllers/Admin/agentComplianceController');
const paymentFailureController = require('../controllers/Admin/invoicePaymentFailureController');
const customerService = require('../services/Admin/customerService');
const driverService = require('../services/Admin/driverService');
const adminValidateToken = require('../middlewares/adminValidateToken');
const {
  markPlatformAdminRequest,
} = require('../middlewares/platformAdminContext');

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

async function invoke(controller, req) {
  const res = responseRecorder();
  await controller(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.status, '1');
  return res.body.data;
}

async function assertRejectsWithStatus(promise, statusCode) {
  await assert.rejects(promise, (error) => error.statusCode === statusCode);
}

async function run() {
  await db.sequelize.authenticate();

  const queryInterface = db.sequelize.getQueryInterface();
  const bookingColumns = await queryInterface.describeTable('bookings');
  for (const column of [
    'pickupArrivedGeofenceOverride',
    'deliveryArrivedGeofenceOverride',
    'pickupCompleteGeofenceOverride',
    'deliveryCompleteGeofenceOverride',
  ]) {
    assert(bookingColumns[column], `bookings.${column} must exist`);
  }
  for (const table of [
    'attempt_fail_instruction_sets',
    'attempt_fail_instructions',
    'attempt_fail_reasons',
    'agent_compliance_events',
  ]) {
    await queryInterface.describeTable(table);
  }

  const unauthorized = responseRecorder();
  await adminValidateToken(
    { cookies: {}, headers: {} },
    unauthorized,
    () => assert.fail('request without a token must not continue')
  );
  assert.strictEqual(unauthorized.statusCode, 403);

  const contextRequest = {};
  let contextContinued = false;
  markPlatformAdminRequest(contextRequest, {}, () => {
    contextContinued = true;
  });
  assert.strictEqual(contextContinued, true);
  assert.strictEqual(contextRequest.isPlatformAdminRequest, true);

  const customer = await db.users.findOne({
    where: { userTypeId: 2 },
    attributes: ['id'],
  });
  assert(customer, 'local integration DB needs at least one customer');
  const customerData = await invoke(
    adminController.specificCustomerDetails,
    { params: { customerId: String(customer.id) } }
  );
  assert(Array.isArray(customerData.bookingDetails));
  assert.strictEqual(Number(customerData.userDetails.user.id), Number(customer.id));
  await assertRejectsWithStatus(
    customerService.getSpecificCustomerDetails(2147483647),
    404
  );

  const driver = await db.driverInZones.findOne({ attributes: ['driverId'] });
  assert(driver, 'local integration DB needs at least one zoned driver');
  const driverData = await invoke(adminController.specificdriverDetail, {
    params: { driverId: String(driver.driverId) },
  });
  assert(Array.isArray(driverData.driverBookings));
  await assertRejectsWithStatus(
    driverService.getSpecificDriverDetails(2147483647),
    404
  );

  const paymentData = await invoke(paymentFailureController.listPaymentFailures, {
    query: { limit: '50' },
  });
  assert(Array.isArray(paymentData.failures));
  assert.strictEqual(paymentData.count, paymentData.totalCount);

  const instructionSets = await invoke(
    complianceController.listFailInstructionSets,
    { query: { scope: 'pickup' } }
  );
  assert(Array.isArray(instructionSets));

  const failReasons = await invoke(complianceController.listFailReasons, {
    query: { scope: 'pickup' },
  });
  assert(Array.isArray(failReasons));

  const geofenceReport = await invoke(
    complianceController.getGeofenceOverrideReport,
    { query: {} }
  );
  assert(geofenceReport.summary);
  assert(Array.isArray(geofenceReport.byActor));

  const events = await invoke(complianceController.listComplianceEvents, {
    query: { overridesOnly: 'true', limit: '50' },
  });
  assert(Array.isArray(events.rows));
  assert.strictEqual(events.limit, 50);
  await assertRejectsWithStatus(
    complianceController.listComplianceEvents({
      query: { from: 'not-a-date' },
    }, responseRecorder()),
    400
  );

  const invoiceBooking = await db.booking.findOne({
    where: { laundryShopId: { [Op.ne]: null } },
    attributes: ['id'],
    order: [['id', 'DESC']],
  });
  assert(invoiceBooking, 'local integration DB needs one shop-assigned booking');
  const invoice = await invoke(agentController.invoiceCreation, {
    params: { bookingId: String(invoiceBooking.id) },
    user: { id: 1 },
    isPlatformAdminRequest: true,
  });
  assert.strictEqual(Number(invoice.invoiceDetails.id), Number(invoiceBooking.id));
  await assertRejectsWithStatus(
    agentController.invoiceCreation(
      {
        params: { bookingId: String(invoiceBooking.id) },
        user: { id: 2147483647 },
      },
      responseRecorder()
    ),
    403
  );
  await assertRejectsWithStatus(
    agentController.invoiceCreation(
      {
        params: { bookingId: '2147483647' },
        user: { id: 1 },
        isPlatformAdminRequest: true,
      },
      responseRecorder()
    ),
    404
  );

  console.log('adminEnterpriseEndpoints.integration.test.js: all assertions passed');
}

run()
  .then(async () => {
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await db.sequelize.close().catch(() => {});
    process.exit(1);
  });
