require('dotenv').config();
const admin = require('firebase-admin');
const { deviceToken } = require('../models');
const { Op } = require('sequelize');
const serviceAccount = require('../firebase.json')

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/**
 * Send a notification to a user
 * @param {string} userId - The ID of the user to send the notification to
 * @param {string} title - The title of the notification
 * @param {string} body - The body of the notification
 * @param {object} data - Additional data to send with the notification
 */
async function sendNotification(userId, title, body, data = {}, options = {}) {
  try {
    const { throwOnFailure = false } = options;

    // Retrieve device tokens for the user
    const tokens = await deviceToken.findAll({
      where: { userId, status: true },
      attributes: ['tokenId']
    });

    if (!tokens || tokens.length === 0) {
      console.log(`No device tokens found for user ++++++++++++++++++++++++++ ${userId}`);
      const result = {
        sent: false,
        reason: 'NO_TOKENS',
        userId,
        successCount: 0,
        failureCount: 0,
        tokenCount: 0
      };
      if (throwOnFailure) {
        throw new Error(`No active device tokens found for user ${userId}`);
      }
      return result;
    }

    const tokenIds = tokens.map(token => token.tokenId);
    const sanitizedData = Object.entries(data || {}).reduce((acc, [key, value]) => {
      acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
      return acc;
    }, {});

    // Create the message payload
    const message = {
      notification: {
        title,
        body
      },
      data: sanitizedData,
      tokens: tokenIds
    };

    // Send the notification
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('Successfully sent message:', response);

    const failedTokens = response.responses
      .map((resp, index) => ({ resp, token: tokenIds[index] }))
      .filter(({ resp }) => !resp.success)
      .map(({ resp, token }) => ({
        token,
        code: resp.error?.code || 'unknown-error',
        message: resp.error?.message || 'Unknown FCM error'
      }));

    const invalidTokens = failedTokens
      .filter(item =>
        item.code === 'messaging/registration-token-not-registered' ||
        item.code === 'messaging/invalid-registration-token'
      )
      .map(item => item.token);

    if (invalidTokens.length > 0) {
      await deviceToken.destroy({
        where: {
          userId,
          tokenId: { [Op.in]: invalidTokens }
        }
      });
    }

    const result = {
      sent: response.successCount > 0,
      userId,
      tokenCount: tokenIds.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      failedTokens
    };

    if (throwOnFailure && response.successCount === 0) {
      throw new Error(`Notification send failed for all tokens: ${JSON.stringify(failedTokens)}`);
    }

    return result;
  } catch (error) {
    console.error('Error sending notification:', error);
    if (options?.throwOnFailure) {
      throw error;
    }
    return {
      sent: false,
      reason: 'SEND_ERROR',
      error: error.message
    };
  }
}

module.exports = { sendNotification }; 