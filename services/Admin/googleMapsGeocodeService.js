"use strict";

const axios = require("axios");
const {
  UniversalHttpError,
  ValidationError,
  StatusCodes,
} = require("../../middlewares/universalErrorHandler");

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const ADDRESS_MAX_LEN = 200;

function pickEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function getGoogleMapsServerKey() {
  return pickEnv(
    "GOOGLE_MAPS_KEY",
    "GOOGLE_MAPS_SERVER_KEY",
    "LAUNDRY_GOOGLE_MAPS_KEY"
  );
}

function parseLatLng(value) {
  const parts = String(value || "").split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lng = Number(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Normalize ISO-3166 alpha-2 for Google Geocoding region / components.
 * @param {string|undefined|null} country
 * @returns {string}
 */
function normalizeGeocodeCountry(country) {
  const iso = String(country || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!iso) return "";
  if (iso === "UK") return "GB";
  return iso.slice(0, 2);
}

/**
 * Server-side Geocoding REST. Key stays in env — never returned to the client.
 * @param {{ latlng?: string, address?: string, country?: string, components?: string }} query
 */
async function geocode({ latlng, address, country, components } = {}) {
  const apiKey = getGoogleMapsServerKey();
  if (!apiKey) {
    throw new UniversalHttpError(
      "Google Maps server key is not configured. Set GOOGLE_MAPS_KEY on the API host.",
      StatusCodes.SERVICE_UNAVAILABLE
    );
  }

  const params = { key: apiKey };
  const countryIso = normalizeGeocodeCountry(country);

  if (latlng != null && String(latlng).trim() !== "") {
    const parsed = parseLatLng(latlng);
    if (!parsed) {
      throw new ValidationError('latlng must be "latitude,longitude"');
    }
    params.latlng = `${parsed.lat},${parsed.lng}`;
  } else if (address != null && String(address).trim() !== "") {
    const trimmed = String(address).trim();
    if (trimmed.length > ADDRESS_MAX_LEN) {
      throw new ValidationError("address is too long");
    }
    params.address = trimmed;
  } else {
    throw new ValidationError("Provide latlng or address");
  }

  // Country bias / hard filter so e.g. UK-looking tokens do not resolve in the US map.
  if (components != null && String(components).trim() !== "") {
    params.components = String(components).trim();
  } else if (countryIso) {
    params.components = `country:${countryIso}`;
    params.region = countryIso.toLowerCase();
  }

  try {
    const { data } = await axios.get(GEOCODE_URL, {
      params,
      timeout: 8000,
    });
    return {
      results: Array.isArray(data?.results) ? data.results : [],
      status: data?.status || "UNKNOWN",
    };
  } catch (err) {
    const status = err.response?.status;
    throw new UniversalHttpError(
      "Google Geocoding request failed",
      status && status >= 400 && status < 600 ? status : 502
    );
  }
}

module.exports = {
  getGoogleMapsServerKey,
  parseLatLng,
  normalizeGeocodeCountry,
  geocode,
};
