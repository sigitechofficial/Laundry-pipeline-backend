"use strict";

/**
 * Shared zone resolution for customer, agent, and admin.
 * Order: reverse-geocode postcode → exact postcode → outcode → geometry → nearest centroid.
 */

const { zone, cities, countries, units } = require("../models");
const { Op } = require("sequelize");
const sequelize = require("sequelize");

const zoneInclude = [
  {
    model: cities,
    required: true,
    attributes: ["id", "name", "lat", "lng", "status"],
    where: { deletedAt: { [Op.is]: null } },
    include: [
      {
        model: countries,
        required: true,
        attributes: ["id", "name", "shortName", "status", "ianaTimeZone"],
        where: { deletedAt: { [Op.is]: null } },
      },
    ],
  },
  {
    model: units,
    as: "currencyUnitZ",
    required: false,
    attributes: ["id", "name", "symbol"],
  },
];

const zoneAttributes = [
  "id",
  "name",
  "zoneMinimumAmount",
  "serviceCharge",
  "status",
  "coordinates",
  "currencyUnitId",
  "postcodes",
];

function extractOutcode(postcode) {
  const normalized = String(postcode || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  if (normalized.length <= 3) return normalized;
  return normalized.slice(0, normalized.length - 3);
}

async function findZoneByPostcode(postcode) {
  const normalized = String(postcode || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!normalized) return [];
  const outcode = extractOutcode(normalized);

  const exactZones = await zone.findAll({
    where: {
      status: true,
      [Op.and]: [
        sequelize.where(
          sequelize.fn(
            "JSON_CONTAINS",
            sequelize.col("postcodes"),
            JSON.stringify(normalized)
          ),
          true
        ),
      ],
    },
    include: zoneInclude,
    attributes: zoneAttributes,
  });
  if (exactZones.length > 0) return exactZones;

  return zone.findAll({
    where: {
      status: true,
      [Op.and]: [
        sequelize.where(
          sequelize.fn(
            "JSON_CONTAINS",
            sequelize.col("postcodes"),
            JSON.stringify(outcode)
          ),
          true
        ),
      ],
    },
    include: zoneInclude,
    attributes: zoneAttributes,
  });
}

async function pickNearestZoneByCentroid(candidateZones, lat, lng) {
  if (!Array.isArray(candidateZones) || candidateZones.length <= 1) {
    return candidateZones || [];
  }
  const zoneIds = candidateZones.map((z) => z?.id).filter((id) => Number.isInteger(id));
  if (zoneIds.length <= 1) return [candidateZones[0]];

  const safeLat = Number(lat);
  const safeLng = Number(lng);
  if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) {
    return [candidateZones[0]];
  }

  const pointWkt = `POINT(${safeLng} ${safeLat})`;
  const nearestZone = await zone.findOne({
    where: { status: true, id: { [Op.in]: zoneIds } },
    include: zoneInclude,
    attributes: [
      ...zoneAttributes,
      [
        sequelize.fn(
          "ST_Distance",
          sequelize.fn("ST_Centroid", sequelize.col("coordinates")),
          sequelize.fn("ST_GeomFromText", pointWkt)
        ),
        "centroidDistance",
      ],
    ],
    order: [
      [sequelize.literal("centroidDistance"), "ASC"],
      ["id", "ASC"],
    ],
  });
  return nearestZone ? [nearestZone] : [candidateZones[0]];
}

async function findZones(lat, lng) {
  let postcodeLookupResult = null;
  try {
    const axios = require("axios");
    const response = await axios.get(
      `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}`,
      { timeout: 5000 }
    );
    if (
      response.data.status === 200 &&
      response.data.result &&
      response.data.result.length > 0
    ) {
      postcodeLookupResult = response.data.result[0].postcode;
    }
  } catch (err) {
    console.warn("[findZones] postcodes.io failed:", err.message);
  }

  if (postcodeLookupResult) {
    const postcodeZones = await findZoneByPostcode(postcodeLookupResult);
    if (postcodeZones.length === 1) return postcodeZones;
    if (postcodeZones.length > 1) {
      return pickNearestZoneByCentroid(postcodeZones, lat, lng);
    }
  }

  const geoZones = await zone.findAll({
    where: {
      status: true,
      coordinates: sequelize.where(
        sequelize.fn(
          "ST_Contains",
          sequelize.col("coordinates"),
          sequelize.fn("ST_GeomFromText", `POINT(${lng} ${lat})`)
        ),
        true
      ),
    },
    include: zoneInclude,
    attributes: zoneAttributes,
    order: [["id", "ASC"]],
  });

  if (geoZones.length > 1) {
    return pickNearestZoneByCentroid(geoZones, lat, lng);
  }
  return geoZones;
}

module.exports = {
  findZones,
  findZoneByPostcode,
  pickNearestZoneByCentroid,
  extractOutcode,
  zoneInclude,
  zoneAttributes,
};
