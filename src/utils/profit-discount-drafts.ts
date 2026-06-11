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

export function getProfitCalculationsDraftKey(userId: string) {
  return `profit-calculations-draft:v1:${userId}`;
}

export function readProductDiscountDraft(userId: string, productId: string) {
  return (
    readDraft<ProfitCalculationsDraft>(
      getProfitCalculationsDraftKey(userId),
    )?.discountsByProductId[productId] ?? null
  );
}

export function writeProductDiscountDraft(
  userId: string,
  productId: string,
  discounts: ProfitDiscountFields,
) {
  const draftKey = getProfitCalculationsDraftKey(userId);
  const current = readDraft<ProfitCalculationsDraft>(draftKey);

  writeDraft<ProfitCalculationsDraft>(draftKey, {
    discountsByProductId: {
      ...(current?.discountsByProductId ?? {}),
      [productId]: discounts,
    },
  });
}
