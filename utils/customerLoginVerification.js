'use strict';

/**
 * Whether a customer may proceed past the "is this account verified?" step of
 * email/password login.
 *
 * users.verifiedAt is the source of truth. The OTP row only matters for an
 * unverified account: its id lets the app send the user to OTP verification.
 *
 * Previously login required an OTP row to exist even for verified accounts, so
 * customers verified another way (created by an admin, or provisioned) could never
 * sign in ("User Not Verified").
 *
 * @param {{ verifiedAt: Date|string|null }} user
 * @param {{ id: number }|null} otpRow
 * @returns {{ verified: true } | { verified: false, otpId: number|null }}
 */
function customerLoginVerification(user, otpRow) {
  if (user && user.verifiedAt) return { verified: true };
  return { verified: false, otpId: otpRow ? otpRow.id : null };
}

module.exports = { customerLoginVerification };
