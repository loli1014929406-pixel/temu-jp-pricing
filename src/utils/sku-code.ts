export function buildDefaultSkuCode(productCode: string, index: number) {
  const normalizedProductCode = productCode.trim();
  return normalizedProductCode ? `${normalizedProductCode}-${index + 1}` : `SKU${index + 1}`;
}

export function isLegacyDefaultSkuCode(skuCode: string) {
  const normalizedSkuCode = skuCode.trim();
  return !normalizedSkuCode || /^SKU\d+$/i.test(normalizedSkuCode);
}
