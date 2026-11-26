const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateOnHoldTemplate } = require('./email');

/**
 * Items on hold email (queued through the email outbox).
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.userName
 * @param {string} params.orderNumber
 * @param {Array} params.items - [{ serviceName, itemName, pieces, risk, shopNote, photo }]
 */
module.exports = async function ({ email, userName = 'Customer', orderNumber = '', items = [] }) {
  const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
  const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

  const { subject, html, inlineImages } = generateOnHoldTemplate({
    userName,
    orderNumber,
    items,
    footerOptions: {
      helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
      downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
      unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe',
    },
  });

  await sendEmailViaAPI({
    from: { address: fromEmail, name: fromName },
    to: email,
    subject,
    html,
    inlineImages,
  });
  return { success: true, message: 'On-hold email sent' };
};
