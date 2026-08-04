require('dotenv').config();
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { deviceToken } = require('../models');
const { Op } = require('sequelize');

// Initialize Firebase Admin SDK only when a local service-account file exists.
// Guard prevents "already exists" crash on hot reload.
const firebaseCredPath = path.join(__dirname, '../firebase.json');
let firebaseReady = false;
if (fs.existsSync(firebaseCredPath) && !admin.apps.length) {
  try {
    const serviceAccount = require(firebaseCredPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseReady = true;
  } catch (err) {
    console.warn('Firebase Admin not initialized (invalid or missing firebase.json):', err.message);
  }
} else if (admin.apps.length) {
  firebaseReady = true;
} else {
  console.warn('Firebase Admin skipped: firebase.json not found (push notifications disabled locally).');
}

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

    if (!firebaseReady) {
      const result = {
        sent: false,
        reason: 'FIREBASE_NOT_CONFIGURED',
        userId,
        successCount: 0,
        failureCount: 0,
        tokenCount: 0
      };
      if (throwOnFailure) {
        throw new Error('Firebase Admin is not configured (missing firebase.json)');
      }
      return result;
    }

    // Retrieve device tokens for the user
    const tokens = await deviceToken.findAll({
      where: { userId, status: true },
      attributes: ['tokenId']
    });

    console.log("🚀 ~ sendNotification ~ tokens:", tokens);

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

    // Create the message payload with platform-specific config
    const message = {
      notification: {
        title,
        body
      },
      data: sanitizedData,
      // Android: high priority bypasses battery optimization/Doze mode
      android: {
        priority: 'high',
        notification: {
          channelId: 'laundry_default',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
          sound: 'default',
          tag: `${userId}_${Date.now()}`
        }
      },
      // iOS (APNs)
      apns: {
        headers: {
          'apns-priority': '10'
        },
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            contentAvailable: true,
            mutableContent: true
          }
        }
      },
      // Web Push
      webpush: {
        headers: {
          Urgency: 'high'
        },
        notification: {
          title,
          body,
          icon: '/icons/icon-192x192.png'
        }
      },
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