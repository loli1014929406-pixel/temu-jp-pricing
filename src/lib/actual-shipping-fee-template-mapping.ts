import type {
  ActualShippingFeeImportTemplateInput,
  ActualShippingFeeMappingSource,
} from "./actual-shipping-fee-templates";

export type ActualShippingFeeWebsiteField =
  | "tracking"
  | "amount"
  | "logistics_method";

export type ActualShippingFeeFieldMapping = {
  sourceType: ActualShippingFeeMappingSource;
  column: number | null;
  fixedValue: string | number | null;
};

export function getActualShippingFeeFieldMapping(
  draft: ActualShippingFeeImportTemplateInput,
  field: ActualShippingFeeWebsiteField,
): ActualShippingFeeFieldMapping {
  if (field === "tracking") {
    return {
      sourceType: draft.tracking_source_type,
      column: draft.tracking_column,
      fixedValue: draft.tracking_fixed_value,
    };
  }
  if (field === "amount") {
    return {
      sourceType: draft.amount_source_type,
      column: draft.amount_column,
      fixedValue: draft.amount_fixed_value,
    };
  }
  return {
    sourceType: draft.logistics_method_source_type,
    column: draft.logistics_method_column,
    fixedValue: draft.logistics_method_fixed_id,
  };
}

export function bindActualShippingFeeColumn(
  draft: ActualShippingFeeImportTemplateInput,
  field: ActualShippingFeeWebsiteField,
  column: number,
): ActualShippingFeeImportTemplateInput {
  const normalizedColumn = Math.max(1, Math.trunc(column));
  if (field === "tracking") {
    return {
      ...draft,
      tracking_source_type: "column",
      tracking_column: normalizedColumn,
      tracking_fixed_value: "",
    };
  }
  if (field === "amount") {
    return {
      ...draft,
      amount_source_type: "column",
      amount_column: normalizedColumn,
      amount_fixed_value: null,
    };
  }
  return {
    ...draft,
    logistics_method_source_type: "column",
    logistics_method_column: normalizedColumn,
    logistics_method_fixed_id: null,
  };
}

export function setActualShippingFeeFixedMapping(
  draft: ActualShippingFeeImportTemplateInput,
  field: ActualShippingFeeWebsiteField,
): ActualShippingFeeImportTemplateInput {
  if (field === "tracking") {
    return {
      ...draft,
      tracking_source_type: "fixed",
      tracking_column: null,
    };
  }
  if (field === "amount") {
    return {
      ...draft,
      amount_source_type: "fixed",
      amount_column: null,
    };
  }
  return {
    ...draft,
    logistics_method_source_type: "fixed",
    logistics_method_column: null,
  };
}

export function clearActualShippingFeeFieldMapping(
  draft: ActualShippingFeeImportTemplateInput,
  field: ActualShippingFeeWebsiteField,
): ActualShippingFeeImportTemplateInput {
  if (field === "tracking") {
    return {
      ...draft,
      tracking_source_type: "column",
      tracking_column: null,
      tracking_fixed_value: "",
    };
  }
  if (field === "amount") {
    return {
      ...draft,
      amount_source_type: "column",
      amount_column: null,
      amount_fixed_value: null,
    };
  }
  return {
    ...draft,
    logistics_method_source_type: "column",
    logistics_method_column: null,
    logistics_method_fixed_id: null,
  };
}

export function clearAllActualShippingFeeFieldMappings(
  draft: ActualShippingFeeImportTemplateInput,
): ActualShippingFeeImportTemplateInput {
  return (
    ["tracking", "amount", "logistics_method"] as ActualShippingFeeWebsiteField[]
  ).reduce(clearActualShippingFeeFieldMapping, draft);
}
