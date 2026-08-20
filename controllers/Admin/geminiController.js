"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const geminiGenerateService = require("../../services/Admin/geminiGenerateService");

/**
 * POST /admin/gemini/generate
 * Body: { prompt }
 */
async function generate(req, res) {
  const data = await geminiGenerateService.generateContent(req.body?.prompt);
  return ResponseHelper.success(res, "Generated", data);
}

module.exports = {
  generate,
};
