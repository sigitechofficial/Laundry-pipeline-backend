const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateSignupWelcomeTemplate } = require('./email');

/**
 * Send signup welcome email using ZeptoMail API with inline images
 * @param {Object} params
 * @param {string} params.email - Recipient email address
 * @param {string} params.userName - User's name
 * @param {string} [params.bookOrderLink] - Custom link to book first order (optional)
 */
module.exports = async function ({ email, userName = 'User', bookOrderLink }) {
  console.log("📧 Sending Signup Welcome Email via ZeptoMail API");
  console.log("   To:", email);
  console.log("   User:", userName);

  try {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    // Generate welcome email template with inline images
    const { subject, html, inlineImages } = generateSignupWelcomeTemplate({
      userName,
      bookOrderLink: bookOrderLink || 'https://prodlaundry.sigisolutions.net/book-order',
      footerOptions: {
        helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
        downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
        unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
      }
    });

    console.log(`📎 Prepared ${inlineImages?.length || 0} inline images for welcome email`);

    // Send email via ZeptoMail API with inline images
    await sendEmailViaAPI({
      from: {
        address: fromEmail,
        name: fromName
      },
      to: ['sigidevelopers@gmail.com'],
      subject,
      html,
      inlineImages
    });

    console.log(`✅ Signup welcome email sent successfully via ZeptoMail API`);
    return { success: true, message: 'Welcome email sent successfully' };
  } catch (error) {
    console.error(`❌ Error in signup welcome mail:`, error.message || error.error);
    console.error("Error details:", error.details || error);
    console.error("Status:", error.status);
    throw error;
  }
};
