const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateDriverArrivedTemplate } = require('./email');

/**
 * Send driver arrived email using ZeptoMail API with inline images
 * @param {Object} params
 * @param {string} params.email - Recipient email address
 * @param {string} params.userName - Customer's first name
 */
module.exports = async function ({ email, userName = 'Customer' }) {
  console.log("📧 Sending Driver Arrived Email via ZeptoMail API");
  console.log("   To:", email);
  console.log("   User:", userName);

  try {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    const { subject, html, inlineImages } = generateDriverArrivedTemplate({
      userName,
      footerOptions: {
        helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
        downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
        unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
      }
    });

    console.log(`📎 Prepared ${inlineImages?.length || 0} inline images for driver arrived email`);

    await sendEmailViaAPI({
      from: {
        address: fromEmail,
        name: fromName
      },
      to: email,
      subject,
      html,
      inlineImages
    });

    console.log(`✅ Driver arrived email sent successfully via ZeptoMail API`);
    return { success: true, message: 'Driver arrived email sent successfully' };
  } catch (error) {
    console.error(`❌ Error in driver arrived mail:`, error.message || error.error);
    console.error("Error details:", error.details || error);
    throw error;
  }
};
