const { sendEmailViaAPI } = require('./zeptomailApi');
const { generateOtpTemplate } = require('./email');

/**
 * Send OTP email using ZeptoMail API with base64 embedded images
 * @param {Object} params
 * @param {string} params.type - Email type ('RegisterOTP' or 'ForgetPassword')
 * @param {string} params.email - Recipient email address
 * @param {string} params.OTP - OTP code to send
 * @param {string} params.userName - User's name (optional, defaults to 'User')
 */
module.exports = async function ({ type, email, OTP, userName = 'User' }) {
  console.log("📧 Sending OTP Email via ZeptoMail API");
  console.log("   Type:", type);
  console.log("   To:", email);
  console.log("   OTP:", OTP);
  console.log("   User:", userName);

  try {
    // Use FROM_EMAIL from env or fallback to configured default
    const fromEmail = process.env.FROM_EMAIL || 'noreply@serviprapp.com';
    const fromName = process.env.FROM_NAME || 'Just Dry Cleaners';

    // Generate email template with base64 embedded images
    const { subject, html, inlineImages } = generateOtpTemplate({
      userName,
      otp: OTP,
      type,
      footerOptions: {
        helpCentreLink: 'https://prodlaundry.sigisolutions.net/help',
        
        downloadAppLink: 'https://prodlaundry.sigisolutions.net/download',
        unsubscribeLink: 'https://prodlaundry.sigisolutions.net/unsubscribe'
      }
    });

    console.log(`📎 Prepared ${inlineImages?.length || 0} inline images for email`);

    // Send email via ZeptoMail API with inline images
    await sendEmailViaAPI({
      from: {
        address: fromEmail,
        name: fromName
      },
      to: email,
      subject,
      html,
      inlineImages  // Pass inline images to ZeptoMail API
    });

    console.log(`✅ OTP email sent successfully (${type}) via ZeptoMail API`);
    return { success: true, message: 'OTP email sent successfully' };
  } catch (error) {
    console.error(`❌ Error in OTP mail (${type}):`, error.message || error.error);
    console.error("Error details:", error.details || error);
    console.error("Status:", error.status);
    throw error;
  }
};
