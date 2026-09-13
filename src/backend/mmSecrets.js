/*
=============================================================================
MODULE: backend/mmSecrets.js
VERSION: v5007.0-FINAL (CORREGIDO C1)
BASE: BIBLIA v5002.5 Bloque 8 — 17 secretos completos
=============================================================================
*/

export const SECRETS = Object.freeze({
  // Criptografia Fiscal (Veri*factu)
  FISCAL_KEY: "SECRETFISCALKEY",
  FISCAL_NIF_EMISOR: "FISCAL_NIF_EMISOR",

  // Autenticacion y Sesiones
  AUTH_JWT_KEY: "SECRET_AUTH_JWT_KEY",

  // Roles y Acceso
  ADMIN_EMAILS: "ADMIN_EMAILS",
  CAJERO_EMAILS: "CAJERO_EMAILS",

  // Integraciones Externas
  POWER_AUTOMATE: "POWER_AUTOMATE_TOKEN",

  // Email
  SENDGRID_API_KEY: "SENDGRID_API_KEY",
  SENDGRID_FROM_EMAIL: "SENDGRID_FROM_EMAIL",
  RESEND_API_KEY: "RESEND_API_KEY",
  RESEND_FROM_EMAIL: "RESEND_FROM_EMAIL",

  // Asistente IA
  MARIAN_ASSISTANT_OPENAI_KEY: "MARIAN_ASSISTANT_OPENAI_KEY",

  // M365 Graph
  M365_GRAPH_CLIENT_ID: "M365_CLIENT_ID",
  M365_GRAPH_CLIENT_SECRET: "M365_CLIENT_SECRET",
  M365_GRAPH_TENANT_ID: "M365_TENANT_ID",
  M365_GRAPH_SITE_ID: "M365_SITE_ID",
  M365_GRAPH_LIST_ID: "M365_LIST_ID",

  // Webhooks
  M365_WEBHOOK_HMAC_KEY: "SECRET_M365_WEBHOOK_HMAC_KEY",
});

export default SECRETS;