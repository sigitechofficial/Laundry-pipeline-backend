'use strict';

/**
 * Customer phone rules aligned with the customer app (UK default +44).
 * Accepts 07…, national without trunk 0, +44…, and other E.164 numbers.
 */
const PHONE_HINT =
  'Enter a valid UK phone number (e.g. 07911 123456 or +44 7911 123456).';

function compactPhone(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  return digits;
}

function isValidCustomerPhone(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return false;
  if (/[a-zA-Z]/.test(trimmed)) return false;

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return false;

  if (trimmed.startsWith('+')) {
    return /^\+[1-9]\d{7,14}$/.test(`+${digits}`);
  }

  // UK with trunk zero: 07911 123456
  if (digits.length === 11 && digits.startsWith('0')) return true;
  // UK national without trunk: 7911 123456 (mobile) or 10-digit landline
  if (digits.length === 10) return true;
  // 44 prefix without plus
  if (digits.startsWith('44') && digits.length >= 12 && digits.length <= 13) {
    return true;
  }

  return false;
}

function customerPhoneError(raw) {
  if (!String(raw || '').trim()) return 'Phone number is required';
  if (!isValidCustomerPhone(raw)) return PHONE_HINT;
  return null;
}

module.exports = {
  PHONE_HINT,
  compactPhone,
  isValidCustomerPhone,
  customerPhoneError,
};
