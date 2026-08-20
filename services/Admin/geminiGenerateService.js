"use strict";

const axios = require("axios");
const {
  UniversalHttpError,
  ValidationError,
  StatusCodes,
} = require("../../middlewares/universalErrorHandler");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PROMPT_MAX_LEN = 8000;

function pickEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function getGeminiApiKey() {
  return pickEnv(
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_API_KEY",
    "LAUNDRY_GEMINI_API_KEY"
  );
}

function getGeminiModel() {
  const named = pickEnv("GEMINI_MODEL", "LAUNDRY_GEMINI_MODEL");
  return (named || "gemini-2.0-flash").replace(/^models\//, "");
}

function geminiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

async function listGenerateContentModel(apiKey) {
  const { data } = await axios.get(`${GEMINI_BASE}/models`, {
    headers: geminiHeaders(apiKey),
    timeout: 15000,
  });
  const models = data?.models || [];
  const supported = models.find((m) => {
    const methods = m.supportedGenerationMethods || m.supported_actions || [];
    return methods.some(
      (s) => s && String(s).toLowerCase().replace(/_/g, "") === "generatecontent"
    );
  });
  if (!supported?.name) {
    throw new UniversalHttpError(
      "No Gemini model with generateContent is available for the configured server key.",
      StatusCodes.SERVICE_UNAVAILABLE
    );
  }
  return String(supported.name).replace(/^models\//, "");
}

/**
 * Generate text via Gemini. Key stays on the server (header, never a query string).
 */
async function generateContent(prompt) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new UniversalHttpError(
      "Gemini is not configured on the server. Set GEMINI_API_KEY (or LAUNDRY_GEMINI_API_KEY) on the API host.",
      StatusCodes.SERVICE_UNAVAILABLE
    );
  }

  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    throw new ValidationError("Prompt is required");
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new ValidationError("Prompt is too long");
  }

  const body = {
    contents: [{ parts: [{ text: trimmed }] }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
  };

  const attempt = (modelName) =>
    axios.post(
      `${GEMINI_BASE}/models/${encodeURIComponent(modelName)}:generateContent`,
      body,
      {
        headers: geminiHeaders(apiKey),
        timeout: 30000,
      }
    );

  let model = getGeminiModel();
  let data;
  try {
    ({ data } = await attempt(model));
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 400) {
      model = await listGenerateContentModel(apiKey);
      ({ data } = await attempt(model));
    } else if (status === 429) {
      throw new UniversalHttpError(
        "Gemini rate limit exceeded. Try again shortly.",
        StatusCodes.TOO_MANY_REQUESTS
      );
    } else {
      throw new UniversalHttpError(
        "Gemini request failed",
        status && status >= 400 && status < 600 ? status : 502
      );
    }
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new UniversalHttpError("Gemini returned no text", 502);
  }
  return { text: String(text).trim(), model };
}

module.exports = {
  getGeminiApiKey,
  generateContent,
};
