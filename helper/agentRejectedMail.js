const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateAgentRejectedTemplate } = require('./email');

/**
 * Shop registration not approved (queued through the email outbox).
 * @param {Object} params - { email, userName, shopName, reasons, note }
 */
module.exports = async function ({ email, userName = 'there', shopName = null, reasons = [], note = null }) {
  const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
  const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

  const { subject, html, inlineImages } = generateAgentRejectedTemplate({
    userName,
    shopName,
    reasons,
    note,
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
  return { success: true, message: 'Agent rejection email sent' };
};
