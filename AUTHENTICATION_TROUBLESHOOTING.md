# Authentication Troubleshooting (Admin APIs)

This note explains the authentication issue we saw in Postman and how it was fixed.

## Symptoms
- Admin requests were created but did not include auth headers, URLs, or bodies.
- Calling the endpoints returned auth errors because the token was not sent.

## Root Cause
The initial Postman requests existed only as placeholders (method + name). They were missing:
- The correct endpoint URL (`/admin/...`)
- The request body for create/update endpoints
- The authentication header

Without the auth header, `validateAccessToken` rejects the request.

## Fix Applied
We replaced the placeholder requests with fully configured ones that include:
- Header: `accessToken: {{token}}`
- Correct URL paths (based on `routes/admin.js`)
- JSON bodies for FAQ create/update
- `form-data` bodies for Blog create/update (including the `image` file field)

## How to Use
1. Call the Admin login endpoint and copy the token from the response.
2. Set the Postman collection variable `token` to that value.
3. Use the Admin requests (FAQ/Blog) with the `accessToken` header.

## Notes
- If your backend expects a different header (e.g. `Authorization: Bearer <token>`),
  update the request headers accordingly.
- If you switch environments, update the base URL variable (e.g. `newUrl`).

