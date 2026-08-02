import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Eraser,
  FileSpreadsheet,
  History,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Unlink,
  Upload,
  WalletCards,
  X,
} from "lucide-react";
import { StandardTable } from "../ui/StandardTable";
import {
  columnNumberToLabel,
  parseActualShippingFeeWorkbook,
  type ActualShippingFeeParseResult,
} from "../../lib/actual-shipping-fee-parser";
import type { Workbook } from "../../lib/tabular-parser";
import type { LogisticsMethod } from "../../types";
import {
  bindActualShippingFeeColumn,
  clearActualShippingFeeFieldMapping,
  clearAllActualShippingFeeFieldMappings,
  getActualShippingFeeFieldMapping,
  setActualShippingFeeFixedMapping,
  type ActualShippingFeeWebsiteField,
} from "../../lib/actual-shipping-fee-template-mapping";
import {
  deleteActualShippingFeeTemplate,
  ensureDefaultActualShippingFeeTemplates,
  fetchActualShippingFeeTemplates,
  fetchAvailableActualShippingFeeLogisticsMethods,
  saveActualShippingFeeTemplate,
  type ActualShippingFeeImportTemplate,
  type ActualShippingFeeImportTemplateInput,
} from "../../lib/actual-shipping-fee-templates";
import {
  fetchActualShippingFeeReport,
  fetchFirstLegMonthlySettlements,
  fetchFirstLegPaymentRecords,
  fetchLogisticsPaymentRecords,
  importActualShippingFees,
  previewActualShippingFeeImport,
  recordFirstLegPayment,
  recordLogisticsPayment,
  saveFirstLegMonthlyActual,
  updateActualShipTimeForShipment,
  voidFirstLegPayment,
  voidLogisticsPayment,
  type ActualShippingFeeImportPreview,
  type ActualShippingFeePreviewStatus,
  type ActualShippingFeeReport,
  type ActualShippingFeeReportRow,
  type FirstLegMonthlySettlementRecord,
  type LogisticsPaymentRecord,
  type LogisticsSettlementSummary,
} from "../../lib/actual-shipping-fees";
import { fetchFinanceOrderAnalysis } from "../../lib/finance-queries";
import { confirmAction, confirmSave } from "../../utils/confirmations";
import { getErrorMessage } from "../../utils/errors";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notifications";

type Props = {
  canEdit: boolean;
  onImported: () => Promise<void> | void;
};

type PendingImport = {
  fileName: string;
  template: ActualShippingFeeImportTemplate;
  parsed: ActualShippingFeeParseResult;
  preview: ActualShippingFeeImportPreview;
};

type TemplateEditorState = {
  templateId: string | null;
  draft: ActualShippingFeeImportTemplateInput;
};

type FirstLegMonthView = {
  shippingMonth: string;
  shipmentCount: number;
  estimatedAmountRmb: number;
  actualAmountRmb: number | null;
  paidAmountRmb: number;
  outstandingAmountRmb: number;
  lastPaidAt: string;
  status: LogisticsSettlementSummary["status"];
};

type PaymentTarget = {
  kind: "first_leg" | "last_leg";
  logisticsMethodId: string;
  logisticsMethodName: string;
  shippingMonth: string;
  shipmentCount: number;
  payableAmountRmb: number;
  paidAmountRmb: number;
  outstandingAmountRmb: number;
  lastPaidAt: string;
  status: LogisticsSettlementSummary["status"];
};

const websiteFieldMeta: Array<{
  key: ActualShippingFeeWebsiteField;
  label: string;
  fixedValueLabel: string;
}> = [
  { key: "tracking", label: "物流单号", fixedValueLabel: "物流单号固定值" },
  { key: "amount", label: "实际尾程运费（人民币）", fixedValueLabel: "运费固定值" },
  { key: "logistics_method", label: "物流方式", fixedValueLabel: "网站物流方式" },
];

const emptyReport: ActualShippingFeeReport = {
  rows: [],
  totalCount: 0,
  summary: {
    shipmentCount: 0,
    totalAmountRmb: 0,
    missingActualShipTimeCount: 0,
    payableAmountRmb: 0,
    paidAmountRmb: 0,
    outstandingAmountRmb: 0,
    settlements: [],
  },
  months: [],
};

function createTemplateDraft(
  workbook: Workbook | null,
): ActualShippingFeeImportTemplateInput {
  return {
    name: "新运费导入模板",
    worksheet_name: workbook?.worksheets[0]?.name ?? "",
    start_row: 2,
    tracking_source_type: "column",
    tracking_column: null,
    tracking_fixed_value: "",
    amount_source_type: "column",
    amount_column: null,
    amount_fixed_value: null,
    logistics_method_source_type: "fixed",
    logistics_method_column: null,
    logistics_method_fixed_id: null,
  };
}

function templateToDraft(
  template: ActualShippingFeeImportTemplate,
): ActualShippingFeeImportTemplateInput {
  return {
    name: template.name,
    worksheet_name: template.worksheet_name,
    start_row: template.start_row,
    tracking_source_type: template.tracking_source_type,
    tracking_column: template.tracking_column,
    tracking_fixed_value: template.tracking_fixed_value,
    amount_source_type: template.amount_source_type,
    amount_column: template.amount_column,
    amount_fixed_value: template.amount_fixed_value,
    logistics_method_source_type: template.logistics_method_source_type,
    logistics_method_column: template.logistics_method_column,
    logistics_method_fixed_id: template.logistics_method_fixed_id,
  };
}

function formatPreciseRmb(value: number) {
  return `¥${value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function getLocalDateTimeInputValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatPaymentTime(value: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function settlementStatusMeta(status: LogisticsSettlementSummary["status"]) {
  if (status === "paid") return { label: "已结清", className: "bg-emerald-50 text-emerald-700" };
  if (status === "partial") return { label: "部分付款", className: "bg-amber-50 text-amber-700" };
  return { label: "未付款", className: "bg-slate-100 text-slate-600" };
}

function statusMeta(status: ActualShippingFeePreviewStatus) {
  if (status === "importable") return { label: "可导入", className: "bg-emerald-50 text-emerald-700" };
  if (status === "existing") return { label: "已有运费，跳过", className: "bg-amber-50 text-amber-700" };
  if (status === "conflict") return { label: "对应多个包裹，跳过", className: "bg-rose-50 text-rose-700" };
  if (status === "duplicate") return { label: "文件内重复，跳过", className: "bg-rose-50 text-rose-700" };
  if (status === "method_mismatch") return { label: "物流方式不符，跳过", className: "bg-orange-50 text-orange-700" };
  return { label: "未匹配，跳过", className: "bg-slate-100 text-slate-600" };
}

export function ActualShippingFeesPanel({ canEdit, onImported }: Props) {
  const [report, setReport] = useState<ActualShippingFeeReport>(emptyReport);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [month, setMonth] = useState("");
  const [logisticsMethodId, setLogisticsMethodId] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [templates, setTemplates] = useState<ActualShippingFeeImportTemplate[]>([]);
  const [logisticsMethods, setLogisticsMethods] = useState<LogisticsMethod[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateEditor, setTemplateEditor] = useState<TemplateEditorState | null>(null);
  const [selectedWebsiteField, setSelectedWebsiteField] =
    useState<ActualShippingFeeWebsiteField>("tracking");
  const [selectedSampleColumn, setSelectedSampleColumn] = useState<number | null>(null);
  const [fixedValueField, setFixedValueField] =
    useState<ActualShippingFeeWebsiteField | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [uploadedWorkbook, setUploadedWorkbook] = useState<Workbook | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [editingActualShipTimeId, setEditingActualShipTimeId] = useState<string | null>(null);
  const [editingActualShipTimeValue, setEditingActualShipTimeValue] = useState("");
  const [savingActualShipTimeId, setSavingActualShipTimeId] = useState<string | null>(null);
  const [firstLegMonths, setFirstLegMonths] = useState<FirstLegMonthView[]>([]);
  const [firstLegLoading, setFirstLegLoading] = useState(true);
  const [firstLegError, setFirstLegError] = useState("");
  const [editingFirstLegMonth, setEditingFirstLegMonth] = useState<string | null>(null);
  const [editingFirstLegAmount, setEditingFirstLegAmount] = useState("");
  const [savingFirstLegActual, setSavingFirstLegActual] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<PaymentTarget | null>(null);
  const [paymentRecords, setPaymentRecords] = useState<LogisticsPaymentRecord[]>([]);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDateTime, setPaymentDateTime] = useState(getLocalDateTimeInputValue);
  const [paymentRemark, setPaymentRemark] = useState("");
  const [paymentRequestKey, setPaymentRequestKey] = useState("");
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [voidingPaymentId, setVoidingPaymentId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextReport = await fetchActualShippingFeeReport({
        page,
        pageSize,
        month,
        logisticsMethodId,
        search,
      });
      setReport(nextReport);
      return nextReport;
    } catch (loadError) {
      setError(getErrorMessage(loadError, "加载实际运费月结失败"));
      setReport(emptyReport);
      return null;
    } finally {
      setLoading(false);
    }
  }, [logisticsMethodId, month, page, pageSize, search]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const loadFirstLegData = useCallback(async () => {
    setFirstLegLoading(true);
    setFirstLegError("");
    try {
      const [analysis, persistedRows] = await Promise.all([
        fetchFinanceOrderAnalysis({ page: 1, pageSize: 1 }),
        fetchFirstLegMonthlySettlements(),
      ]);
      const persistedByMonth = new Map<string, FirstLegMonthlySettlementRecord>(
        persistedRows.map((row) => [row.shippingMonth, row]),
      );
      const nextByMonth = new Map<string, FirstLegMonthView>();

      analysis.monthly.forEach((raw) => {
        const shippingMonth = String(raw.month ?? "");
        if (!shippingMonth) return;
        const persisted = persistedByMonth.get(shippingMonth);
        nextByMonth.set(shippingMonth, {
          shippingMonth,
          shipmentCount: Number(raw.order_count ?? 0),
          estimatedAmountRmb: Number(raw.first_leg_shipping ?? 0),
          actualAmountRmb: persisted ? persisted.actualAmountRmb : null,
          paidAmountRmb: persisted?.paidAmountRmb ?? 0,
          outstandingAmountRmb: persisted?.outstandingAmountRmb ?? 0,
          lastPaidAt: persisted?.lastPaidAt ?? "",
          status: persisted?.status ?? "unpaid",
        });
      });

      persistedRows.forEach((persisted) => {
        if (nextByMonth.has(persisted.shippingMonth)) return;
        nextByMonth.set(persisted.shippingMonth, {
          shippingMonth: persisted.shippingMonth,
          shipmentCount: 0,
          estimatedAmountRmb: persisted.estimatedAmountSnapshotRmb,
          actualAmountRmb: persisted.actualAmountRmb,
          paidAmountRmb: persisted.paidAmountRmb,
          outstandingAmountRmb: persisted.outstandingAmountRmb,
          lastPaidAt: persisted.lastPaidAt,
          status: persisted.status,
        });
      });

      setFirstLegMonths(
        Array.from(nextByMonth.values()).sort((a, b) =>
          b.shippingMonth.localeCompare(a.shippingMonth),
        ),
      );
    } catch (loadError) {
      setFirstLegMonths([]);
      setFirstLegError(getErrorMessage(loadError, "加载头程月结失败"));
    } finally {
      setFirstLegLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstLegData();
  }, [loadFirstLegData]);

  useEffect(() => {
    setPage(1);
  }, [logisticsMethodId, month, pageSize, search]);

  const loadTemplatesAndMethods = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const nextMethods = await fetchAvailableActualShippingFeeLogisticsMethods();
      setLogisticsMethods(nextMethods);
      await ensureDefaultActualShippingFeeTemplates();
      const nextTemplates = await fetchActualShippingFeeTemplates();
      setTemplates(nextTemplates);
      setSelectedTemplateId((current) =>
        nextTemplates.some((template) => template.id === current)
          ? current
          : nextTemplates[0]?.id ?? "",
      );
      return { templates: nextTemplates, methods: nextMethods };
    } catch (loadTemplateError) {
      notifyError(getErrorMessage(loadTemplateError, "加载实际运费导入模板失败"));
      return null;
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplatesAndMethods();
  }, [loadTemplatesAndMethods]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  );
  const templateSample = useMemo(() => {
    if (!templateEditor || !uploadedWorkbook) return null;
    const requestedWorksheetName = templateEditor.draft.worksheet_name.trim();
    const worksheet = requestedWorksheetName
      ? uploadedWorkbook.worksheets.find((item) => item.name === requestedWorksheetName)
      : uploadedWorkbook.worksheets[0];
    if (!worksheet) {
      return {
        worksheetName: requestedWorksheetName,
        values: [],
        missingWorksheet: Boolean(requestedWorksheetName),
      };
    }
    const row = worksheet.data[Math.max(0, templateEditor.draft.start_row - 1)] ?? [];
    const maximumMappedColumn = Math.max(
      templateEditor.draft.tracking_column ?? 0,
      templateEditor.draft.amount_column ?? 0,
      templateEditor.draft.logistics_method_column ?? 0,
    );
    const columnCount = Math.max(row.length, maximumMappedColumn);
    return {
      worksheetName: worksheet.name,
      values: Array.from({ length: columnCount }, (_, index) => ({
        column: index + 1,
        value: String(row[index] ?? ""),
      })),
      missingWorksheet: false,
    };
  }, [templateEditor, uploadedWorkbook]);

  const totalPages = Math.max(1, Math.ceil(report.totalCount / pageSize));
  const monthOptions = useMemo(() => {
    const merged = new Map<string, { month: string; shipmentCount: number }>();
    report.months.forEach((item) => {
      const key = item.month || "__missing__";
      merged.set(key, { month: key, shipmentCount: item.shipmentCount });
    });
    firstLegMonths.forEach((item) => {
      const existing = merged.get(item.shippingMonth);
      merged.set(item.shippingMonth, {
        month: item.shippingMonth,
        shipmentCount: Math.max(existing?.shipmentCount ?? 0, item.shipmentCount),
      });
    });
    return Array.from(merged.values()).sort((a, b) => {
      if (a.month === "__missing__") return 1;
      if (b.month === "__missing__") return -1;
      return b.month.localeCompare(a.month);
    });
  }, [firstLegMonths, report.months]);
  const selectedFirstLegMonth = useMemo(() => {
    if (!month || month === "__missing__") return null;
    return firstLegMonths.find((item) => item.shippingMonth === month) ?? {
      shippingMonth: month,
      shipmentCount: 0,
      estimatedAmountRmb: 0,
      actualAmountRmb: null,
      paidAmountRmb: 0,
      outstandingAmountRmb: 0,
      lastPaidAt: "",
      status: "unpaid" as const,
    };
  }, [firstLegMonths, month]);
  const selectedFirstLegStatusMeta = !selectedFirstLegMonth || selectedFirstLegMonth.actualAmountRmb === null
    ? { label: "待确认实际", className: "bg-sky-50 text-sky-700" }
    : settlementStatusMeta(selectedFirstLegMonth.status);
  const importStats = useMemo(() => {
    if (!pendingImport) return null;
    return [
      ["表格有效记录", pendingImport.preview.parsedRecordCount],
      ["可导入", pendingImport.preview.importableRecordCount],
      ["已有运费跳过", pendingImport.preview.existingRecordCount],
      ["未匹配跳过", pendingImport.preview.unmatchedRecordCount],
      ["匹配冲突", pendingImport.preview.conflictRecordCount],
      ["物流方式不符", pendingImport.preview.methodMismatchRecordCount],
      ["异常/汇总行", pendingImport.parsed.issues.length],
    ] as const;
  }, [pendingImport]);

  async function parseAndPreviewFile(
    workbook: Workbook,
    fileName: string,
    template: ActualShippingFeeImportTemplate,
  ) {
    const parsed = parseActualShippingFeeWorkbook(workbook, template, logisticsMethods);
    if (parsed.records.length === 0) {
      throw new Error(parsed.issues[0]?.reason || "表格中没有可核对的物流单号和实际运费");
    }
    const preview = await previewActualShippingFeeImport(parsed.records);
    setPendingImport({ fileName, template, parsed, preview });
  }

  async function handleSelectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setParsing(true);
    setPendingImport(null);
    try {
      const { readActualShippingFeeWorkbook } = await import(
        "../../lib/actual-shipping-fee-workbook"
      );
      const workbook = await readActualShippingFeeWorkbook(file);
      setUploadedWorkbook(workbook);
      setUploadedFileName(file.name);
      setTemplateEditor((current) => {
        const nextEditor = current ?? (
          selectedTemplate
            ? {
                templateId: selectedTemplate.id,
                draft: templateToDraft(selectedTemplate),
              }
            : {
                templateId: null,
                draft: createTemplateDraft(workbook),
              }
        );
        if (nextEditor.draft.worksheet_name.trim()) return nextEditor;
        return {
          ...nextEditor,
          draft: {
            ...nextEditor.draft,
            worksheet_name: workbook.worksheets[0]?.name ?? "",
          },
        };
      });
      setSelectedSampleColumn(null);
      notifySuccess(`已读取表格“${file.name}”，请从样例数据中选择列并绑定。`);
    } catch (parseError) {
      notifyError(getErrorMessage(parseError, "解析实际运费表格失败"));
    } finally {
      setParsing(false);
    }
  }

  function handleTemplateChange(templateId: string) {
    setSelectedTemplateId(templateId);
    setPendingImport(null);
    setSelectedSampleColumn(null);
    setFixedValueField(null);
    const template = templates.find((item) => item.id === templateId);
    setTemplateEditor(template
      ? {
          templateId: template.id,
          draft: templateToDraft(template),
        }
      : {
          templateId: null,
          draft: createTemplateDraft(uploadedWorkbook),
        });
  }

  function updateTemplateDraft(updates: Partial<ActualShippingFeeImportTemplateInput>) {
    setTemplateEditor((current) => current
      ? { ...current, draft: { ...current.draft, ...updates } }
      : current);
  }

  function openNewTemplateEditor() {
    setSelectedTemplateId("");
    setTemplateEditor({
      templateId: null,
      draft: createTemplateDraft(uploadedWorkbook),
    });
    setSelectedWebsiteField("tracking");
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function openImportWorkbench() {
    setTemplateEditor(selectedTemplate
      ? {
          templateId: selectedTemplate.id,
          draft: templateToDraft(selectedTemplate),
        }
      : {
          templateId: null,
          draft: createTemplateDraft(uploadedWorkbook),
        });
    setSelectedWebsiteField("tracking");
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function closeImportWorkbench() {
    setTemplateEditor(null);
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function selectWebsiteField(field: ActualShippingFeeWebsiteField) {
    setSelectedWebsiteField(field);
    const mapping = templateEditor
      ? getActualShippingFeeFieldMapping(templateEditor.draft, field)
      : null;
    setFixedValueField(mapping?.sourceType === "fixed" ? field : null);
  }

  function handleBindSelectedColumn() {
    if (!templateEditor) return;
    if (!selectedSampleColumn) {
      notifyWarning("请先从右侧样例数据中选择一个表格列");
      return;
    }
    setTemplateEditor({
      ...templateEditor,
      draft: bindActualShippingFeeColumn(
        templateEditor.draft,
        selectedWebsiteField,
        selectedSampleColumn,
      ),
    });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function handleUseFixedValue() {
    if (!templateEditor) return;
    setTemplateEditor({
      ...templateEditor,
      draft: setActualShippingFeeFixedMapping(
        templateEditor.draft,
        selectedWebsiteField,
      ),
    });
    setSelectedSampleColumn(null);
    setFixedValueField(selectedWebsiteField);
  }

  function handleClearSelectedMapping() {
    if (!templateEditor) return;
    setTemplateEditor({
      ...templateEditor,
      draft: clearActualShippingFeeFieldMapping(
        templateEditor.draft,
        selectedWebsiteField,
      ),
    });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function handleClearAllMappings() {
    if (!templateEditor) return;
    setTemplateEditor({
      ...templateEditor,
      draft: clearAllActualShippingFeeFieldMappings(templateEditor.draft),
    });
    setSelectedSampleColumn(null);
    setFixedValueField(null);
  }

  function getTemplateValidationError(draft: ActualShippingFeeImportTemplateInput) {
    if (!draft.name.trim()) return "请填写模板名称";
    if (draft.start_row < 1) return "数据开始行必须大于 0";
    const columnMappings = [
      [draft.tracking_source_type, draft.tracking_column, "物流单号"],
      [draft.amount_source_type, draft.amount_column, "实际尾程运费"],
      [draft.logistics_method_source_type, draft.logistics_method_column, "物流方式"],
    ] as const;
    const invalidColumn = columnMappings.find(
      ([sourceType, column]) => sourceType === "column" && (!column || column < 1),
    );
    if (invalidColumn) return `请为${invalidColumn[2]}绑定表格列或设置固定值`;
    if (
      draft.tracking_source_type === "fixed" &&
      !draft.tracking_fixed_value.trim()
    ) {
      return "请填写物流单号固定值";
    }
    if (
      draft.amount_source_type === "fixed" &&
      (
        draft.amount_fixed_value === null ||
        !Number.isFinite(draft.amount_fixed_value) ||
        draft.amount_fixed_value < 0
      )
    ) {
      return "请填写不小于 0 的实际尾程运费固定值";
    }
    if (
      draft.logistics_method_source_type === "fixed" &&
      !draft.logistics_method_fixed_id
    ) {
      return "请选择固定物流方式";
    }
    return "";
  }

  async function saveCurrentTemplate(showSuccess: boolean) {
    if (!templateEditor) return;
    const draft = templateEditor.draft;
    const validationError = getTemplateValidationError(draft);
    if (validationError) {
      notifyWarning(validationError);
      return null;
    }

    setSavingTemplate(true);
    try {
      const saved = await saveActualShippingFeeTemplate(
        draft,
        templateEditor.templateId ?? undefined,
      );
      await loadTemplatesAndMethods();
      setSelectedTemplateId(saved.id);
      setTemplateEditor({
        templateId: saved.id,
        draft: templateToDraft(saved),
      });
      if (showSuccess) {
        notifySuccess(templateEditor.templateId ? "导入模板已更新。" : "导入模板已创建。");
      }
      return saved;
    } catch (saveError) {
      notifyError(getErrorMessage(saveError, "保存实际运费导入模板失败"));
      return null;
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleSaveTemplate() {
    await saveCurrentTemplate(true);
  }

  async function handlePreviewCurrentImport() {
    if (!templateEditor) return;
    if (!uploadedWorkbook || !uploadedFileName) {
      notifyWarning("请先选择需要上传的 CSV、XLS 或 XLSX 文件");
      return;
    }
    const validationError = getTemplateValidationError(templateEditor.draft);
    if (validationError) {
      notifyWarning(validationError);
      return;
    }

    const existingTemplate = templateEditor.templateId
      ? templates.find((template) => template.id === templateEditor.templateId)
      : null;
    const templateIsDirty = !existingTemplate ||
      JSON.stringify(templateToDraft(existingTemplate)) !==
        JSON.stringify(templateEditor.draft);
    const template = templateIsDirty
      ? await saveCurrentTemplate(false)
      : existingTemplate;
    if (!template) return;

    setParsing(true);
    try {
      await parseAndPreviewFile(uploadedWorkbook, uploadedFileName, template);
      closeImportWorkbench();
    } catch (parseError) {
      notifyError(getErrorMessage(parseError, "按当前映射核对表格失败"));
    } finally {
      setParsing(false);
    }
  }

  async function handleDeleteTemplate() {
    if (!selectedTemplate) return;
    if (!confirmAction(`确认删除导入模板“${selectedTemplate.name}”吗？`)) return;
    try {
      await deleteActualShippingFeeTemplate(selectedTemplate);
      setPendingImport(null);
      const loaded = await loadTemplatesAndMethods();
      const nextTemplate = loaded?.templates[0] ?? null;
      setSelectedTemplateId(nextTemplate?.id ?? "");
      setTemplateEditor(nextTemplate
        ? {
            templateId: nextTemplate.id,
            draft: templateToDraft(nextTemplate),
          }
        : {
            templateId: null,
            draft: createTemplateDraft(uploadedWorkbook),
          });
      notifySuccess("导入模板已删除。");
    } catch (deleteError) {
      notifyError(getErrorMessage(deleteError, "删除实际运费导入模板失败"));
    }
  }

  async function handleConfirmImport() {
    if (!pendingImport || pendingImport.preview.importableRecordCount === 0) return;
    if (!confirmAction(
      `确认导入 ${pendingImport.preview.importableRecordCount} 个物流单号的实际尾程运费吗？已有运费不会覆盖。`,
    )) return;

    setImporting(true);
    try {
      const result = await importActualShippingFees({
        fileName: pendingImport.fileName,
        templateId: pendingImport.template.id,
        records: pendingImport.parsed.records,
      });
      if (result.importedRecordCount === 0) {
        notifyWarning("没有新增实际运费，匹配记录可能已由其他导入写入。");
      } else {
        notifySuccess(
          `成功导入 ${result.importedRecordCount} 票实际尾程运费，合计 ${formatPreciseRmb(result.importedTotalAmountRmb)}。` +
          (result.missingActualShipTimeCount > 0
            ? ` 其中 ${result.missingActualShipTimeCount} 票待补实际发货时间。`
            : ""),
        );
      }
      setPendingImport(null);
      setPage(1);
      await Promise.all([loadReport(), onImported()]);
    } catch (importError) {
      notifyError(getErrorMessage(importError, "导入实际运费失败"));
    } finally {
      setImporting(false);
    }
  }

  async function handleSaveActualShipTime(row: ActualShippingFeeReportRow) {
    const actualShipTime = editingActualShipTimeValue.trim().replace("T", " ");
    if (!actualShipTime) {
      notifyWarning("请选择实际发货时间");
      return;
    }
    if (!await confirmSave(`确认将订单 ${row.orderNo} 的实际发货时间补填为 ${actualShipTime} 吗？`)) return;

    setSavingActualShipTimeId(row.id);
    try {
      const updatedCount = await updateActualShipTimeForShipment({
        trackingNo: row.trackingNo,
        orderNo: row.orderNo,
        actualShipTime,
      });
      setEditingActualShipTimeId(null);
      setEditingActualShipTimeValue("");
      notifySuccess(`实际发货时间已补填，共更新 ${updatedCount} 条订单明细。`);
      const [nextReport] = await Promise.all([loadReport(), onImported()]);
      if (month === "__missing__" && nextReport?.totalCount === 0) {
        setMonth("");
        setPage(1);
      }
    } catch (saveError) {
      notifyError(getErrorMessage(saveError, "补填实际发货时间失败"));
    } finally {
      setSavingActualShipTimeId(null);
    }
  }

  async function openPaymentDialog(target: LogisticsSettlementSummary) {
    setPaymentTarget({ kind: "last_leg", ...target });
    setPaymentAmount(target.outstandingAmountRmb > 0 ? String(target.outstandingAmountRmb) : "");
    setPaymentDateTime(getLocalDateTimeInputValue());
    setPaymentRemark("");
    setPaymentRequestKey(crypto.randomUUID());
    setVoidReason("");
    setLoadingPayments(true);
    try {
      setPaymentRecords(await fetchLogisticsPaymentRecords({
        logisticsMethodId: target.logisticsMethodId,
        shippingMonth: target.shippingMonth,
      }));
    } catch (paymentError) {
      notifyError(getErrorMessage(paymentError, "加载物流付款记录失败"));
      setPaymentRecords([]);
    } finally {
      setLoadingPayments(false);
    }
  }

  async function openFirstLegPaymentDialog(target: FirstLegMonthView) {
    if (target.actualAmountRmb === null) {
      notifyWarning("请先确认当月实际头程运费");
      return;
    }
    setPaymentTarget({
      kind: "first_leg",
      logisticsMethodId: "",
      logisticsMethodName: "头程运费合计",
      shippingMonth: target.shippingMonth,
      shipmentCount: target.shipmentCount,
      payableAmountRmb: target.actualAmountRmb,
      paidAmountRmb: target.paidAmountRmb,
      outstandingAmountRmb: target.outstandingAmountRmb,
      lastPaidAt: target.lastPaidAt,
      status: target.status,
    });
    setPaymentAmount(target.outstandingAmountRmb > 0 ? String(target.outstandingAmountRmb) : "");
    setPaymentDateTime(getLocalDateTimeInputValue());
    setPaymentRemark("");
    setPaymentRequestKey(crypto.randomUUID());
    setVoidReason("");
    setLoadingPayments(true);
    try {
      setPaymentRecords(await fetchFirstLegPaymentRecords(target.shippingMonth));
    } catch (paymentError) {
      notifyError(getErrorMessage(paymentError, "加载头程付款记录失败"));
      setPaymentRecords([]);
    } finally {
      setLoadingPayments(false);
    }
  }

  async function handleSaveFirstLegActual(target: FirstLegMonthView) {
    const amount = Number(editingFirstLegAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      notifyWarning("请输入大于或等于 0 的实际头程运费");
      return;
    }
    if (!await confirmSave(
      `确认将 ${target.shippingMonth} 的实际头程运费保存为 ${formatPreciseRmb(amount)} 吗？`,
    )) return;

    setSavingFirstLegActual(true);
    try {
      await saveFirstLegMonthlyActual({
        shippingMonth: target.shippingMonth,
        estimatedAmountRmb: target.estimatedAmountRmb,
        actualAmountRmb: amount,
      });
      setEditingFirstLegMonth(null);
      setEditingFirstLegAmount("");
      notifySuccess(`实际头程运费已保存：${formatPreciseRmb(amount)}。`);
      await Promise.all([loadFirstLegData(), onImported()]);
    } catch (saveError) {
      notifyError(getErrorMessage(saveError, "保存实际头程运费失败"));
    } finally {
      setSavingFirstLegActual(false);
    }
  }

  async function handleRecordPayment() {
    if (!paymentTarget) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      notifyWarning("请输入大于 0 的实付金额");
      return;
    }
    if (amount > paymentTarget.outstandingAmountRmb) {
      notifyWarning("实付金额不能超过当前待付金额");
      return;
    }
    if (!paymentDateTime) {
      notifyWarning("请选择实际付款时间");
      return;
    }
    if (!await confirmSave(
      `确认登记 ${paymentTarget.logisticsMethodName} ${paymentTarget.shippingMonth} 发货月付款 ${formatPreciseRmb(amount)} 吗？`,
    )) return;

    setSavingPayment(true);
    try {
      const paymentOptions = {
        shippingMonth: paymentTarget.shippingMonth,
        paidAmountRmb: amount,
        paidAt: new Date(paymentDateTime).toISOString(),
        remark: paymentRemark,
        requestKey: paymentRequestKey || crypto.randomUUID(),
      };
      if (paymentTarget.kind === "first_leg") {
        await recordFirstLegPayment(paymentOptions);
      } else {
        await recordLogisticsPayment({
          logisticsMethodId: paymentTarget.logisticsMethodId,
          ...paymentOptions,
        });
      }
      notifySuccess(`物流付款已登记：${formatPreciseRmb(amount)}。`);
      setPaymentTarget(null);
      await Promise.all([loadReport(), loadFirstLegData(), onImported()]);
    } catch (paymentError) {
      notifyError(getErrorMessage(paymentError, "登记物流付款失败"));
    } finally {
      setSavingPayment(false);
    }
  }

  async function handleVoidPayment(payment: LogisticsPaymentRecord) {
    if (!paymentTarget || !voidReason.trim()) {
      notifyWarning("请先填写作废原因");
      return;
    }
    if (!confirmAction(`确认作废这笔 ${formatPreciseRmb(payment.amountRmb)} 的物流付款吗？`)) return;
    setVoidingPaymentId(payment.id);
    try {
      if (paymentTarget.kind === "first_leg") {
        await voidFirstLegPayment(payment.id, voidReason);
      } else {
        await voidLogisticsPayment(payment.id, voidReason);
      }
      notifySuccess("物流付款记录已作废，待付金额已恢复。");
      setPaymentTarget(null);
      await Promise.all([loadReport(), loadFirstLegData(), onImported()]);
    } catch (voidError) {
      notifyError(getErrorMessage(voidError, "作废物流付款失败"));
    } finally {
      setVoidingPaymentId(null);
    }
  }

  function getMappingDescription(field: ActualShippingFeeWebsiteField) {
    if (!templateEditor) {
      return { isMapped: false, primary: "未绑定", secondary: "" };
    }
    const mapping = getActualShippingFeeFieldMapping(templateEditor.draft, field);
    if (mapping.sourceType === "column") {
      if (!mapping.column) {
        return { isMapped: false, primary: "未绑定", secondary: "请选择右侧表格列" };
      }
      const sampleValue = templateSample?.values.find(
        (cell) => cell.column === mapping.column,
      )?.value ?? "";
      return {
        isMapped: true,
        primary: `${columnNumberToLabel(mapping.column)} 列（第 ${mapping.column} 列）`,
        secondary: sampleValue || "当前样例行为空",
      };
    }

    if (field === "logistics_method") {
      const methodName = logisticsMethods.find(
        (method) => method.id === mapping.fixedValue,
      )?.name ?? "";
      return {
        isMapped: Boolean(methodName),
        primary: methodName ? `固定值：${methodName}` : "固定值未设置",
        secondary: "",
      };
    }
    const fixedValue = String(mapping.fixedValue ?? "").trim();
    return {
      isMapped: fixedValue !== "",
      primary: fixedValue ? `固定值：${fixedValue}` : "固定值未设置",
      secondary: "",
    };
  }

  return (
    <div className="animate-in fade-in space-y-5 duration-300">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">物流商月结运费</h3>
          <p className="mt-1 text-xs text-slate-500">
            仅按物流单号匹配；月份统一取网站订单的实际发货时间，同一物流单号只计算一次。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary h-10 px-4 text-xs"
          onClick={openImportWorkbench}
          disabled={!canEdit || loadingTemplates || logisticsMethods.length === 0}
        >
          <Upload size={16} /> 上传实际运费
        </button>
      </div>

      {templateEditor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="实际运费上传与映射"
        >
          <div className="max-h-[94vh] w-full max-w-7xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4">
              <div>
                <h4 className="text-base font-bold text-slate-900">上传实际运费 · 制作映射模板</h4>
                <p className="mt-1 text-xs text-slate-500">
                  选择表格和开始行后，从右侧真实数据中选择一列，再绑定到左侧网站字段；也可以设置固定值。
                </p>
              </div>
              <button
                type="button"
                className="icon-btn h-8 w-8"
                onClick={closeImportWorkbench}
                disabled={savingTemplate || parsing}
                aria-label="关闭实际运费上传"
              >
                <X size={17} />
              </button>
            </div>

              <div className="space-y-5 p-5">
              <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h5 className="text-sm font-bold text-slate-800">1. 选择模板与上传文件</h5>
                    <p className="mt-1 text-xs text-slate-500">
                      已有模板可直接选择；新格式表格可在这里新建并保存为模板。
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary h-9 px-3 text-xs"
                      onClick={openNewTemplateEditor}
                      disabled={savingTemplate || parsing}
                    >
                      <Plus size={15} /> 新建模板
                    </button>
                    <button
                      type="button"
                      className="icon-btn h-9 w-9 text-rose-600"
                      onClick={() => void handleDeleteTemplate()}
                      disabled={
                        savingTemplate ||
                        parsing ||
                        !selectedTemplate
                      }
                      aria-label="删除当前模板"
                      title="删除当前模板"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                    上传模板
                    <select
                      value={templateEditor.templateId ?? ""}
                      onChange={(event) => handleTemplateChange(event.target.value)}
                      className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                      disabled={loadingTemplates || savingTemplate || parsing}
                    >
                      {!templateEditor.templateId && (
                        <option value="">新模板（尚未保存）</option>
                      )}
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}{template.is_system ? "（自动生成）" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                    模板名称
                    <input
                      value={templateEditor.draft.name}
                      onChange={(event) => updateTemplateDraft({ name: event.target.value })}
                      className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                      disabled={savingTemplate || parsing}
                    />
                  </label>

                  <div className="flex flex-col gap-1 text-xs font-semibold text-slate-600 xl:col-span-2">
                    运费表格
                    <div className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-white pl-3">
                      <FileSpreadsheet size={16} className="shrink-0 text-slate-400" />
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${
                          uploadedFileName ? "text-slate-700" : "text-slate-400"
                        }`}
                        title={uploadedFileName}
                      >
                        {uploadedFileName || "尚未选择 CSV、XLS 或 XLSX 文件"}
                      </span>
                      <label className="btn-secondary mr-1 inline-flex h-8 shrink-0 cursor-pointer items-center px-3 text-xs">
                        {parsing ? "读取中..." : "选择文件"}
                        <input
                          type="file"
                          accept=".csv,.xls,.xlsx"
                          className="hidden"
                          disabled={savingTemplate || parsing || importing}
                          onChange={(event) => void handleSelectFile(event)}
                        />
                      </label>
                    </div>
                  </div>

                  <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                    工作表
                    {uploadedWorkbook ? (
                      <select
                        value={templateEditor.draft.worksheet_name}
                        onChange={(event) => {
                          updateTemplateDraft({ worksheet_name: event.target.value });
                          setSelectedSampleColumn(null);
                        }}
                        className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                        disabled={savingTemplate || parsing}
                      >
                        {templateEditor.draft.worksheet_name &&
                          !uploadedWorkbook.worksheets.some(
                            (worksheet) =>
                              worksheet.name === templateEditor.draft.worksheet_name,
                          ) && (
                            <option value={templateEditor.draft.worksheet_name}>
                              {templateEditor.draft.worksheet_name}（文件中不存在）
                            </option>
                          )}
                        {uploadedWorkbook.worksheets.map((worksheet) => (
                          <option key={worksheet.name} value={worksheet.name}>
                            {worksheet.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={templateEditor.draft.worksheet_name}
                        onChange={(event) =>
                          updateTemplateDraft({ worksheet_name: event.target.value })
                        }
                        placeholder="选择文件后可选择工作表"
                        className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                        disabled={savingTemplate || parsing}
                      />
                    )}
                  </label>

                  <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                    数据开始行
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={templateEditor.draft.start_row}
                      onChange={(event) => {
                        updateTemplateDraft({
                          start_row: Math.max(1, Number(event.target.value) || 1),
                        });
                        setSelectedSampleColumn(null);
                      }}
                      className="h-10 rounded-lg border border-line bg-white px-3 text-sm"
                      disabled={savingTemplate || parsing}
                    />
                  </label>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200">
                <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-3">
                  <h5 className="text-sm font-bold text-slate-800">2. 映射设置</h5>
                  <p className="mt-1 text-xs text-slate-500">
                    先点选左侧网站字段，再点选右侧样例列，最后点击“绑定”。每个网站字段只能绑定一列或一个固定值。
                  </p>
                </div>

                <div className="grid min-h-[430px] lg:grid-cols-[minmax(360px,1.15fr)_180px_minmax(360px,1fr)]">
                  <div className="border-b border-slate-200 lg:border-b-0 lg:border-r">
                    <div className="grid grid-cols-[72px_minmax(130px,0.9fr)_minmax(180px,1.3fr)] bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
                      <div>必填</div>
                      <div>网站字段</div>
                      <div>当前映射内容</div>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {websiteFieldMeta.map((field) => {
                        const description = getMappingDescription(field.key);
                        const isSelected = selectedWebsiteField === field.key;
                        return (
                          <button
                            key={field.key}
                            type="button"
                            className={`grid w-full grid-cols-[72px_minmax(130px,0.9fr)_minmax(180px,1.3fr)] items-center px-3 py-4 text-left transition ${
                              isSelected
                                ? "bg-teal-50 ring-1 ring-inset ring-teal-500"
                                : "bg-white hover:bg-slate-50"
                            }`}
                            onClick={() => selectWebsiteField(field.key)}
                            aria-label={`选择网站字段：${field.label}`}
                          >
                            <div>
                              <span className="rounded bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-600">
                                必填
                              </span>
                            </div>
                            <div className="pr-3 text-sm font-bold text-slate-800">
                              {field.label}
                            </div>
                            <div className="min-w-0">
                              <div
                                className={`truncate text-xs font-bold ${
                                  description.isMapped
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
                      onClick={handleBindSelectedColumn}
                      disabled={!selectedSampleColumn || savingTemplate || parsing}
                    >
                      <Link2 size={15} /> 绑定
                    </button>
                    <button
                      type="button"
                      className="btn-secondary justify-center text-xs"
                      onClick={handleClearSelectedMapping}
                      disabled={savingTemplate || parsing}
                    >
                      <Unlink size={15} /> 解除绑定
                    </button>
                    <button
                      type="button"
                      className="btn-secondary justify-center text-xs"
                      onClick={handleUseFixedValue}
                      disabled={savingTemplate || parsing}
                    >
                      <Pencil size={15} /> 设置固定值
                    </button>

                    {fixedValueField && (
                      <div className="mt-2 rounded-lg border border-teal-200 bg-white p-3">
                        <div className="mb-2 text-xs font-bold text-slate-700">
                          {
                            websiteFieldMeta.find(
                              (field) => field.key === fixedValueField,
                            )?.fixedValueLabel
                          }
                        </div>
                        {fixedValueField === "tracking" && (
                          <input
                            value={templateEditor.draft.tracking_fixed_value}
                            onChange={(event) =>
                              updateTemplateDraft({
                                tracking_fixed_value: event.target.value,
                              })
                            }
                            className="h-9 w-full rounded-lg border border-line px-2 text-sm"
                            placeholder="输入固定物流单号"
                          />
                        )}
                        {fixedValueField === "amount" && (
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={templateEditor.draft.amount_fixed_value ?? ""}
                            onChange={(event) =>
                              updateTemplateDraft({
                                amount_fixed_value:
                                  event.target.value === ""
                                    ? null
                                    : Number(event.target.value),
                              })
                            }
                            className="h-9 w-full rounded-lg border border-line px-2 text-sm"
                            placeholder="输入人民币金额"
                          />
                        )}
                        {fixedValueField === "logistics_method" && (
                          <select
                            value={templateEditor.draft.logistics_method_fixed_id ?? ""}
                            onChange={(event) =>
                              updateTemplateDraft({
                                logistics_method_fixed_id:
                                  event.target.value || null,
                              })
                            }
                            className="h-9 w-full rounded-lg border border-line bg-white px-2 text-sm"
                          >
                            <option value="">请选择网站物流方式</option>
                            {logisticsMethods.map((method) => (
                              <option key={method.id} value={method.id}>
                                {method.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}

                    <button
                      type="button"
                      className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                      onClick={handleClearAllMappings}
                      disabled={savingTemplate || parsing}
                    >
                      <Eraser size={15} /> 全部清除
                    </button>
                  </div>

                  <div className="min-w-0 bg-white">
                    <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="text-xs font-bold text-slate-600">
                        数据摘取（第 {templateEditor.draft.start_row} 行）
                      </div>
                      {selectedSampleColumn && (
                        <div className="text-[11px] font-bold text-teal-700">
                          已选择 {columnNumberToLabel(selectedSampleColumn)} 列
                        </div>
                      )}
                    </div>

                    {!uploadedWorkbook ? (
                      <div className="flex min-h-[370px] items-center justify-center p-6 text-center text-xs text-slate-500">
                        请先在上方选择表格，系统会在这里显示开始行的每一列真实数据。
                      </div>
                    ) : templateSample?.missingWorksheet ? (
                      <div className="flex min-h-[370px] items-center justify-center p-6 text-center text-xs font-semibold text-amber-700">
                        文件中找不到工作表“{templateSample.worksheetName}”，请在上方重新选择工作表。
                      </div>
                    ) : templateSample && templateSample.values.length > 0 ? (
                      <div className="max-h-[390px] overflow-auto p-3">
                        <div className="space-y-2">
                          {templateSample.values.map((cell) => {
                            const mappedFields = websiteFieldMeta.filter((field) => {
                              const mapping = getActualShippingFeeFieldMapping(
                                templateEditor.draft,
                                field.key,
                              );
                              return (
                                mapping.sourceType === "column" &&
                                mapping.column === cell.column
                              );
                            });
                            const isSelected = selectedSampleColumn === cell.column;
                            return (
                              <button
                                key={cell.column}
                                type="button"
                                className={`w-full rounded-lg border p-3 text-left transition ${
                                  isSelected
                                    ? "border-teal-500 bg-teal-50 ring-1 ring-teal-500"
                                    : "border-slate-200 bg-white hover:border-teal-300 hover:bg-teal-50/40"
                                }`}
                                onClick={() => setSelectedSampleColumn(cell.column)}
                                aria-label={`选择表格列 ${columnNumberToLabel(cell.column)}`}
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-bold text-slate-600">
                                    {columnNumberToLabel(cell.column)} 列 · 第 {cell.column} 列
                                  </div>
                                  {mappedFields.length > 0 && (
                                    <div className="rounded bg-sky-50 px-2 py-1 text-[10px] font-bold text-sky-700">
                                      已绑定：{mappedFields.map((field) => field.label).join("、")}
                                    </div>
                                  )}
                                </div>
                                <div
                                  className={`mt-1 break-all text-sm ${
                                    cell.value ? "font-semibold text-slate-800" : "text-slate-400"
                                  }`}
                                >
                                  {cell.value || "（空）"}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-[370px] items-center justify-center p-6 text-center text-xs font-semibold text-amber-700">
                        所选工作表在第 {templateEditor.draft.start_row} 行没有样例数据，请调整工作表或开始行。
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  已完成{" "}
                  <span className="font-bold text-slate-700">
                    {
                      websiteFieldMeta.filter(
                        (field) => getMappingDescription(field.key).isMapped,
                      ).length
                    }
                    /3
                  </span>{" "}
                  个网站字段已映射
                  {uploadedFileName ? ` · 当前文件：${uploadedFileName}` : ""}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={closeImportWorkbench}
                    disabled={savingTemplate || parsing}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void handleSaveTemplate()}
                    disabled={savingTemplate || parsing}
                  >
                    <Check size={16} /> {savingTemplate ? "保存中..." : "仅保存模板"}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void handlePreviewCurrentImport()}
                    disabled={
                      savingTemplate ||
                      parsing ||
                      !uploadedWorkbook ||
                      !uploadedFileName
                    }
                  >
                    <Upload size={16} />
                    {parsing ? "核对中..." : "保存模板并核对导入"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingImport && importStats && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <CheckCircle2 size={17} className="text-sky-600" />
                导入前核对 · {pendingImport.template.name}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {pendingImport.fileName} · 工作表 {pendingImport.parsed.sheetName}
              </p>
            </div>
            <button
              type="button"
              className="icon-btn h-8 w-8"
              onClick={() => setPendingImport(null)}
              disabled={importing}
              aria-label="关闭导入预览"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
            {importStats.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-white bg-white/90 p-3">
                <div className="text-[11px] font-semibold text-slate-500">{label}</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_2fr]">
            <div className="rounded-lg border border-white bg-white/90 p-3">
              <div className="text-xs font-bold text-slate-700">可导入运费合计</div>
              <div className="mt-1 text-xl font-bold text-emerald-700">
                {formatPreciseRmb(pendingImport.preview.importableTotalAmountRmb)}
              </div>
              <div className="mt-3 space-y-1.5 text-xs text-slate-600">
                {pendingImport.preview.months.map((item) => (
                  <div key={item.month || "missing"} className="flex justify-between gap-3">
                    <span>{item.month || "待补实际发货时间"} · {item.shipmentCount}票</span>
                    <span className="font-semibold">{formatPreciseRmb(item.totalAmountRmb)}</span>
                  </div>
                ))}
              </div>
              {pendingImport.preview.missingActualShipTimeCount > 0 && (
                <div className="mt-3 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-700">
                  {pendingImport.preview.missingActualShipTimeCount} 票会保存运费，但暂不归入月份。
                </div>
              )}
            </div>

            <div className="max-h-72 overflow-auto rounded-lg border border-white bg-white/90">
              <table className="w-full min-w-[900px] text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-3 py-2">行</th>
                    <th className="px-3 py-2">物流单号</th>
                    <th className="px-3 py-2">物流方式</th>
                    <th className="px-3 py-2">网站订单号</th>
                    <th className="px-3 py-2">实际发货月份</th>
                    <th className="px-3 py-2 text-right">实际尾程运费</th>
                    <th className="px-3 py-2">处理结果</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingImport.preview.rows.map((row) => {
                    const meta = statusMeta(row.status);
                    return (
                      <tr key={`${row.sourceRowNumber}-${row.trackingNo}`} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-400">{row.sourceRowNumber}</td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-700">{row.trackingNo}</td>
                        <td className="px-3 py-2 font-semibold text-slate-600">{row.logisticsMethodName || "--"}</td>
                        <td className="px-3 py-2 font-mono text-slate-600">{row.orderNo || "--"}</td>
                        <td className="px-3 py-2 text-slate-600">{row.settlementMonth || "待补"}</td>
                        <td className="px-3 py-2 text-right font-bold text-slate-900">{formatPreciseRmb(row.amountRmb)}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-2 py-1 font-bold ${meta.className}`}>{meta.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {pendingImport.parsed.issues.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <div className="font-bold">已排除 {pendingImport.parsed.issues.length} 条异常或汇总行</div>
              <div className="mt-1">{pendingImport.parsed.issues.slice(0, 5).map((issue) => `第${issue.rowNumber}行：${issue.reason}`).join("；")}</div>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setPendingImport(null)} disabled={importing}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleConfirmImport()}
              disabled={importing || pendingImport.preview.importableRecordCount === 0}
            >
              {importing ? "导入中..." : `确认导入 ${pendingImport.preview.importableRecordCount} 票`}
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">当前筛选物流单数</div>
          <div className="mt-1 text-lg font-bold text-slate-900">{report.summary.shipmentCount}</div>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">应付实际尾程运费</div>
          <div className="mt-1 text-lg font-bold text-slate-900">{formatPreciseRmb(report.summary.payableAmountRmb)}</div>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">已支付物流商</div>
          <div className="mt-1 text-lg font-bold text-emerald-700">{formatPreciseRmb(report.summary.paidAmountRmb)}</div>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">待支付物流商</div>
          <div className={`mt-1 text-lg font-bold ${report.summary.outstandingAmountRmb > 0 ? "text-amber-700" : "text-emerald-700"}`}>
            {formatPreciseRmb(report.summary.outstandingAmountRmb)}
          </div>
        </div>
      </div>

      {report.summary.missingActualShipTimeCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
          当前筛选还有 {report.summary.missingActualShipTimeCount} 票待补实际发货时间，补齐后才能归入月份并结算。
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
        <label className="flex min-w-44 flex-col gap-1 text-xs font-semibold text-slate-600">
          结算月份（实际发货月）
          <select value={month} onChange={(event) => setMonth(event.target.value)} className="h-9 rounded-lg border border-line bg-white px-3">
            <option value="">全部月份</option>
            {monthOptions.map((item) => (
              <option key={item.month} value={item.month}>
                {item.month === "__missing__" ? "待补实际发货时间" : item.month} · {item.shipmentCount}票
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-44 flex-col gap-1 text-xs font-semibold text-slate-600">
          物流方式
          <select value={logisticsMethodId} onChange={(event) => setLogisticsMethodId(event.target.value)} className="h-9 rounded-lg border border-line bg-white px-3">
            <option value="">全部物流方式</option>
            {logisticsMethods.map((method) => (
              <option key={method.id} value={method.id}>{method.name}</option>
            ))}
          </select>
        </label>
        <form
          className="flex min-w-64 flex-1 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
            搜索物流单号、订单号或文件名
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className="h-9 rounded-lg border border-line bg-white px-3" />
          </label>
          <button type="submit" className="btn-secondary h-9 px-3"><Search size={15} /> 搜索</button>
        </form>
      </div>

      {month && month !== "__missing__" && selectedFirstLegMonth && (
        <div className="overflow-hidden rounded-xl border border-sky-200 bg-white">
          <div className="flex items-center gap-2 border-b border-sky-100 bg-sky-50 px-4 py-3">
            <WalletCards size={16} className="text-sky-600" />
            <span className="text-sm font-bold text-slate-800">{month} 头程运费合计</span>
            <span className="text-xs text-slate-500">沿用当前头程核算公式</span>
          </div>
          {firstLegLoading ? (
            <div className="p-4 text-sm text-slate-500">加载头程合计中...</div>
          ) : (
            <div className="grid gap-3 px-4 py-4 lg:grid-cols-[repeat(4,minmax(120px,1fr))_auto] lg:items-center">
              <div>
                <div className="text-[11px] font-semibold text-slate-400">系统预估头程</div>
                <div className="mt-1 font-bold text-slate-800">{formatPreciseRmb(selectedFirstLegMonth.estimatedAmountRmb)}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-400">实际头程</div>
                {editingFirstLegMonth === selectedFirstLegMonth.shippingMonth ? (
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={editingFirstLegAmount}
                      onChange={(event) => setEditingFirstLegAmount(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleSaveFirstLegActual(selectedFirstLegMonth);
                        if (event.key === "Escape") {
                          setEditingFirstLegMonth(null);
                          setEditingFirstLegAmount("");
                        }
                      }}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-white px-2 text-sm font-bold outline-none focus:border-accent"
                      aria-label={`${selectedFirstLegMonth.shippingMonth} 实际头程运费`}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="icon-btn h-9 w-9 text-emerald-600"
                      onClick={() => void handleSaveFirstLegActual(selectedFirstLegMonth)}
                      disabled={savingFirstLegActual}
                      aria-label="保存实际头程运费"
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn h-9 w-9 text-slate-400"
                      onClick={() => {
                        setEditingFirstLegMonth(null);
                        setEditingFirstLegAmount("");
                      }}
                      disabled={savingFirstLegActual}
                      aria-label="取消修改实际头程运费"
                    >
                      <X size={15} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="mt-1 inline-flex items-center gap-1.5 font-bold text-sky-700 hover:text-sky-900 disabled:cursor-not-allowed disabled:text-slate-400"
                    onClick={() => {
                      setEditingFirstLegMonth(selectedFirstLegMonth.shippingMonth);
                      setEditingFirstLegAmount(String(
                        selectedFirstLegMonth.actualAmountRmb ?? selectedFirstLegMonth.estimatedAmountRmb,
                      ));
                    }}
                    disabled={!canEdit}
                  >
                    {selectedFirstLegMonth.actualAmountRmb === null
                      ? "点击确认实际金额"
                      : formatPreciseRmb(selectedFirstLegMonth.actualAmountRmb)}
                    {canEdit && <Pencil size={14} />}
                  </button>
                )}
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-400">已付</div>
                <div className="mt-1 font-bold text-emerald-700">{formatPreciseRmb(selectedFirstLegMonth.paidAmountRmb)}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-400">待付</div>
                <div className="mt-1 font-bold text-amber-700">
                  {selectedFirstLegMonth.actualAmountRmb === null
                    ? "--"
                    : formatPreciseRmb(selectedFirstLegMonth.outstandingAmountRmb)}
                </div>
                <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${selectedFirstLegStatusMeta.className}`}>
                  {selectedFirstLegStatusMeta.label}
                </span>
              </div>
              <button
                type="button"
                className={selectedFirstLegMonth.status === "paid" && selectedFirstLegMonth.actualAmountRmb !== null
                  ? "btn-secondary h-9 px-3 text-xs"
                  : "btn-primary h-9 px-3 text-xs"}
                onClick={() => void openFirstLegPaymentDialog(selectedFirstLegMonth)}
                disabled={selectedFirstLegMonth.actualAmountRmb === null || (!canEdit && selectedFirstLegMonth.paidAmountRmb <= 0)}
              >
                {selectedFirstLegMonth.actualAmountRmb === null
                  ? <><WalletCards size={15} /> 先确认实际金额</>
                  : selectedFirstLegMonth.status === "paid"
                    ? <><History size={15} /> 查看记录</>
                    : selectedFirstLegMonth.status === "partial"
                      ? <><WalletCards size={15} /> 继续付款</>
                      : <><WalletCards size={15} /> 登记付款</>}
              </button>
            </div>
          )}
        </div>
      )}

      {month && month !== "__missing__" && report.summary.settlements.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
            <WalletCards size={16} className="text-accent" />
            <span className="text-sm font-bold text-slate-800">{month} 物流商付款状态</span>
          </div>
          <div className="divide-y divide-slate-100">
            {report.summary.settlements.map((settlement) => {
              const meta = settlementStatusMeta(settlement.status);
              return (
                <div key={`${settlement.logisticsMethodId}-${settlement.shippingMonth}`} className="grid gap-3 px-4 py-4 lg:grid-cols-[1.4fr_repeat(4,minmax(110px,1fr))_auto] lg:items-center">
                  <div>
                    <div className="font-bold text-slate-800">{settlement.logisticsMethodName}</div>
                    <div className="mt-1 text-xs text-slate-500">{settlement.shipmentCount} 票 · 实际发货月 {settlement.shippingMonth}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400">应付</div>
                    <div className="mt-1 font-bold text-slate-800">{formatPreciseRmb(settlement.payableAmountRmb)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400">已付</div>
                    <div className="mt-1 font-bold text-emerald-700">{formatPreciseRmb(settlement.paidAmountRmb)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400">待付</div>
                    <div className="mt-1 font-bold text-amber-700">{formatPreciseRmb(settlement.outstandingAmountRmb)}</div>
                  </div>
                  <div>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${meta.className}`}>{meta.label}</span>
                    {settlement.lastPaidAt && <div className="mt-1 text-[11px] text-slate-400">最近 {formatPaymentTime(settlement.lastPaidAt)}</div>}
                  </div>
                  <button
                    type="button"
                    className={settlement.status === "paid" ? "btn-secondary h-9 px-3 text-xs" : "btn-primary h-9 px-3 text-xs"}
                    onClick={() => void openPaymentDialog(settlement)}
                    disabled={!canEdit && settlement.paidAmountRmb <= 0}
                  >
                    {settlement.status === "paid" ? <><History size={15} /> 查看记录</> : settlement.status === "partial" ? <><WalletCards size={15} /> 继续付款</> : <><WalletCards size={15} /> 登记付款</>}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(!month || month === "__missing__") && (
        <div className="rounded-lg border border-sky-100 bg-sky-50/50 px-3 py-2 text-xs font-medium text-sky-700">
          请选择一个具体的实际发货月份，系统会显示当月头程合计和各物流商尾程付款按钮。
        </div>
      )}

      {(error || firstLegError) && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          {error || firstLegError}
        </div>
      )}

      <StandardTable
        minWidth="min-w-max"
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        totalRecordCount={report.totalCount}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        loading={loading}
        empty={!loading && !error && report.rows.length === 0}
        emptyMessage="暂无已导入的实际尾程运费"
      >
        {!loading && report.rows.length > 0 && (
          <>
            <thead>
              <tr>
                <th className="bg-slate-50">实际发货月份</th>
                <th className="bg-slate-50">物流方式</th>
                <th className="bg-slate-50">物流单号</th>
                <th className="bg-slate-50">网站订单号</th>
                <th className="bg-slate-50">实际发货时间</th>
                <th className="number-cell bg-slate-50 px-3 py-2">实际尾程运费</th>
                <th className="bg-slate-50">来源文件</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/50">
                  <td className={row.settlementMonth ? "font-bold text-slate-700" : "font-bold text-amber-700"}>{row.settlementMonth || "待补"}</td>
                  <td className="font-semibold text-slate-700">{row.logisticsMethodName || "--"}</td>
                  <td className="font-mono text-xs font-semibold text-slate-700">{row.trackingNo}</td>
                  <td className="font-mono text-xs text-slate-600">{row.orderNo || "--"}</td>
                  <td className="text-xs text-slate-500">
                    {editingActualShipTimeId === row.id ? (
                      <div className="flex min-w-64 items-center gap-1.5">
                        <input
                          type="datetime-local"
                          step="60"
                          value={editingActualShipTimeValue}
                          onInput={(event) => setEditingActualShipTimeValue(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void handleSaveActualShipTime(row);
                            if (event.key === "Escape") {
                              setEditingActualShipTimeId(null);
                              setEditingActualShipTimeValue("");
                            }
                          }}
                          disabled={savingActualShipTimeId === row.id}
                          className="h-8 min-w-48 rounded-md border border-line bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-accent"
                          aria-label={`补填 ${row.trackingNo} 的实际发货时间`}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="icon-btn h-8 w-8 text-emerald-600"
                          onClick={() => void handleSaveActualShipTime(row)}
                          disabled={savingActualShipTimeId === row.id || !editingActualShipTimeValue}
                          aria-label={`保存 ${row.trackingNo} 的实际发货时间`}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn h-8 w-8 text-slate-400"
                          onClick={() => {
                            setEditingActualShipTimeId(null);
                            setEditingActualShipTimeValue("");
                          }}
                          disabled={savingActualShipTimeId === row.id}
                          aria-label={`取消补填 ${row.trackingNo} 的实际发货时间`}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ) : row.actualShipTime ? (
                      row.actualShipTime
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-amber-700">待补实际发货时间</span>
                        {canEdit && (
                          <button
                            type="button"
                            className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-100"
                            onClick={() => {
                              setEditingActualShipTimeId(row.id);
                              setEditingActualShipTimeValue("");
                            }}
                          >
                            补填
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="number-cell px-3 py-2 font-bold text-emerald-700">{formatPreciseRmb(row.amountRmb)}</td>
                  <td className="max-w-64 truncate text-xs text-slate-500" title={row.sourceFileName}>{row.sourceFileName}</td>
                </tr>
              ))}
            </tbody>
          </>
        )}
      </StandardTable>

      {paymentTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" role="dialog" aria-modal="true" aria-label="物流付款登记">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4">
              <div>
                <h4 className="text-base font-bold text-slate-900">
                  {paymentTarget.kind === "first_leg" ? "头程月结付款" : "物流商月结付款"}
                </h4>
                <p className="mt-1 text-xs text-slate-500">
                  {paymentTarget.logisticsMethodName} · {paymentTarget.shippingMonth} 实际发货月
                  {paymentTarget.kind === "last_leg" && ` · ${paymentTarget.shipmentCount}票`}
                </p>
              </div>
              <button type="button" className="icon-btn h-8 w-8" onClick={() => setPaymentTarget(null)} disabled={savingPayment || Boolean(voidingPaymentId)} aria-label="关闭付款窗口">
                <X size={17} />
              </button>
            </div>

            <div className="space-y-5 p-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-500">应付金额</div>
                  <div className="mt-1 text-lg font-bold text-slate-900">{formatPreciseRmb(paymentTarget.payableAmountRmb)}</div>
                </div>
                <div className="rounded-lg bg-emerald-50 p-3">
                  <div className="text-xs font-semibold text-emerald-700">已付金额</div>
                  <div className="mt-1 text-lg font-bold text-emerald-700">{formatPreciseRmb(paymentTarget.paidAmountRmb)}</div>
                </div>
                <div className="rounded-lg bg-amber-50 p-3">
                  <div className="text-xs font-semibold text-amber-700">待付金额</div>
                  <div className="mt-1 text-lg font-bold text-amber-700">{formatPreciseRmb(paymentTarget.outstandingAmountRmb)}</div>
                </div>
              </div>

              {canEdit && paymentTarget.outstandingAmountRmb > 0 && (
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 text-sm font-bold text-slate-800">登记本次付款</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                      本次实付金额
                      <input
                        type="number"
                        min="0.001"
                        step="0.001"
                        max={paymentTarget.outstandingAmountRmb}
                        value={paymentAmount}
                        onChange={(event) => setPaymentAmount(event.target.value)}
                        className="h-10 rounded-lg border border-line bg-white px-3 text-sm font-bold outline-none focus:border-accent"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                      实际付款时间
                      <input
                        type="datetime-local"
                        step="60"
                        value={paymentDateTime}
                        onChange={(event) => setPaymentDateTime(event.target.value)}
                        className="h-10 rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-accent"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600 sm:col-span-2">
                      付款备注（选填）
                      <input
                        value={paymentRemark}
                        onChange={(event) => setPaymentRemark(event.target.value)}
                        placeholder="例如：银行转账、付款批次或凭证编号"
                        className="h-10 rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-accent"
                      />
                    </label>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <button type="button" className="btn-primary" onClick={() => void handleRecordPayment()} disabled={savingPayment}>
                      <WalletCards size={16} /> {savingPayment ? "登记中..." : "确认登记付款"}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><History size={16} />付款记录</div>
                {loadingPayments ? (
                  <div className="rounded-lg bg-slate-50 p-4 text-center text-sm text-slate-500">加载中...</div>
                ) : paymentRecords.length === 0 ? (
                  <div className="rounded-lg bg-slate-50 p-4 text-center text-sm text-slate-500">暂无付款记录</div>
                ) : (
                  <div className="space-y-2">
                    {paymentRecords.map((payment) => (
                      <div key={payment.id} className={`rounded-lg border p-3 ${payment.voidedAt ? "border-slate-200 bg-slate-50 opacity-70" : "border-slate-200 bg-white"}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className={`font-bold ${payment.voidedAt ? "text-slate-500 line-through" : "text-emerald-700"}`}>{formatPreciseRmb(payment.amountRmb)}</div>
                            <div className="mt-1 text-xs text-slate-500">付款时间：{formatPaymentTime(payment.paidAt)}</div>
                            {payment.remark && <div className="mt-1 text-xs text-slate-500">备注：{payment.remark}</div>}
                            {payment.voidedAt && <div className="mt-1 text-xs font-semibold text-rose-600">已作废：{payment.voidReason}</div>}
                          </div>
                          {canEdit && !payment.voidedAt && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-xs font-bold text-rose-600 hover:text-rose-800"
                              onClick={() => void handleVoidPayment(payment)}
                              disabled={voidingPaymentId === payment.id}
                            >
                              <Ban size={14} /> {voidingPaymentId === payment.id ? "作废中..." : "作废"}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {canEdit && paymentRecords.some((payment) => !payment.voidedAt) && (
                  <label className="mt-3 flex flex-col gap-1 text-xs font-semibold text-slate-600">
                    作废原因（点击某条记录的“作废”前填写）
                    <input
                      value={voidReason}
                      onChange={(event) => setVoidReason(event.target.value)}
                      placeholder="必须填写，作废后记录仍会保留"
                      className="h-9 rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-accent"
                    />
                  </label>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
