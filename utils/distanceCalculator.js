const axios = require('axios');
const googleMapApiKey = 'AIzaSyAVYbP2F93xvY4i59UVNfAfYR62dmbKNFA'

module.exports = async function (userLat, userLng, orderLat, orderLng) {
    const earth_radius = 6371;
    const dLat = (Math.PI / 180) * (orderLat - userLat);
    const dLon = (Math.PI / 180) * (orderLng - userLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((Math.PI / 180) * orderLat) *
        Math.cos((Math.PI / 180) * orderLat) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.asin(Math.sqrt(a));
    const d = earth_radius * c; // d is in mles
    const km = d * 1.60934; // coonvert miles into kms
    return parseFloat(km.toFixed(2));
}