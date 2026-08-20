module.exports = async function (userLat, userLng, orderLat, orderLng) {
    const coordinates = [userLat, userLng, orderLat, orderLng].map(Number);
    if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
        throw new TypeError('Distance coordinates must be finite numbers');
    }

    const [fromLat, fromLng, toLat, toLng] = coordinates;
    const toRadians = (degrees) => (Math.PI / 180) * degrees;
    const earthRadiusKm = 6371;
    const dLat = toRadians(toLat - fromLat);
    const dLng = toRadians(toLng - fromLng);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(fromLat)) *
        Math.cos(toRadians(toLat)) *
        Math.sin(dLng / 2) ** 2;
    const angularDistance = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Number((earthRadiusKm * angularDistance).toFixed(2));
};