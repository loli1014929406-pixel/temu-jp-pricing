import { readDraft, writeDraft } from "../hooks/use-draft-persistence";
import type { ProfitCalculationInput } from "../types";

export type ProfitDiscountFields = Required<
  Pick<
    ProfitCalculationInput,
    "trafficDiscountRate" | "activityDiscountRate" | "couponDiscountRate" | "adRoas"
  >
>;

export type ProfitCalculationsDraft = {
  discountsByProductId: Record<string, ProfitDiscountFields>;
};

export function getProfitCalculationsDraftKey(storageScopeKey: string) {
  return `profit-calculations-draft:v2:${storageScopeKey}`;
}

export function readProductDiscountDraft(storageScopeKey: string, productId: string) {
  return (
    readDraft<ProfitCalculationsDraft>(
      getProfitCalculationsDraftKey(storageScopeKey),
    )?.discountsByProductId[productId] ?? null
  );
}

export function writeProductDiscountDraft(
  storageScopeKey: string,
  productId: string,
  discounts: ProfitDiscountFields,
) {
  const draftKey = getProfitCalculationsDraftKey(storageScopeKey);
  const current = readDraft<ProfitCalculationsDraft>(draftKey);

  writeDraft<ProfitCalculationsDraft>(draftKey, {
    discountsByProductId: {
      ...(current?.discountsByProductId ?? {}),
      [productId]: discounts,
    },
  });
}
