"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const googleMapsGeocodeService = require("../../services/Admin/googleMapsGeocodeService");

/**
 * GET /admin/maps/geocode?latlng=lat,lng
 * GET /admin/maps/geocode?address=...
 */
async function geocode(req, res) {
  const data = await googleMapsGeocodeService.geocode({
    latlng: req.query.latlng,
    address: req.query.address,
  });
  return ResponseHelper.success(res, "Geocode results", data);
}

module.exports = {
  geocode,
};
