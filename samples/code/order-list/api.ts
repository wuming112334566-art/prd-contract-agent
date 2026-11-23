export function listOrders(params: { pageNo: number; pageSize: number }) {
  return request<{ list: Array<Record<string, unknown>>; total: number }>('/api/order/list', { params })
}

export function exportOrders(params: { orderNo?: string; status?: string }) {
  return request<{ taskId: string }>('/api/order/export', { method: 'POST', data: params })
}

function request<T>(path: string, init?: { method?: string; params?: unknown; data?: unknown }): Promise<T> {
  const query = init?.params ? `?${new URLSearchParams(init.params as Record<string, string>)}` : ''
  return fetch(`${path}${query}`, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.data ? JSON.stringify(init.data) : undefined,
  }).then((response) => response.json() as Promise<T>)
}
