import { BITREFILL_PERSONAL_ADAPTER_ID } from "../../domain/economy/provenance.js";

export { BITREFILL_PERSONAL_ADAPTER_ID };

export const BITREFILL_PROVIDER_ID = "bitrefill";

export const BITREFILL_PRODUCTION_ORIGIN = "https://api.bitrefill.com";
export const BITREFILL_API_BASE_PATH = "/v2";
export const BITREFILL_API_BASE_URL = `${BITREFILL_PRODUCTION_ORIGIN}${BITREFILL_API_BASE_PATH}`;

export const BITREFILL_LIGHTNING_PAYMENT_METHOD = "lightning";

export const BITREFILL_ALLOWED_ROUTES = {
  ping: "/ping",
  searchProducts: "/products/search",
  getProduct: "/products/{id}",
  createInvoice: "/invoices",
  getInvoice: "/invoices/{id}",
  getOrder: "/orders/{id}",
} as const;

export type BitrefillAllowedRoute =
  (typeof BITREFILL_ALLOWED_ROUTES)[keyof typeof BITREFILL_ALLOWED_ROUTES];
