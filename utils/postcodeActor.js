/**
 * Stable identifier for postcode rate limits (registered user, guest, or IP).
 */
function getPostcodeActorId(req) {
    if (req.user?.id) {
        return `user-${req.user.id}`;
    }
    if (req.user?.jti) {
        return `guest-${req.user.jti}`;
    }

    const forwarded = req.headers["x-forwarded-for"];
    const ip =
        (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null) ||
        req.ip ||
        "unknown";

    return `ip-${ip}`;
}

module.exports = { getPostcodeActorId };
