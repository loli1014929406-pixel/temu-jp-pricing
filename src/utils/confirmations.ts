import { showConfirm } from "../components/ui/confirm-modal";

export async function confirmSave(message = "确认保存本次修改吗？") {
  return await showConfirm(message, "保存确认");
}

export async function confirmCancelEdit(message = "确认取消本次修改吗？未保存的内容将不会保留。") {
  return await showConfirm(message, "取消确认");
}

export async function confirmDelete(target: string) {
  const firstConfirmed = await showConfirm(`确认删除${target}吗？`, "删除确认");
  if (!firstConfirmed) return false;

  return await showConfirm("再次确认：删除后不可恢复，确定继续删除吗？", "危险操作确认");
}

export async function confirmAction(message: string) {
  return await showConfirm(message, "操作确认");
}
