'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require('../../middlewares/universalErrorHandler');

const { JOB_TTL_MS, PRINT_KINDS, effectiveStatus } = require('./printJobStatus');

const { printJob, shopPrinter } = db;

function serializeJob(row) {
  const job = row.toJSON ? row.toJSON() : row;
  return {
    id: job.id,
    shopUserId: job.shopUserId,
    bookingId: job.bookingId,
    kind: job.kind,
    status: effectiveStatus(job),
    channel: job.channel || null,
    message: job.message || null,
    claimedByUserId: job.claimedByUserId || null,
    createdAt: job.createdAt,
    claimedAt: job.claimedAt || null,
    completedAt: job.completedAt || null,
    expiresAt: job.expiresAt,
  };
}

function toDevicePayload(job) {
  return { jobId: job.id, kind: job.kind, bookingId: job.bookingId };
}

async function assertPrinterConfigured(shopUserId) {
  const row = await shopPrinter.findOne({ where: { shopUserId } });
  if (!row || !row.enabled || !row.ipAddress) {
    throw new ValidationError(
      'Star printer is not set up for this shop. Configure it under Shop → Printer first.'
    );
  }
}

/**
 * @param {(shopUserId:number, payload:object) => void} notifyShop pushes the job to the shop's devices
 */
async function createJob({ shopUserId, bookingId = null, kind, requestedByUserId = null }, notifyShop) {
  if (!PRINT_KINDS.has(kind)) throw new ValidationError(`Unsupported print kind: ${kind}`);
  if (!shopUserId) throw new ValidationError('No shop linked to this print request');
  await assertPrinterConfigured(shopUserId);

  const job = await printJob.create({
    shopUserId,
    bookingId,
    kind,
    requestedByUserId,
    status: 'pending',
    expiresAt: new Date(Date.now() + JOB_TTL_MS),
  });

  if (notifyShop) {
    try {
      notifyShop(shopUserId, toDevicePayload(job));
    } catch (err) {
      console.error('[printJob] notify failed', err?.message || err);
    }
  }
  return serializeJob(job);
}

async function getJob(jobId) {
  const job = await printJob.findByPk(jobId);
  if (!job) throw new NotFoundError('Print job not found');
  return serializeJob(job);
}

async function listPendingForShop(shopUserId) {
  const rows = await printJob.findAll({
    where: { shopUserId, status: 'pending', expiresAt: { [Op.gt]: new Date() } },
    order: [['createdAt', 'ASC']],
    limit: 20,
  });
  return rows.map(toDevicePayload);
}

/** Only one device per shop wins the claim, so a job never prints twice. */
async function claimJob(jobId, shopUserId, deviceUserId) {
  const [count] = await printJob.update(
    { status: 'printing', claimedByUserId: deviceUserId, claimedAt: new Date() },
    {
      where: {
        id: jobId,
        shopUserId,
        status: 'pending',
        expiresAt: { [Op.gt]: new Date() },
      },
    }
  );
  return count === 1;
}

async function completeJob(jobId, shopUserId, deviceUserId, { success, channel, message }) {
  const [count] = await printJob.update(
    {
      status: success ? 'printed' : 'failed',
      channel: channel ? String(channel).slice(0, 32) : null,
      message: message ? String(message).slice(0, 500) : null,
      completedAt: new Date(),
    },
    {
      where: { id: jobId, shopUserId, claimedByUserId: deviceUserId, status: 'printing' },
    }
  );
  if (count !== 1) throw new ConflictError('Print job is not claimed by this device');
  return getJob(jobId);
}

module.exports = {
  createJob,
  getJob,
  listPendingForShop,
  claimJob,
  completeJob,
};
