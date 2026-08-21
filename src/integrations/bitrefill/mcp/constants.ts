import { BITREFILL_MCP_PREPAYMENT_ADAPTER_ID } from "../../../domain/economy/provenance.js";

export { BITREFILL_MCP_PREPAYMENT_ADAPTER_ID };

export const BITREFILL_MCP_PRODUCTION_ORIGIN = "https://api.bitrefill.com";
export const BITREFILL_MCP_PATH = "/mcp";
export const BITREFILL_MCP_CLIENT_NAME = "satscout-bitrefill-prepayment";
export const BITREFILL_MCP_CLIENT_VERSION = "0.1.0";

export const BITREFILL_MCP_ALLOWED_TOOLS = ["get-product-details", "submit-prepayment-step"] as const;
export type BitrefillMcpAllowedTool = (typeof BITREFILL_MCP_ALLOWED_TOOLS)[number];

export const BITREFILL_MCP_FORBIDDEN_TOOLS = [
  "buy-products",
  "search-products",
  "list-invoices",
  "get-invoice-by-id",
  "update-order",
] as const;
export type BitrefillMcpForbiddenTool = (typeof BITREFILL_MCP_FORBIDDEN_TOOLS)[number];

export const BITREFILL_MCP_MAX_PREPAYMENT_STEPS = 5;
export const BITREFILL_MCP_FIRST_STEP = 1;

export const SUPPORTED_PREPAYMENT_PROFILE_FIELDS = ["first_name", "last_name"] as const;
export type SupportedPrepaymentProfileField = (typeof SUPPORTED_PREPAYMENT_PROFILE_FIELDS)[number];

export const SUPPORTED_PREPAYMENT_ECONOMIC_FIELDS = [
  "value",
  "amount",
  "package_value",
  "face_value",
] as const;
export type SupportedPrepaymentEconomicField = (typeof SUPPORTED_PREPAYMENT_ECONOMIC_FIELDS)[number];

export const SUPPORTED_PREPAYMENT_FIRST_FORM_AMOUNT_FIELD = "bill_amount" as const;
export type SupportedPrepaymentFirstFormAmountField = typeof SUPPORTED_PREPAYMENT_FIRST_FORM_AMOUNT_FIELD;

export const FIRST_FORM_FIELD_KEYS = ["id", "label", "type", "required", "max_length"] as const;
