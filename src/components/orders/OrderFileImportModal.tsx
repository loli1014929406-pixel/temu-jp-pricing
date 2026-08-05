import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  Download,
  Eraser,
  FileSpreadsheet,
  Link2,
  Pencil,
  Plus,
  Trash2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { columnNumberToLabel } from "../../lib/actual-shipping-fee-parser";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notifications";
import {
  parseOrderFileImportWorkbook,
  readOrderFileImportWorkbook,
  resolveOrderFileTemplateMappings,
  type ParsedOrderFileImport,
} from "../../lib/order-file-import-parser";
import {
  createEmptyOrderFileTemplate,
  deleteOrderFileImportTemplate,
  ensureDefaultOrderFileImportTemplates,
  fetchOrderFileImportTemplates,
  getOrderFileImportFieldMeta,
  saveOrderFileImportTemplate,
  type OrderFileFieldMapping,
  type OrderFileImportField,
  type OrderFileImportKind,
  type OrderFileImportTemplate,
  type OrderFileImportTemplateInput,
} from "../../lib/order-file-import-templates";
import type { Workbook } from "../../lib/tabular-parser";
import { confirmAction } from "../../utils/confirmations";
import { getErrorMessage } from "../../utils/errors";

export type PreparedOrderFileImport =
  | {
      kind: "orders" | "tracking";
      fileName: string;
      template: OrderFileImportTemplate;
      parsed: ParsedOrderFileImport;
    }
  | {
      kind: "temu_upload";
      fileName: string;
      template: OrderFileImportTemplate;
      workbook: Workbook;
    }
  | {
      kind: "shipping_export";
      fileName: string;
      template: OrderFileImportTemplate;
      workbook: Workbook;
    };

type Props = {
  kind: OrderFileImportKind;
  canEdit: boolean;
  onClose: () => void;
  onPrepared: (prepared: PreparedOrderFileImport) => void;
};

type TemplateEditor = {
  templateId: string | null;
  draft: OrderFileImportTemplateInput;
};

function templateToDraft(
  template: OrderFileImportTemplate,
): OrderFileImportTemplateInput {
  return {
    import_type: template.import_type,
    name: template.name,
    worksheet_name: template.worksheet_name,
    start_row: template.start_row,
    field_mappings: Object.fromEntries(
      Object.entries(template.field_mappings).map(([key, mapping]) => [
        key,
        {
          ...mapping,
          headerAliases: [...mapping.headerAliases],
        },
      ]),
    ),
  };
}

function draftToTemplate(
  draft: OrderFileImportTemplateInput,
  current?: OrderFileImportTemplate | null,
): OrderFileImportTemplate {
  return {
    id: current?.id ?? "",
    user_id: current?.user_id ?? "",
    import_type: draft.import_type,
    name: draft.name,
    worksheet_name: draft.worksheet_name,
    start_row: draft.start_row,
    field_mappings: draft.field_mappings,
    is_system: current?.is_system ?? false,
    system_key: current?.system_key ?? "",
    deleted_at: null,
    created_at: current?.created_at ?? "",
    updated_at: current?.updated_at ?? "",
  };
}

function getTitle(kind: OrderFileImportKind) {
  if (kind === "orders") return "上传订单表 · 制作映射模板";
  if (kind === "tracking") return "上传物流单号 · 制作映射模板";
  return kind === "temu_upload"
    ? "下载上传表格 · 制作映射模板"
    : "下载发货表格 · 制作映射模板";
}

function getFileLabel(kind: OrderFileImportKind) {
  if (kind === "orders") return "Temu 订单表格";
  if (kind === "tracking") return "物流单号表格";
  return kind === "temu_upload"
    ? "Temu 上传表格模板"
    : "发货表格模板";
}

function isDownloadKind(kind: OrderFileImportKind) {
  return kind === "temu_upload" || kind === "shipping_export";
}

export function OrderFileImportModal({
  kind,
  canEdit,
  onClose,
  onPrepared,
}: Props) {
  const fields = useMemo(() => getOrderFileImportFieldMeta(kind), [kind]);
  const [templates, setTemplates] = useState<OrderFileImportTemplate[]>([]);
  const [editor, setEditor] = useState<TemplateEditor>(() => ({
    templateId: null,
    draft: createEmptyOrderFileTemplate(kind),
  }));
  const [selectedField, setSelectedField] =
    useState<OrderFileImportField>(fields[0]?.key ?? "order_no");
  const [selectedSampleColumn, setSelectedSampleColumn] = useState<number | null>(
    null,
  );
  const [fixedValueField, setFixedValueField] =
    useState<OrderFileImportField | null>(null);
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === editor.templateId) ?? null,
    [editor.templateId, templates],
  );
  const selectedWorksheet = useMemo(() => {
    if (!workbook) return null;
    const requested = editor.draft.worksheet_name.trim();
    return requested
      ? workbook.worksheets.find((worksheet) => worksheet.name === requested) ?? null
      : workbook.worksheets[0] ?? null;
  }, [editor.draft.worksheet_name, workbook]);
  const sampleValues = useMemo(() => {
    if (!selectedWorksheet) return [];
    const row =
      selectedWorksheet.data[Math.max(0, editor.draft.start_row - 1)] ?? [];
    const mappedMaximum = Math.max(
      0,
      ...Object.values(editor.draft.field_mappings).map(
        (mapping) => Math.max(mapping.column ?? 0, ...(mapping.columns ?? [])),
      ),
    );
    const columnCount = Math.max(row.length, mappedMaximum);
    return Array.from({ length: columnCount }, (_, index) => ({
      column: index + 1,
      value: String(row[index] ?? "").trim(),
    }));
  }, [editor.draft.field_mappings, editor.draft.start_row, selectedWorksheet]);
  const resolvedMappings = useMemo(() => {
    if (!selectedWorksheet) return [];
    return resolveOrderFileTemplateMappings(
      selectedWorksheet,
      draftToTemplate(editor.draft, selectedTemplate),
    );
  }, [editor.draft, selectedTemplate, selectedWorksheet]);

  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      setLoading(true);
      try {
        await ensureDefaultOrderFileImportTemplates(kind);
        const nextTemplates = await fetchOrderFileImportTemplates(kind);
        if (cancelled) return;
        setTemplates(nextTemplates);
        const first = nextTemplates[0] ?? null;
        setEditor(
          first
            ? { templateId: first.id, draft: templateToDraft(first) }
            : {
                templateId: null,
                draft: createEmptyOrderFileTemplate(kind),
              },
        );
        setSelectedField(
          getOrderFileImportFieldMeta(kind)[0]?.key ?? "order_no",
        );
      } catch (error) {
        if (!cancelled) {
          notifyError(
            getErrorMessage(error, "加载订单文件导入模板失败"),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  function updateDraft(updates: Partial<OrderFileImportTemplateInput>) {
    setEditor((current) => ({
      ...current,
      draft: { ...current.draft, ...updates },
    }));
  }

  function updateMapping(
    field: OrderFileImportField,
    mapping: OrderFileFieldMapping,
  ) {
    setEditor((current) => ({
      ...current,
      draft: {
        ...current.draft,
        field_mappings: {
          ...current.draft.field_mappings,
          [field]: mapping,
        },
      },
    }));
  }

  function handleTemplateChange(templateId: string) {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setEditor({ templateId: template.id, draft: templateToDraft(template) });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function handleNewTemplate() {
    setEditor({
      templateId: null,
      draft: createEmptyOrderFileTemplate(kind),
    });
    setSelectedField(fields[0]?.key ?? "order_no");
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  async function handleDeleteTemplate() {
    if (!selectedTemplate) return;
    if (
      !(await confirmAction(
        `确认删除${isDownloadKind(kind) ? "下载" : "导入"}模板“${selectedTemplate.name}”吗？`,
      ))
    ) {
      return;
    }
    try {
      await deleteOrderFileImportTemplate(selectedTemplate);
      const nextTemplates = templates.filter(
        (template) => template.id !== selectedTemplate.id,
      );
      setTemplates(nextTemplates);
      const first = nextTemplates[0] ?? null;
      setEditor(
        first
          ? { templateId: first.id, draft: templateToDraft(first) }
          : {
              templateId: null,
              draft: createEmptyOrderFileTemplate(kind),
            },
      );
      notifySuccess(`${isDownloadKind(kind) ? "下载" : "导入"}模板已删除。`);
    } catch (error) {
      notifyError(
        getErrorMessage(
          error,
          `删除${isDownloadKind(kind) ? "下载" : "导入"}模板失败`,
        ),
      );
    }
  }

  async function handleSelectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setReading(true);
    try {
      const nextWorkbook = await readOrderFileImportWorkbook(file);
      setWorkbook(nextWorkbook);
      setFileName(file.name);
      setSelectedSampleColumn(null);
      notifySuccess(`已读取表格“${file.name}”，可直接按所选模板核对。`);
    } catch (error) {
      notifyError(getErrorMessage(error, "解析上传表格失败"));
    } finally {
      setReading(false);
    }
  }

  function validateDraft() {
    if (!editor.draft.name.trim()) return "请填写模板名称";
    if (editor.draft.start_row < 1) return "数据开始行必须大于 0";
    const missing = fields.find((field) => {
      if (!field.required) return false;
      const mapping = editor.draft.field_mappings[field.key];
      if (!mapping) return true;
      if (mapping.sourceType === "fixed") {
        return isDownloadKind(kind)
          ? !mapping.column || mapping.column < 1 || !mapping.fixedValue.trim()
          : !mapping.fixedValue.trim();
      }
      if (mapping.sourceType === "header") {
        return mapping.headerAliases.length === 0;
      }
      return !(mapping.columns?.length || mapping.column);
    });
    return missing
      ? `请为必填字段“${missing.label}”绑定表格列或设置固定值`
      : "";
  }

  async function saveCurrentTemplate(showSuccess: boolean) {
    const validationError = validateDraft();
    if (validationError) {
      notifyWarning(validationError);
      return null;
    }
    setSaving(true);
    try {
      const saved = await saveOrderFileImportTemplate(
        editor.draft,
        editor.templateId ?? undefined,
      );
      const nextTemplates = editor.templateId
        ? templates.map((template) =>
            template.id === saved.id ? saved : template,
          )
        : [saved, ...templates];
      setTemplates(nextTemplates);
      setEditor({ templateId: saved.id, draft: templateToDraft(saved) });
      if (showSuccess) {
        notifySuccess(
          editor.templateId
            ? `${isDownloadKind(kind) ? "下载" : "导入"}模板已更新。`
            : `${isDownloadKind(kind) ? "下载" : "导入"}模板已创建。`,
        );
      }
      return saved;
    } catch (error) {
      notifyError(
        getErrorMessage(
          error,
          `保存${isDownloadKind(kind) ? "下载" : "导入"}模板失败`,
        ),
      );
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handlePrepareImport() {
    if (!workbook || !fileName) {
      notifyWarning("请先选择需要上传的 CSV、XLS 或 XLSX 文件");
      return;
    }
    const validationError = validateDraft();
    if (validationError) {
      notifyWarning(validationError);
      return;
    }
    const templateIsDirty =
      !selectedTemplate ||
      JSON.stringify(templateToDraft(selectedTemplate)) !==
        JSON.stringify(editor.draft);
    const template = templateIsDirty
      ? await saveCurrentTemplate(false)
      : selectedTemplate;
    if (!template) return;
    try {
      if (isDownloadKind(kind)) {
        onPrepared({ kind, fileName, template, workbook });
        return;
      }
      const parsed = parseOrderFileImportWorkbook(workbook, template);
      onPrepared({ kind, fileName, template, parsed });
    } catch (error) {
      notifyError(
        getErrorMessage(
          error,
          isDownloadKind(kind)
            ? "按当前映射生成下载表格失败"
            : "按当前映射核对表格失败",
        ),
      );
    }
  }

  function getMappingDescription(field: OrderFileImportField) {
    const mapping =
      editor.draft.field_mappings[field] ?? {
        sourceType: "column" as const,
        column: null,
        fixedValue: "",
        headerAliases: [],
      };
    if (mapping.sourceType === "fixed") {
      const columnLabel =
        isDownloadKind(kind) && mapping.column
          ? ` → ${mapping.worksheetName ? `${mapping.worksheetName} / ` : ""}${columnNumberToLabel(mapping.column)} 列`
          : "";
      return mapping.fixedValue
        ? {
            mapped: true,
            primary: `固定值：${mapping.fixedValue}${columnLabel}`,
            secondary: "",
          }
        : { mapped: false, primary: "固定值未设置", secondary: "" };
    }
    if (mapping.sourceType === "header") {
      const mappingWorksheet =
        kind === "shipping_export" && mapping.worksheetName
          ? workbook?.worksheets.find(
              (worksheet) => worksheet.name === mapping.worksheetName,
            ) ?? null
          : selectedWorksheet;
      const resolved =
        kind === "shipping_export" && mappingWorksheet
          ? resolveOrderFileTemplateMappings(
              mappingWorksheet,
              draftToTemplate(editor.draft, selectedTemplate),
            ).find((item) => item.field === field)
          : resolvedMappings.find((item) => item.field === field);
      if (resolved?.resolvedColumns.length) {
        return {
          mapped: true,
          primary: `自动识别 ${mapping.worksheetName ? `${mapping.worksheetName} / ` : ""}${columnNumberToLabel(resolved.resolvedColumn!)} 列`,
          secondary: resolved.matchedHeader,
        };
      }
      return {
        mapped: mapping.headerAliases.length > 0,
        primary: "按现有表头自动识别",
        secondary: mapping.headerAliases.slice(0, 3).join(" / "),
      };
    }
    const columns = mapping.columns?.length
      ? mapping.columns
      : mapping.column
        ? [mapping.column]
        : [];
    if (columns.length === 0) {
      return { mapped: false, primary: "未绑定", secondary: "" };
    }
    const sample = columns
      .map((column) => sampleValues.find((cell) => cell.column === column)?.value ?? "")
      .filter(Boolean)
      .join(" ");
    return {
      mapped: true,
      primary: `${mapping.worksheetName ? `${mapping.worksheetName} / ` : ""}${columns.map(columnNumberToLabel).join(" + ")} 列（空格组合）`,
      secondary: sample || "当前样例行为空",
    };
  }

  function bindSelectedColumn(append = false) {
    if (!selectedSampleColumn) {
      notifyWarning("请先从右侧样例数据中选择一个表格列");
      return;
    }
    const current = editor.draft.field_mappings[selectedField];
    const currentColumns = current?.sourceType === "column"
      ? current.columns?.length
        ? current.columns
        : current.column
          ? [current.column]
          : []
      : [];
    const nextColumns = append && !isDownloadKind(kind) && currentColumns.length > 0
      ? [...currentColumns, selectedSampleColumn]
      : [selectedSampleColumn];
    updateMapping(selectedField, {
      sourceType: "column",
      column: nextColumns[0],
      columns: nextColumns,
      fixedValue: "",
      headerAliases: [],
      worksheetName:
        kind === "shipping_export"
          ? selectedWorksheet?.name ?? editor.draft.worksheet_name
          : "",
    });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function clearSelectedMapping() {
    updateMapping(selectedField, {
      sourceType: "column",
      column: null,
      columns: [],
      fixedValue: "",
      headerAliases: [],
      worksheetName:
        fields.find((field) => field.key === selectedField)?.worksheetName ?? "",
    });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function clearAllMappings() {
    updateDraft({
      field_mappings: Object.fromEntries(
        fields.map((field) => [
          field.key,
          {
            sourceType: "column",
            column: null,
            columns: [],
            fixedValue: "",
            headerAliases: [],
            worksheetName: field.worksheetName ?? "",
          },
        ]),
      ),
    });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function useFixedValue() {
    const current =
      editor.draft.field_mappings[selectedField] ?? {
        sourceType: "column" as const,
        column: null,
        fixedValue: "",
        headerAliases: [],
      };
    const mappingWorksheet =
      kind === "shipping_export" && current.worksheetName
        ? workbook?.worksheets.find(
            (worksheet) => worksheet.name === current.worksheetName,
          ) ?? null
        : selectedWorksheet;
    const mappingResolvedColumn = mappingWorksheet
      ? resolveOrderFileTemplateMappings(
          mappingWorksheet,
          draftToTemplate(editor.draft, selectedTemplate),
        ).find((item) => item.field === selectedField)?.resolvedColumn
      : null;
    const exportColumn =
      current.column ??
      mappingResolvedColumn ??
      null;
    if (isDownloadKind(kind) && !exportColumn) {
      notifyWarning("请先为当前网站字段绑定一个表格列，再设置固定值");
      return;
    }
    updateMapping(selectedField, {
      ...current,
      sourceType: "fixed",
      columns: undefined,
      column: isDownloadKind(kind) ? exportColumn : null,
      worksheetName:
        kind === "shipping_export"
          ? current.worksheetName ||
            selectedWorksheet?.name ||
            editor.draft.worksheet_name
          : current.worksheetName,
    });
    setSelectedSampleColumn(null);
    setFixedValueField(selectedField);
  }

  const busy = loading || reading || saving;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={getTitle(kind)}
    >
      <div className="max-h-[94vh] w-full max-w-7xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">{getTitle(kind)}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {isDownloadKind(kind)
                ? kind === "temu_upload"
                  ? "选择已有模板和 Temu 表格样例，把网站字段绑定到目标列后下载所选订单。"
                  : "选择已有模板和双工作表发货样例，把网站字段绑定到对应工作表的目标列后下载所选订单。"
                : "选择已有模板后只需选择文件并核对；新格式可以从样例数据中绑定字段并保存为模板。"}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn h-8 w-8"
            onClick={onClose}
            disabled={busy}
            aria-label={
              isDownloadKind(kind)
                ? `关闭${kind === "temu_upload" ? "下载上传表格" : "下载发货表格"}`
                : "关闭文件上传"
            }
          >
            <X size={17} />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-800">
                  1. 选择模板与{isDownloadKind(kind) ? "表格样例" : "上传文件"}
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  自动生成的现有模板也可以删除，删除后不会再次自动生成。
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary h-9 px-3 text-xs"
                  onClick={handleNewTemplate}
                  disabled={busy || !canEdit}
                >
                  <Plus size={15} /> 新建模板
                </button>
                <button
                  type="button"
                  className="icon-btn h-9 w-9 text-rose-600"
                  onClick={() => void handleDeleteTemplate()}
                  disabled={busy || !selectedTemplate || !canEdit}
                  aria-label="删除当前模板"
                  title="删除当前模板"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                {isDownloadKind(kind) ? "下载模板" : "上传模板"}
                <select
                  value={editor.templateId ?? ""}
                  onChange={(event) => handleTemplateChange(event.target.value)}
                  className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  disabled={busy}
                >
                  {!editor.templateId && (
                    <option value="">新模板（尚未保存）</option>
                  )}
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                      {template.is_system ? "（自动生成）" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                模板名称
                <input
                  value={editor.draft.name}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                  className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  disabled={busy || !canEdit}
                />
              </label>

              <div className="flex flex-col gap-1 text-xs font-semibold text-slate-600 xl:col-span-2">
                {getFileLabel(kind)}
                <div className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-white pl-3">
                  <FileSpreadsheet
                    size={16}
                    className="shrink-0 text-slate-400"
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      fileName ? "text-slate-700" : "text-slate-400"
                    }`}
                    title={fileName}
                  >
                    {fileName || "尚未选择 CSV、XLS 或 XLSX 文件"}
                  </span>
                  <label className="btn-secondary mr-1 inline-flex h-8 shrink-0 cursor-pointer items-center px-3 text-xs">
                    {reading ? "读取中..." : "选择文件"}
                    <input
                      type="file"
                      accept=".csv,.xls,.xlsx"
                      className="hidden"
                      disabled={busy || !canEdit}
                      onChange={(event) => void handleSelectFile(event)}
                    />
                  </label>
                </div>
              </div>

              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                工作表
                {workbook ? (
                  <select
                    value={editor.draft.worksheet_name}
                    onChange={(event) => {
                      updateDraft({ worksheet_name: event.target.value });
                      setSelectedSampleColumn(null);
                    }}
                    className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    disabled={busy || !canEdit}
                  >
                    <option value="">
                      第一个工作表（{workbook.worksheets[0]?.name || "无"}）
                    </option>
                    {workbook.worksheets.map((worksheet) => (
                      <option key={worksheet.name} value={worksheet.name}>
                        {worksheet.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={editor.draft.worksheet_name}
                    onChange={(event) =>
                      updateDraft({ worksheet_name: event.target.value })
                    }
                    placeholder="留空表示第一个工作表"
                    className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    disabled={busy || !canEdit}
                  />
                )}
              </label>

              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                数据开始行
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={editor.draft.start_row}
                  onChange={(event) => {
                    updateDraft({
                      start_row: Math.max(1, Number(event.target.value) || 1),
                    });
                    setSelectedSampleColumn(null);
                  }}
                  className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  disabled={busy || !canEdit}
                />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-3">
              <h3 className="text-sm font-bold text-slate-800">2. 映射设置</h3>
              <p className="mt-1 text-xs text-slate-500">
                {isDownloadKind(kind)
                  ? "已有模板不需要再次绑定；选择左侧网站字段和右侧目标列后点击“绑定”。"
                  : "已有模板不需要再次绑定；需要调整时，选择左侧字段和右侧样例列后点击“绑定”。"}
              </p>
            </div>

            <div className="grid min-h-[430px] lg:grid-cols-[minmax(380px,1.15fr)_180px_minmax(360px,1fr)]">
              <div className="max-h-[500px] overflow-auto border-b border-slate-200 lg:border-b-0 lg:border-r">
                <div className="sticky top-0 grid grid-cols-[72px_minmax(150px,0.9fr)_minmax(180px,1.3fr)] bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
                  <div>要求</div>
                  <div>网站字段</div>
                  <div>当前映射内容</div>
                </div>
                <div className="divide-y divide-slate-100">
                  {fields.map((field) => {
                    const description = getMappingDescription(field.key);
                    const active = selectedField === field.key;
                    return (
                      <button
                        key={field.key}
                        type="button"
                        className={`grid w-full grid-cols-[72px_minmax(150px,0.9fr)_minmax(180px,1.3fr)] items-center px-3 py-3 text-left transition ${
                          active
                            ? "bg-teal-50 ring-1 ring-inset ring-teal-500"
                            : "bg-white hover:bg-slate-50"
                        }`}
                        onClick={() => {
                          setSelectedField(field.key);
                          const mapping = editor.draft.field_mappings[field.key];
                          setFixedValueField(
                            mapping?.sourceType === "fixed" ? field.key : null,
                          );
                        }}
                      >
                        <div>
                          <span
                            className={`rounded px-2 py-1 text-[11px] font-bold ${
                              field.required
                                ? "bg-rose-50 text-rose-600"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {field.required ? "必填" : "选填"}
                          </span>
                        </div>
                        <div className="pr-3 text-sm font-bold text-slate-800">
                          {field.label}
                        </div>
                        <div className="min-w-0">
                          <div
                            className={`truncate text-xs font-bold ${
                              description.mapped
                                ? "text-teal-700"
                                : "text-amber-700"
                            }`}
                          >
                            {description.primary}
                          </div>
                          {description.secondary && (
                            <div
                              className="mt-1 truncate text-[11px] text-slate-500"
                              title={description.secondary}
                            >
                              {description.secondary}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col items-stretch justify-center gap-2 border-b border-slate-200 bg-slate-50/40 p-4 lg:border-b-0 lg:border-r">
                <button
                  type="button"
                  className="btn-primary justify-center text-xs"
                  onClick={() => bindSelectedColumn(false)}
                  disabled={!selectedSampleColumn || busy || !canEdit}
                >
                  <Link2 size={15} /> 绑定
                </button>
                {!isDownloadKind(kind) && (
                  <button
                    type="button"
                    className="btn-secondary justify-center text-xs"
                    onClick={() => bindSelectedColumn(true)}
                    disabled={!selectedSampleColumn || busy || !canEdit || !(
                      (editor.draft.field_mappings[selectedField]?.columns?.length ?? 0) > 0 ||
                      editor.draft.field_mappings[selectedField]?.column
                    )}
                  >
                    <Link2 size={15} /> 追加组合
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary justify-center text-xs"
                  onClick={clearSelectedMapping}
                  disabled={busy || !canEdit}
                >
                  <Unlink size={15} /> 解除绑定
                </button>
                <button
                  type="button"
                  className="btn-secondary justify-center text-xs"
                  onClick={useFixedValue}
                  disabled={busy || !canEdit}
                >
                  <Pencil size={15} /> 设置固定值
                </button>

                {fixedValueField && (
                  <div className="mt-2 rounded-lg border border-teal-200 bg-white p-3">
                    <div className="mb-2 text-xs font-bold text-slate-700">
                      {fields.find((field) => field.key === fixedValueField)?.label}
                    </div>
                    <input
                      value={
                        editor.draft.field_mappings[fixedValueField]?.fixedValue ??
                        ""
                      }
                      onChange={(event) => {
                        const current =
                          editor.draft.field_mappings[fixedValueField];
                        updateMapping(fixedValueField, {
                          sourceType: "fixed",
                          column:
                            isDownloadKind(kind)
                              ? current?.column ?? null
                              : null,
                          fixedValue: event.target.value,
                          headerAliases: current?.headerAliases ?? [],
                          worksheetName: current?.worksheetName,
                        });
                      }}
                      className="h-9 w-full rounded-lg border border-line px-2 text-sm"
                      placeholder="输入固定值"
                    />
                  </div>
                )}

                <button
                  type="button"
                  className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  onClick={clearAllMappings}
                  disabled={busy || !canEdit}
                >
                  <Eraser size={15} /> 全部清除
                </button>
              </div>

              <div className="min-w-0 bg-white">
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-xs font-bold text-slate-600">
                    数据摘取（第 {editor.draft.start_row} 行）
                  </div>
                  {selectedSampleColumn && (
                    <div className="text-[11px] font-bold text-teal-700">
                      已选择 {columnNumberToLabel(selectedSampleColumn)} 列
                    </div>
                  )}
                </div>
                {!workbook ? (
                  <div className="flex min-h-[390px] items-center justify-center p-6 text-center text-xs text-slate-500">
                    请先选择表格，系统会在这里显示数据开始行的每一列真实数据。
                  </div>
                ) : !selectedWorksheet ? (
                  <div className="flex min-h-[390px] items-center justify-center p-6 text-center text-xs font-semibold text-amber-700">
                    文件中找不到模板指定的工作表，请重新选择。
                  </div>
                ) : sampleValues.length === 0 ? (
                  <div className="flex min-h-[390px] items-center justify-center p-6 text-center text-xs font-semibold text-amber-700">
                    第 {editor.draft.start_row} 行没有可读取的数据。
                  </div>
                ) : (
                  <div className="max-h-[450px] overflow-auto p-3">
                    <div className="space-y-2">
                      {sampleValues.map((cell) => {
                        const selected = selectedSampleColumn === cell.column;
                        return (
                          <button
                            key={cell.column}
                            type="button"
                            className={`grid w-full grid-cols-[80px_minmax(0,1fr)] rounded-lg border px-3 py-2 text-left transition ${
                              selected
                                ? "border-teal-500 bg-teal-50"
                                : "border-slate-200 bg-white hover:border-slate-300"
                            }`}
                            onClick={() => setSelectedSampleColumn(cell.column)}
                          >
                            <span className="text-xs font-bold text-slate-500">
                              {columnNumberToLabel(cell.column)} 列
                            </span>
                            <span
                              className={`truncate text-xs ${
                                cell.value ? "text-slate-700" : "text-slate-400"
                              }`}
                              title={cell.value}
                            >
                              {cell.value || "（空）"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void saveCurrentTemplate(true)}
              disabled={busy || !canEdit}
            >
              保存模板
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handlePrepareImport()}
              disabled={busy || !workbook || !fileName || !canEdit}
            >
              {isDownloadKind(kind) ? <Download size={16} /> : <Upload size={16} />}
              {isDownloadKind(kind) ? "按模板下载" : "按模板核对导入"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
