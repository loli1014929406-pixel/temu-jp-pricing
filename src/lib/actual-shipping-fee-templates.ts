import { requireSession, withTimeout } from "./supabase-helpers";
import { fetchLogisticsMethods } from "./logistics-methods";

export type ActualShippingFeeMappingSource = "column" | "fixed";

export type ActualShippingFeeImportTemplate = {
  id: string;
  user_id: string;
  name: string;
  worksheet_name: string;
  start_row: number;
  tracking_source_type: ActualShippingFeeMappingSource;
  tracking_column: number | null;
  tracking_fixed_value: string;
  amount_source_type: ActualShippingFeeMappingSource;
  amount_column: number | null;
  amount_fixed_value: number | null;
  logistics_method_source_type: ActualShippingFeeMappingSource;
  logistics_method_column: number | null;
  logistics_method_fixed_id: string | null;
  is_system: boolean;
  system_key: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ActualShippingFeeImportTemplateInput = Omit<
  ActualShippingFeeImportTemplate,
  | "id"
  | "user_id"
  | "is_system"
  | "system_key"
  | "deleted_at"
  | "created_at"
  | "updated_at"
>;

export type ActualShippingFeeTemplateDeleteMode = "soft" | "hard";

export function getActualShippingFeeTemplateDeleteMode(
  template: Pick<ActualShippingFeeImportTemplate, "is_system">,
): ActualShippingFeeTemplateDeleteMode {
  return template.is_system ? "soft" : "hard";
}

const templateSelect = [
  "id",
  "user_id",
  "name",
  "worksheet_name",
  "start_row",
  "tracking_source_type",
  "tracking_column",
  "tracking_fixed_value",
  "amount_source_type",
  "amount_column",
  "amount_fixed_value",
  "logistics_method_source_type",
  "logistics_method_column",
  "logistics_method_fixed_id",
  "is_system",
  "system_key",
  "deleted_at",
  "created_at",
  "updated_at",
].join(", ");

export async function ensureDefaultActualShippingFeeTemplates() {
  const { supabase } = await requireSession();
  const { error } = await withTimeout(
    supabase.rpc("ensure_actual_shipping_fee_default_templates"),
    "初始化实际运费默认模板",
    { requestKind: "rpc" },
  );
  if (error && !["42883", "PGRST202"].includes(error.code ?? "")) throw error;
}

export async function fetchActualShippingFeeTemplates() {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("finance_actual_shipping_fee_import_templates")
      .select(templateSelect)
      .is("deleted_at", null)
      .order("is_system", { ascending: false })
      .order("updated_at", { ascending: false }),
    "加载实际运费导入模板",
  );
  if (error) {
    if (["42P01", "PGRST205"].includes(error.code ?? "")) {
      throw new Error("实际运费模板数据库尚未初始化，请先执行最新 Supabase migration。");
    }
    throw error;
  }
  return (data ?? []) as unknown as ActualShippingFeeImportTemplate[];
}

export async function fetchAvailableActualShippingFeeLogisticsMethods() {
  const [{ supabase }, methods] = await Promise.all([
    requireSession(),
    fetchLogisticsMethods(),
  ]);
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_logistics_methods")
      .select("logistics_method_id"),
    "加载仓库物流方式关联",
  );
  if (error) throw error;
  const linkedIds = new Set(
    (data ?? []).map((row) => String(row.logistics_method_id ?? "")).filter(Boolean),
  );
  return methods.filter((method) => method.is_active && linkedIds.has(method.id));
}

export async function saveActualShippingFeeTemplate(
  input: ActualShippingFeeImportTemplateInput,
  templateId?: string,
) {
  const { supabase, session } = await requireSession();
  const payload = {
    ...input,
    name: input.name.trim(),
    worksheet_name: input.worksheet_name.trim(),
    tracking_fixed_value: input.tracking_fixed_value.trim(),
  };
  const query = templateId
    ? supabase
        .from("finance_actual_shipping_fee_import_templates")
        .update(payload)
        .eq("id", templateId)
    : supabase
        .from("finance_actual_shipping_fee_import_templates")
        .insert({ ...payload, user_id: session.user.id });
  const { data, error } = await withTimeout(
    query.select(templateSelect).single(),
    templateId ? "更新实际运费导入模板" : "新增实际运费导入模板",
  );
  if (error) throw error;
  return data as unknown as ActualShippingFeeImportTemplate;
}

export async function deleteActualShippingFeeTemplate(
  template: Pick<ActualShippingFeeImportTemplate, "id" | "is_system">,
) {
  const { supabase } = await requireSession();
  const query = getActualShippingFeeTemplateDeleteMode(template) === "soft"
    ? supabase
        .from("finance_actual_shipping_fee_import_templates")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", template.id)
    : supabase
        .from("finance_actual_shipping_fee_import_templates")
        .delete()
        .eq("id", template.id);
  const { error } = await withTimeout(
    query,
    "删除实际运费导入模板",
  );
  if (error) throw error;
}
