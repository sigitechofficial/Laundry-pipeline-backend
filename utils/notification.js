require('dotenv').config();
const admin = require('firebase-admin');
const { deviceToken } = require('../models');
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
async function sendNotification(userId, title, body, data = {}) {
  try {
    // Retrieve device tokens for the user
    const tokens = await deviceToken.findAll({
      where: { userId },
      attributes: ['tokenId']
    });

    if (!tokens || tokens.length === 0) {
      console.log(`No device tokens found for user ++++++++++++++++++++++++++ ${userId}`);
      return;
    }

    const tokenIds = tokens.map(token => token.tokenId);

    // Create the message payload
    const message = {
      notification: {
        title,
        body
      },
      data,
      tokens: tokenIds
    };

    // Send the notification
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('Successfully sent message:', response);
  } catch (error) {
    console.error('Error sending notification:', error);
  }
}

module.exports = { sendNotification }; 