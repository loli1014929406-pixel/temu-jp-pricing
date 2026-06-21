export function confirmSave(message = "确认保存本次修改吗？") {
  return window.confirm(message);
}

export function confirmCancelEdit(message = "确认取消本次修改吗？未保存的内容将不会保留。") {
  return window.confirm(message);
}

export function confirmDelete(target: string) {
  const firstConfirmed = window.confirm(`确认删除${target}吗？`);
  if (!firstConfirmed) return false;

  return window.confirm("再次确认：删除后不可恢复，确定继续删除吗？");
}

export function confirmAction(message: string) {
  return window.confirm(message);
}
