const { literal } = require('sequelize');

/**
 * Calculates the distance between two geographical points using the Haversine formula.
 * @param {number} targetLat - The latitude of the target location.
 * @param {number} targetLng - The longitude of the target location.
 * @param {number} lat - The latitude of the other point (e.g., service area or user's address).
 * @param {number} lng - The longitude of the other point (e.g., service area or user's address).
 * @returns {string} - The Sequelize literal query expression to calculate distance.
 */
function calculateDistanceFormula(targetLat, targetLng, lat, lng) {
    return literal(`
        6371 * acos(
            cos(radians(${targetLat})) * cos(radians(${lat})) *
            cos(radians(${lng}) - radians(${targetLng})) +
            sin(radians(${targetLat})) * sin(radians(${lat}))
        )
    `);
}


return calculateDistanceFormula