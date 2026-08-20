'use strict';

/**
 * Country-scoped postal / ZIP validation for zone management.
 * Keep in sync with admin-panel/src/utilities/postalCodeValidation.js
 */

const UK_FULL =
  /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const UK_OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const US_ZIP = /^\d{5}(-\d{4})?$/;
const PK_POSTAL = /^\d{5}$/;
const CA_POSTAL = /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i;
const AU_POSTAL = /^\d{4}$/;
const IE_EIRCODE = /^[A-Z]\d{2}\s*[A-Z0-9]{4}$/i;

const COUNTRY_ALIASES = Object.freeze({
  UK: 'GB',
  GBR: 'GB',
  USA: 'US',
  UNITEDSTATES: 'US',
  PAK: 'PK',
});

function normalizeCountryIso(countryLike) {
  if (countryLike == null) return '';
  let raw = '';
  if (typeof countryLike === 'string') {
    raw = countryLike;
  } else if (typeof countryLike === 'object') {
    raw =
      countryLike.shortName ??
      countryLike.code ??
      countryLike.iso ??
      countryLike.iso2 ??
      countryLike.countryCode ??
      '';
  }
  const key = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key) return '';
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  if (key.length === 2) return key;
  return key.slice(0, 2);
}

function normalizePostalInput(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function compactPostal(value) {
  return normalizePostalInput(value).replace(/\s+/g, '');
}

const RULES = Object.freeze({
  GB: {
    label: 'UK postcode',
    examples: ['SW1A 1AA', 'EC1A 1BB', 'NW1'],
    placeholder:
      'Enter UK postcodes separated by comma: SW1A 1AA, EC1A 1BB, NW1',
    isValid(normalized) {
      const compact = compactPostal(normalized);
      return UK_FULL.test(normalized) || UK_OUTCODE.test(compact);
    },
    formatHint: 'Use a UK postcode (e.g. SW1A 1AA) or outward code (e.g. NW1).',
  },
  US: {
    label: 'US ZIP code',
    examples: ['10001', '10001-1234'],
    placeholder:
      'Enter US ZIP codes separated by comma: 10001, 10002, 11201',
    isValid(normalized) {
      return US_ZIP.test(compactPostal(normalized));
    },
    formatHint: 'Use a US ZIP code (5 digits, or ZIP+4 like 10001-1234).',
  },
  PK: {
    label: 'Pakistan postal code',
    examples: ['54000', '75500'],
    placeholder:
      'Enter Pakistan postal codes separated by comma: 54000, 75500',
    isValid(normalized) {
      return PK_POSTAL.test(compactPostal(normalized));
    },
    formatHint: 'Use a 5-digit Pakistan postal code (e.g. 54000).',
  },
  CA: {
    label: 'Canadian postal code',
    examples: ['M5V 3L9', 'K1A 0B1'],
    placeholder:
      'Enter Canadian postal codes separated by comma: M5V 3L9, K1A 0B1',
    isValid(normalized) {
      return CA_POSTAL.test(normalized);
    },
    formatHint: 'Use a Canadian postal code (e.g. M5V 3L9).',
  },
  AU: {
    label: 'Australian postcode',
    examples: ['2000', '3000'],
    placeholder:
      'Enter Australian postcodes separated by comma: 2000, 3000',
    isValid(normalized) {
      return AU_POSTAL.test(compactPostal(normalized));
    },
    formatHint: 'Use a 4-digit Australian postcode (e.g. 2000).',
  },
  IE: {
    label: 'Irish Eircode',
    examples: ['D02 AF30', 'A65 F4E2'],
    placeholder:
      'Enter Irish Eircodes separated by comma: D02 AF30, A65 F4E2',
    isValid(normalized) {
      return IE_EIRCODE.test(normalized);
    },
    formatHint: 'Use an Irish Eircode (e.g. D02 AF30).',
  },
});

function getPostalRule(countryLike) {
  const iso = normalizeCountryIso(countryLike);
  return iso ? RULES[iso] || null : null;
}

function isUkCountry(countryLike) {
  return normalizeCountryIso(countryLike) === 'GB';
}

/**
 * @returns {{
 *   ok: boolean,
 *   iso: string,
 *   normalized: string,
 *   message?: string,
 *   examples?: string[],
 * }}
 */
function validatePostalCodeForCountry(postalCode, countryLike) {
  const normalized = normalizePostalInput(postalCode);
  const iso = normalizeCountryIso(countryLike);

  if (!normalized) {
    return {
      ok: false,
      iso,
      normalized: '',
      message: 'Postal code is required.',
    };
  }

  if (!iso) {
    return {
      ok: false,
      iso: '',
      normalized,
      message: 'Select a country before adding postal codes.',
    };
  }

  const rule = RULES[iso];
  if (!rule) {
    // Unknown country: accept non-empty alphanumeric tokens; still reject clear UK-only shapes
    // when the country is not GB (avoids RM8 1AA leaking into arbitrary markets).
    if (UK_FULL.test(normalized) || UK_OUTCODE.test(compactPostal(normalized))) {
      return {
        ok: false,
        iso,
        normalized,
        message: `"${normalized}" looks like a UK postcode, which is not valid for the selected country.`,
      };
    }
    return { ok: true, iso, normalized };
  }

  if (!rule.isValid(normalized)) {
    return {
      ok: false,
      iso,
      normalized,
      message: `"${normalized}" is not a valid ${rule.label} for this country. ${rule.formatHint}`,
      examples: rule.examples,
    };
  }

  return { ok: true, iso, normalized };
}

function validatePostalCodesForCountry(postalCodes, countryLike) {
  const list = Array.isArray(postalCodes) ? postalCodes : [];
  const invalid = [];
  for (const pc of list) {
    const result = validatePostalCodeForCountry(pc, countryLike);
    if (!result.ok) invalid.push(result);
  }
  return {
    ok: invalid.length === 0,
    invalid,
    iso: normalizeCountryIso(countryLike),
  };
}

function postalCodePlaceholderForCountry(countryLike) {
  const rule = getPostalRule(countryLike);
  if (rule?.placeholder) return rule.placeholder;
  return 'Enter postal codes separated by comma';
}

function postalCodeExamplesForCountry(countryLike) {
  const rule = getPostalRule(countryLike);
  return rule?.examples ? [...rule.examples] : [];
}

module.exports = {
  normalizeCountryIso,
  normalizePostalInput,
  compactPostal,
  isUkCountry,
  getPostalRule,
  validatePostalCodeForCountry,
  validatePostalCodesForCountry,
  postalCodePlaceholderForCountry,
  postalCodeExamplesForCountry,
  RULES,
};
