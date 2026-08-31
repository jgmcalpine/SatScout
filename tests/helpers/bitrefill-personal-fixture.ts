import { readFileSync } from "node:fs";

export interface PersonalUnpaidInvoiceFixture {
  readonly data: {
    id: string;
    status: string;
    payment: {
      method: string;
      status: string;
      address: string;
    };
    orders: Array<{
      id: string;
      status: string;
      product: {
        id?: string;
        value?: string;
      };
    }>;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/bitrefill-personal-not-delivered-unpaid.json", import.meta.url),
    "utf8",
  ),
) as PersonalUnpaidInvoiceFixture;

export function personalUnpaidInvoiceFixture(): PersonalUnpaidInvoiceFixture {
  return structuredClone(fixture);
}
