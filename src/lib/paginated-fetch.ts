export type PageFetchResult<T, TError = unknown> = {
  data: T[] | null;
  error: TError | null;
};

export type FetchAllPagesOptions = {
  pageSize?: number;
};

const defaultPageSize = 1000;

/**
 * Reads every row from a range-based API without relying on the backend's
 * single-request row limit. The page callback must use a deterministic order.
 */
export async function fetchAllPages<T, TError = unknown>(
  fetchPage: (from: number, to: number) => PromiseLike<PageFetchResult<T, TError>>,
  options: FetchAllPagesOptions = {},
): Promise<PageFetchResult<T, TError>> {
  const pageSize = options.pageSize ?? defaultPageSize;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) return { data: null, error: result.error };

    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}
