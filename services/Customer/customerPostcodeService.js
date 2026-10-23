require("dotenv").config();
const axios = require("axios");
const redisCli = require("../../redis/redis");
const {
    ValidationError,
    NotFoundError,
    TooManyRequestsError,
} = require("../../middlewares/universalErrorHandler");

const POSTCODE_REGEX = /^[A-Z]{1,2}[0-9]{1,2}[A-Z]?[0-9][A-Z]{2}$/;
const OUTCODE_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXY";
const CACHE_PREFIX = "addr:v2:";
const COOLDOWN_PREFIX = "cooldown:pc:addr:";

const CACHE_TTL_SEC = 14 * 24 * 60 * 60; // 2 weeks
const COOLDOWN_SEC = 30; // seconds between paid address searches (per user)

// Free postcode suggestions (postcodes.io) — cached so typing doesn't re-query it.
const AUTOCOMPLETE_CACHE_PREFIX = "pc:ac:v1:";
const AUTOCOMPLETE_CACHE_TTL_SEC = 24 * 60 * 60; // 1 day
const AUTOCOMPLETE_EMPTY_CACHE_TTL_SEC = 60 * 60; // 1 hour for "no suggestions"
// Whether an outcode (NW11, SW1A…) exists — practically permanent, so cached for long.
const OUTCODE_CACHE_PREFIX = "pc:oc:v1:";
const OUTCODE_CACHE_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const OUTCODE_CHECK_BATCH = 20; // postcodes.io requests in flight at once

class CustomerPostcodeService {
    normalizePostcode(postcode) {
        return postcode.trim().replace(/\s+/g, "").toUpperCase();
    }

    formatSpacedPostcode(normalizedPostcode) {
        return normalizedPostcode.replace(
            /^([A-Z]{1,2}\d{1,2}[A-Z]?)(\d[A-Z]{2})$/,
            "$1 $2"
        );
    }

    validatePostcodeFormat(postcode) {
        if (!postcode || typeof postcode !== "string") {
            return {
                isValid: false,
                message: "Postcode is required",
            };
        }

        const normalizedPostcode = this.normalizePostcode(postcode);

        if (!POSTCODE_REGEX.test(normalizedPostcode)) {
            return {
                isValid: false,
                message: "Invalid UK postcode format",
                normalizedPostcode,
            };
        }

        return {
            isValid: true,
            message: "Valid postcode format",
            normalizedPostcode,
            spacedPostcode: this.formatSpacedPostcode(normalizedPostcode),
        };
    }

    async safeRedisGet(key) {
        try {
            return await redisCli.get(key);
        } catch (error) {
            console.warn("[postcode] Redis GET failed:", error.message);
            return null;
        }
    }

    async safeRedisSetEx(key, ttl, value) {
        try {
            await redisCli.setEx(key, ttl, value);
        } catch (error) {
            console.warn("[postcode] Redis SET failed:", error.message);
        }
    }

    async safeRedisTtl(key) {
        try {
            return await redisCli.ttl(key);
        } catch {
            return COOLDOWN_SEC;
        }
    }

    async safeRedisSetCooldown(key, ttl) {
        try {
            await redisCli.setEx(key, ttl, "1");
        } catch (error) {
            console.warn("[postcode] Redis cooldown SET failed:", error.message);
        }
    }

    async assertAddressSearchCooldown(actorId) {
        if (!actorId) {
            return;
        }

        const key = `${COOLDOWN_PREFIX}${actorId}`;
        const active = await this.safeRedisGet(key);
        if (active) {
            const retryAfterSeconds = await this.safeRedisTtl(key);
            throw new TooManyRequestsError(
                "Please wait before searching another postcode.",
                { retryAfterSeconds: retryAfterSeconds > 0 ? retryAfterSeconds : COOLDOWN_SEC }
            );
        }
    }

    async setAddressSearchCooldown(actorId) {
        if (!actorId) {
            return;
        }
        await this.safeRedisSetCooldown(`${COOLDOWN_PREFIX}${actorId}`, COOLDOWN_SEC);
    }

    async verifyPostcodeWithPostcodesIo(postcode) {
        const format = this.validatePostcodeFormat(postcode);
        if (!format.isValid) {
            throw new ValidationError(format.message);
        }

        const spacedPostcode = format.spacedPostcode;

        try {
            const response = await axios.get(
                `https://api.postcodes.io/postcodes/${encodeURIComponent(spacedPostcode)}`,
                { timeout: 8000 }
            );

            if (response.data?.status !== 200 || !response.data?.result) {
                throw new NotFoundError(`Postcode "${spacedPostcode}" not found`);
            }

            const result = response.data.result;

            return {
                isValid: true,
                message: "Postcode verified",
                normalizedPostcode: format.normalizedPostcode,
                spacedPostcode: result.postcode || spacedPostcode,
                latitude: result.latitude ?? null,
                longitude: result.longitude ?? null,
                outcode: result.outcode || null,
                incode: result.incode || null,
                town: result.admin_district || result.parish || null,
                county: result.admin_county || result.region || null,
                country: result.country || null,
                region: result.region || null,
            };
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            if (error.response?.status === 404) {
                throw new NotFoundError(`Postcode "${spacedPostcode}" not found`);
            }
            throw new ValidationError(`Failed to verify postcode: ${error.message}`);
        }
    }

    compactPostcodeQuery(query) {
        return (query || "").trim().replace(/\s+/g, "").toUpperCase();
    }

    /**
     * Does this outcode (e.g. "NW11", "SW1A") exist? Asks postcodes.io (free) and
     * remembers the answer in Redis for OUTCODE_CACHE_TTL_SEC, because outcodes almost
     * never change and a single area lookup can check dozens of them.
     * Network errors are not cached (the next request simply tries again).
     */
    async verifyOutcodeExists(outcode) {
        const key = `${OUTCODE_CACHE_PREFIX}${outcode}`;
        const cached = await this.safeRedisGet(key);
        if (cached === "1" || cached === "0") {
            return cached === "1";
        }
        try {
            const response = await axios.get(
                `https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`,
                { timeout: 3000, validateStatus: (status) => status < 500 }
            );
            const exists = response.status === 200 && response.data?.status === 200;
            await this.safeRedisSetEx(key, OUTCODE_CACHE_TTL_SEC, exists ? "1" : "0");
            return exists;
        } catch {
            return false;
        }
    }

    /**
     * Keep only the candidates that really exist, in their original order.
     * Checked in small batches so a 100-candidate area list doesn't fire
     * 100 parallel requests at postcodes.io (results are cached, see above).
     */
    async resolveExistingOutcodes(candidates, limit = 15) {
        const found = [];
        for (let i = 0; i < candidates.length && found.length < limit; i += OUTCODE_CHECK_BATCH) {
            const batch = candidates.slice(i, i + OUTCODE_CHECK_BATCH);
            const checks = await Promise.all(
                batch.map(async (outcode) =>
                    (await this.verifyOutcodeExists(outcode)) ? outcode : null
                )
            );
            found.push(...checks.filter(Boolean));
        }
        return found.slice(0, limit);
    }

    buildOutcodeCandidates(compact) {
        const areaMatch = compact.match(/^([A-Z]{1,2})(\d*)$/);
        if (!areaMatch) {
            return [];
        }

        const [, area, digits] = areaMatch;
        const candidates = [];

        if (!digits) {
            // Districts run from 0 (e.g. HA0, CM0) up to 99 (e.g. B99, DN40).
            // Unverified guesses used to include ones that don't exist (NW12) and
            // miss real ones (HA0, N22); callers now verify with resolveExistingOutcodes.
            for (let d = 0; d <= 99; d += 1) {
                candidates.push(`${area}${d}`);
            }
            return candidates;
        }

        for (const letter of OUTCODE_LETTERS) {
            candidates.push(`${area}${digits}${letter}`);
        }

        return candidates;
    }

    rankPostcodeSuggestions(compact, suggestions) {
        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            return [];
        }

        const exact = [];
        const prefix = [];
        const rest = [];

        for (const suggestion of suggestions) {
            const normalized = this.compactPostcodeQuery(suggestion);
            if (normalized === compact) {
                exact.push(suggestion);
            } else if (normalized.startsWith(compact)) {
                prefix.push(suggestion);
            } else {
                rest.push(suggestion);
            }
        }

        prefix.sort(
            (a, b) =>
                this.compactPostcodeQuery(a).length - this.compactPostcodeQuery(b).length
        );

        const ranked = [...exact, ...prefix, ...rest];
        const seen = new Set();

        return ranked.filter((suggestion) => {
            const key = this.compactPostcodeQuery(suggestion);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    rankOutcodeSuggestions(compact, suggestions) {
        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            return [];
        }

        const exact = [];
        const prefix = [];
        const rest = [];

        for (const suggestion of suggestions) {
            const normalized = this.compactPostcodeQuery(suggestion);
            if (normalized === compact) {
                exact.push(suggestion);
            } else if (normalized.startsWith(compact)) {
                prefix.push(suggestion);
            } else {
                rest.push(suggestion);
            }
        }

        return [...exact, ...prefix, ...rest];
    }

    async fetchFullPostcodeAutocomplete(compact, limit = 20) {
        const response = await axios.get(
            `https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}/autocomplete`,
            {
                params: { limit },
                timeout: 8000,
                validateStatus: (status) => status < 500,
            }
        );

        if (response.status === 404) {
            return [];
        }

        if (response.status !== 200) {
            throw new ValidationError("Failed to autocomplete postcode");
        }

        return Array.isArray(response.data?.result) ? response.data.result : [];
    }

    /**
     * Postcode suggestions while the customer types (free, postcodes.io).
     * Results are cached in Redis per query (AUTOCOMPLETE_CACHE_TTL_SEC) so repeated
     * keystrokes from everyone are answered without calling postcodes.io again.
     * Empty results are cached for a shorter time in case it was a temporary gap.
     */
    async autocompletePostcode(query) {
        const compact = this.compactPostcodeQuery(query);
        if (compact.length < 2) {
            return { suggestions: [], suggestionType: "postcode" };
        }

        const cacheKey = `${AUTOCOMPLETE_CACHE_PREFIX}${compact}`;
        const cached = await this.safeRedisGet(cacheKey);
        if (cached) {
            try {
                return JSON.parse(cached);
            } catch {
                // corrupt entry: fall through and rebuild it
            }
        }

        const result = await this.autocompletePostcodeUncached(compact);
        await this.safeRedisSetEx(
            cacheKey,
            result.suggestions.length ? AUTOCOMPLETE_CACHE_TTL_SEC : AUTOCOMPLETE_EMPTY_CACHE_TTL_SEC,
            JSON.stringify(result)
        );
        return result;
    }

    async autocompletePostcodeUncached(compact) {
        try {
            // Full postcode e.g. SW1A1AA or partial incode e.g. SW1A1
            if (POSTCODE_REGEX.test(compact) || /^[A-Z]{1,2}\d{1,2}[A-Z]\d/.test(compact)) {
                const raw = await this.fetchFullPostcodeAutocomplete(compact);
                const suggestions = this.rankPostcodeSuggestions(compact, raw);
                return { suggestions, suggestionType: "postcode" };
            }

            // Complete outcode with letter e.g. SW1A -> show full postcodes
            if (/^[A-Z]{1,2}\d{1,2}[A-Z]$/.test(compact)) {
                const raw = await this.fetchFullPostcodeAutocomplete(compact);
                const suggestions = this.rankPostcodeSuggestions(compact, raw);
                return { suggestions, suggestionType: "postcode" };
            }

            // Area only e.g. SW -> postcode districts (SW1, SW2); not valid outcodes on their own.
            // Only districts that really exist are offered (checked + cached, see verifyOutcodeExists).
            if (/^[A-Z]{1,2}$/.test(compact)) {
                const raw = await this.resolveExistingOutcodes(this.buildOutcodeCandidates(compact), 30);
                const suggestions = this.rankOutcodeSuggestions(compact, raw);
                return { suggestions, suggestionType: "outcode" };
            }

            // District with digits e.g. SW1, SW10 -> letter suffix outcodes (SW1A, SW10B)
            if (/^[A-Z]{1,2}\d{1,2}$/.test(compact)) {
                const candidates = this.buildOutcodeCandidates(compact);
                const raw = await this.resolveExistingOutcodes(candidates, 15);
                const suggestions = this.rankOutcodeSuggestions(compact, raw);
                if (suggestions.length) {
                    return { suggestions, suggestionType: "outcode" };
                }
                // Most districts (HA0, NW11, E16) have no lettered sub-districts:
                // offer the district's full postcodes instead of an empty list.
                const full = await this.fetchFullPostcodeAutocomplete(compact);
                return {
                    suggestions: this.rankPostcodeSuggestions(compact, full),
                    suggestionType: "postcode",
                };
            }

            const raw = await this.fetchFullPostcodeAutocomplete(compact);
            const suggestions = this.rankPostcodeSuggestions(compact, raw);
            return { suggestions, suggestionType: "postcode" };
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            if (error.response?.status === 404) {
                return { suggestions: [], suggestionType: "postcode" };
            }
            throw new ValidationError(`Failed to autocomplete postcode: ${error.message}`);
        }
    }

    formatIdealAddress(addr, index, fallbackPostcode) {
        const line1 = addr.line_1 || "";
        const line2 = addr.line_2 || "";
        const town = addr.post_town || "";
        const county = addr.county || addr.postal_county || addr.traditional_county || "";
        const postcode = this.normalizePostcode(addr.postcode || fallbackPostcode || "");
        const fullAddress = [line1, line2, town, county, this.formatSpacedPostcode(postcode)]
            .filter(Boolean)
            .join(", ");

        return {
            id: index,
            suggestionId: String(addr.udprn ?? index),
            udprn: addr.udprn ?? null,
            line1,
            line2,
            line3: addr.line_3 || "",
            locality: addr.dependant_locality || addr.double_dependant_locality || line2,
            town,
            county,
            postcode,
            fullAddress,
            latitude: addr.latitude ?? null,
            longitude: addr.longitude ?? null,
        };
    }

    async fetchAddressesFromIdeal(spacedPostcode) {
        const apiKey = process.env.IDEAL_POSTCODES_API_KEY;
        if (!apiKey) {
            throw new ValidationError("Ideal Postcodes API key is not configured");
        }

        const normalizedPostcode = this.normalizePostcode(spacedPostcode);
        const allAddresses = [];
        let page = 0;
        let total = null;

        while (page < 20) {
            const response = await axios.get(
                `https://api.ideal-postcodes.co.uk/v1/postcodes/${encodeURIComponent(spacedPostcode)}`,
                {
                    params: {
                        api_key: apiKey,
                        page,
                    },
                    timeout: 15000,
                    validateStatus: (status) => status < 500,
                }
            );

            if (response.status === 404) {
                throw new NotFoundError(`Postcode "${spacedPostcode}" not found`);
            }

            if (response.status === 401 || response.status === 403) {
                throw new ValidationError("Invalid Ideal Postcodes API key");
            }

            if (response.status === 429) {
                throw new TooManyRequestsError(
                    "Address lookup service is busy. Please try again shortly.",
                    { retryAfterSeconds: 60 }
                );
            }

            if (response.status !== 200) {
                throw new ValidationError(
                    `Ideal Postcodes error (${response.status}): ${response.data?.message || "Unexpected response"}`
                );
            }

            const batch = Array.isArray(response.data?.result) ? response.data.result : [];
            if (typeof response.data?.total === "number") {
                total = response.data.total;
            }

            batch.forEach((addr, idx) => {
                allAddresses.push(
                    this.formatIdealAddress(addr, allAddresses.length + idx, normalizedPostcode)
                );
            });

            const limit = response.data?.limit || 100;
            const fetchedAll =
                total != null
                    ? allAddresses.length >= total
                    : batch.length < limit;

            if (fetchedAll || batch.length === 0) {
                break;
            }

            page += 1;
        }

        if (allAddresses.length === 0) {
            throw new NotFoundError("No addresses found for this postcode");
        }

        return allAddresses;
    }

    async getCachedAddresses(normalizedPostcode) {
        const raw = await this.safeRedisGet(`${CACHE_PREFIX}${normalizedPostcode}`);
        if (!raw) {
            return null;
        }

        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    async setCachedAddresses(normalizedPostcode, payload) {
        await this.safeRedisSetEx(
            `${CACHE_PREFIX}${normalizedPostcode}`,
            CACHE_TTL_SEC,
            JSON.stringify(payload)
        );
    }

    /**
     * Hybrid lookup: postcodes.io verify (free) + Ideal Postcodes addresses (paid) + Redis cache.
     */
    async getAddressesByPostcode(postcode, actorId = null) {
        const format = this.validatePostcodeFormat(postcode);
        if (!format.isValid) {
            throw new ValidationError(format.message);
        }

        const normalizedPostcode = format.normalizedPostcode;
        const cached = await this.getCachedAddresses(normalizedPostcode);
        if (cached) {
            return { ...cached, fromCache: true };
        }

        await this.assertAddressSearchCooldown(actorId);

        const verified = await this.verifyPostcodeWithPostcodesIo(normalizedPostcode);
        const addresses = await this.fetchAddressesFromIdeal(verified.spacedPostcode);

        const latitude =
            verified.latitude ??
            addresses.find((a) => a.latitude != null)?.latitude ??
            null;
        const longitude =
            verified.longitude ??
            addresses.find((a) => a.longitude != null)?.longitude ??
            null;

        const payload = {
            postcode: normalizedPostcode,
            spacedPostcode: verified.spacedPostcode,
            addressCount: addresses.length,
            addresses: addresses.map((addr) => ({
                ...addr,
                latitude: addr.latitude ?? latitude,
                longitude: addr.longitude ?? longitude,
            })),
            latitude,
            longitude,
            town: verified.town,
            county: verified.county,
            fromCache: false,
        };

        await this.setCachedAddresses(normalizedPostcode, payload);
        await this.setAddressSearchCooldown(actorId);

        return payload;
    }

    async getAddressById(postcode, addressIndex, actorId = null) {
        const result = await this.getAddressesByPostcode(postcode, actorId);
        const index = parseInt(addressIndex, 10);

        if (Number.isNaN(index)) {
            throw new ValidationError("Invalid address index");
        }

        if (index >= 0 && index < result.addresses.length) {
            return {
                ...result.addresses[index],
                latitude: result.addresses[index].latitude ?? result.latitude,
                longitude: result.addresses[index].longitude ?? result.longitude,
            };
        }

        throw new NotFoundError("Address not found at specified index");
    }
}

module.exports = new CustomerPostcodeService();
