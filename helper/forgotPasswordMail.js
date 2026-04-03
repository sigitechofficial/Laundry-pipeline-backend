const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateForgotPasswordTemplate } = require('./email');

/**
 * Send forgot password email using ZeptoMail API with inline images
 * @param {Object} params
 * @param {string} params.email - Recipient email address
 * @param {string} params.userName - User's name
 * @param {string} params.otp - OTP code for password reset
 */
module.exports = async function ({ email, userName = 'User', otp }) {
  console.log("📧 Sending Forgot Password Email via ZeptoMail API");
  console.log("   To:", email);
  console.log("   User:", userName);

  try {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    const { subject, html, inlineImages } = generateForgotPasswordTemplate({
      userName,
      otp,
      footerOptions: {
        helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
        downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
        unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
      }
    });

    console.log(`📎 Prepared ${inlineImages?.length || 0} inline images for forgot password email`);

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

    console.log(`✅ Forgot password email sent successfully via ZeptoMail API`);
    return { success: true, message: 'Forgot password email sent successfully' };
  } catch (error) {
    console.error(`❌ Error in forgot password mail:`, error.message || error.error);
    console.error("Error details:", error.details || error);
    console.error("Status:", error.status);
    throw error;
  }
};
