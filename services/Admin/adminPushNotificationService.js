'use strict';

const { Op } = require('sequelize');
const { users, deviceToken } = require('../../models');
const { sendNotification } = require('../../utils/notification');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

const USER_TYPE = {
  CUSTOMER: 2,
  AGENT: 4,
};

const AUDIENCE = {
  CUSTOMERS: 'customers',
  AGENTS: 'agents',
  ALL: 'all',
};

const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_SPECIFIC_USERS = 200;
const SEND_CONCURRENCY = 15;

function audienceToUserTypeIds(audience) {
  switch (String(audience || '').toLowerCase()) {
    case AUDIENCE.CUSTOMERS:
      return [USER_TYPE.CUSTOMER];
    case AUDIENCE.AGENTS:
      return [USER_TYPE.AGENT];
    case AUDIENCE.ALL:
      return [USER_TYPE.CUSTOMER, USER_TYPE.AGENT];
    default:
      throw new ValidationError(
        'audience must be one of: customers, agents, all'
      );
  }
}

function roleLabel(userTypeId) {
  if (Number(userTypeId) === USER_TYPE.CUSTOMER) return 'customer';
  if (Number(userTypeId) === USER_TYPE.AGENT) return 'agent';
  return 'user';
}

function buildUserWhere({ userTypeIds, userIds }) {
  const where = { status: true };

  const hasCustomer = userTypeIds.includes(USER_TYPE.CUSTOMER);
  const hasAgent = userTypeIds.includes(USER_TYPE.AGENT);

  if (hasCustomer && hasAgent) {
    where[Op.or] = [
      { userTypeId: USER_TYPE.CUSTOMER },
      {
        userTypeId: USER_TYPE.AGENT,
        agentApprovalStatus: 'approved',
      },
    ];
  } else if (hasAgent) {
    where.userTypeId = USER_TYPE.AGENT;
    where.agentApprovalStatus = 'approved';
  } else {
    where.userTypeId = { [Op.in]: userTypeIds };
  }

  if (userIds && userIds.length) {
    where.id = { [Op.in]: userIds };
  }

  return where;
}

function mapUserRow(u) {
  return {
    id: u.id,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || `User #${u.id}`,
    email: u.email || null,
    phoneNumber: u.phoneNum || null,
    role: roleLabel(u.userTypeId),
    userTypeId: u.userTypeId,
  };
}

async function resolveRecipients({ audience, userIds }) {
  const userTypeIds = audienceToUserTypeIds(audience);
  const where = buildUserWhere({ userTypeIds, userIds });

  const rows = await users.findAll({
    where,
    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'userTypeId'],
    order: [['id', 'ASC']],
  });

  return rows.map(mapUserRow);
}

async function countActiveTokens(userIds) {
  if (!userIds.length) {
    return { usersWithTokens: 0, tokenCount: 0 };
  }
  const tokens = await deviceToken.findAll({
    where: {
      userId: { [Op.in]: userIds },
      status: true,
    },
    attributes: ['userId', 'tokenId'],
  });
  const uniqueUsers = new Set(tokens.map((t) => t.userId));
  return {
    usersWithTokens: uniqueUsers.size,
    tokenCount: tokens.length,
  };
}

async function searchRecipients({ audience, q, limit = 20 }) {
  const userTypeIds = audienceToUserTypeIds(audience || AUDIENCE.ALL);
  const query = String(q || '').trim();
  if (query.length < 1) {
    return { recipients: [] };
  }

  const where = buildUserWhere({ userTypeIds, userIds: null });
  const like = `%${query}%`;
  const orSearch = [
    { firstName: { [Op.like]: like } },
    { lastName: { [Op.like]: like } },
    { email: { [Op.like]: like } },
    { phoneNum: { [Op.like]: like } },
  ];
  if (Number.isFinite(Number(query)) && Number(query) > 0) {
    orSearch.push({ id: Number(query) });
  }

  const rows = await users.findAll({
    where: {
      [Op.and]: [where, { [Op.or]: orSearch }],
    },
    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'userTypeId'],
    limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
    order: [['id', 'DESC']],
  });

  return { recipients: rows.map(mapUserRow) };
}

async function previewAudience({ audience, userIds }) {
  const recipients = await resolveRecipients({ audience, userIds });
  const ids = recipients.map((r) => r.id);
  const tokenStats = await countActiveTokens(ids);

  return {
    audience,
    targetedUsers: recipients.length,
    usersWithTokens: tokenStats.usersWithTokens,
    usersWithoutTokens: Math.max(0, recipients.length - tokenStats.usersWithTokens),
    tokenCount: tokenStats.tokenCount,
    sample: recipients.slice(0, 10),
  };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => run()
  );
  await Promise.all(runners);
  return results;
}

/**
 * Enterprise admin push send.
 */
async function sendAdminPush(payload, actor = {}) {
  const audience = String(payload.audience || '').toLowerCase();
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  const dryRun = Boolean(payload.dryRun);
  const data =
    payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : {};

  if (!Object.values(AUDIENCE).includes(audience)) {
    throw new ValidationError('audience must be one of: customers, agents, all');
  }
  if (!title) throw new ValidationError('title is required');
  if (!body) throw new ValidationError('body / description is required');
  if (title.length > MAX_TITLE) {
    throw new ValidationError(`title must be <= ${MAX_TITLE} characters`);
  }
  if (body.length > MAX_BODY) {
    throw new ValidationError(`body must be <= ${MAX_BODY} characters`);
  }

  let userIds = Array.isArray(payload.userIds)
    ? [
        ...new Set(
          payload.userIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
        ),
      ]
    : [];

  const mode = String(
    payload.mode || (userIds.length ? 'specific' : 'broadcast')
  ).toLowerCase();

  if (mode === 'specific') {
    if (!userIds.length) {
      throw new ValidationError('userIds required when mode=specific');
    }
    if (userIds.length > MAX_SPECIFIC_USERS) {
      throw new ValidationError(
        `Maximum ${MAX_SPECIFIC_USERS} specific recipients per send`
      );
    }
  } else if (mode !== 'broadcast') {
    throw new ValidationError('mode must be broadcast or specific');
  } else {
    userIds = null;
  }

  const recipients = await resolveRecipients({
    audience,
    userIds: mode === 'specific' ? userIds : null,
  });

  if (mode === 'specific' && !recipients.length) {
    throw new NotFoundError(
      'No matching active recipients found for the given userIds/audience'
    );
  }

  if (mode === 'specific' && recipients.length !== userIds.length) {
    const found = new Set(recipients.map((r) => r.id));
    const missing = userIds.filter((id) => !found.has(id));
    throw new ValidationError(
      `Some userIds are invalid for audience "${audience}": ${missing
        .slice(0, 10)
        .join(', ')}`
    );
  }

  const preview = await previewAudience({
    audience,
    userIds: mode === 'specific' ? userIds : null,
  });

  if (dryRun) {
    return {
      dryRun: true,
      mode,
      audience,
      title,
      body,
      ...preview,
      message: 'Dry run only — no push was sent.',
    };
  }

  if (
    mode === 'broadcast' &&
    recipients.length > 1 &&
    payload.confirmBroadcast !== true
  ) {
    throw new ValidationError(
      'Broadcast to multiple users requires confirmBroadcast: true. Run dryRun first to preview counts.'
    );
  }

  if (!recipients.length) {
    throw new NotFoundError(`No active ${audience} found to notify`);
  }

  const startedAt = Date.now();
  const pushData = {
    type: 'admin_broadcast',
    audience,
    mode,
    sentByAdminId: actor.adminId != null ? String(actor.adminId) : '',
    sentAt: new Date().toISOString(),
    ...Object.entries(data).reduce((acc, [k, v]) => {
      acc[k] = typeof v === 'string' ? v : JSON.stringify(v);
      return acc;
    }, {}),
  };

  console.log('[AdminPush] send start', {
    audience,
    mode,
    title,
    recipientCount: recipients.length,
    adminId: actor.adminId || null,
  });

  const perUser = await mapPool(recipients, SEND_CONCURRENCY, async (recipient) => {
    try {
      const result = await sendNotification(
        recipient.id,
        title,
        body,
        pushData,
        { throwOnFailure: false }
      );
      return {
        userId: recipient.id,
        name: recipient.name,
        role: recipient.role,
        sent: Boolean(result?.sent),
        reason: result?.reason || null,
        successCount: result?.successCount || 0,
        failureCount: result?.failureCount || 0,
        tokenCount: result?.tokenCount || 0,
      };
    } catch (err) {
      return {
        userId: recipient.id,
        name: recipient.name,
        role: recipient.role,
        sent: false,
        reason: 'SEND_ERROR',
        error: err.message,
        successCount: 0,
        failureCount: 0,
        tokenCount: 0,
      };
    }
  });

  const sentUsers = perUser.filter((r) => r.sent).length;
  const noTokenUsers = perUser.filter(
    (r) => r.reason === 'NO_TOKENS' || r.tokenCount === 0
  ).length;
  const failedUsers = perUser.filter(
    (r) => !r.sent && r.reason !== 'NO_TOKENS' && r.tokenCount !== 0
  ).length;
  const totalDeviceSuccess = perUser.reduce(
    (n, r) => n + (r.successCount || 0),
    0
  );
  const totalDeviceFailure = perUser.reduce(
    (n, r) => n + (r.failureCount || 0),
    0
  );

  const summary = {
    dryRun: false,
    mode,
    audience,
    title,
    body,
    targetedUsers: recipients.length,
    usersDelivered: sentUsers,
    usersNoToken: noTokenUsers,
    usersFailed: failedUsers,
    deviceSuccessCount: totalDeviceSuccess,
    deviceFailureCount: totalDeviceFailure,
    durationMs: Date.now() - startedAt,
    sentBy: {
      adminId: actor.adminId || null,
      name: actor.adminName || null,
    },
    results: [
      ...perUser.filter((r) => !r.sent).slice(0, 50),
      ...perUser.filter((r) => r.sent).slice(0, 20),
    ],
  };

  console.log('[AdminPush] send done', {
    audience,
    mode,
    targetedUsers: summary.targetedUsers,
    usersDelivered: summary.usersDelivered,
    usersNoToken: summary.usersNoToken,
    usersFailed: summary.usersFailed,
    deviceSuccessCount: summary.deviceSuccessCount,
    durationMs: summary.durationMs,
  });

  try {
    const db = require('../../models');
    if (db.adminPushLog) {
      await db.adminPushLog.create({
        audience,
        mode,
        title,
        body,
        targetedUsers: summary.targetedUsers,
        usersDelivered: summary.usersDelivered,
        usersNoToken: summary.usersNoToken,
        usersFailed: summary.usersFailed,
        deviceSuccessCount: summary.deviceSuccessCount,
        deviceFailureCount: summary.deviceFailureCount,
        sentByAdminId: actor.adminId || null,
        payloadJson: JSON.stringify({
          data: pushData,
          sampleResults: summary.results.slice(0, 30),
        }),
      });
    }
  } catch (auditErr) {
    console.warn('[AdminPush] audit log skipped:', auditErr.message);
  }

  return summary;
}

module.exports = {
  searchRecipients,
  previewAudience,
  sendAdminPush,
  AUDIENCE,
  USER_TYPE,
};
