import { useEffect, useState } from 'react'
import { Pagination, Table } from '@company/ui'
import { listOrders } from './api'

/** 现有实现：分页参数在代码里定死了，PRD 不用再问 */
const PAGE_SIZE = 20
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const ORDER_STATUS = ['待支付', '已支付', '已发货', '已取消']

export function OrderListPage() {
  const [pageNo, setPageNo] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [rows, setRows] = useState<Order[]>([])

  useEffect(() => {
    void listOrders({ pageNo, pageSize }).then((data) => setRows(data.list))
  }, [pageNo, pageSize])

  return (
    <>
      <Table
        columns={[
          { key: 'orderNo', title: '订单号', maxLength: 32 },
          { key: 'customerName', title: '客户名称' },
          { key: 'amount', title: '订单金额', unit: '元' },
          { key: 'status', title: '订单状态', options: ORDER_STATUS },
          { key: 'createdAt', title: '下单时间' },
          { key: 'remark', title: '备注', maxLength: 200 },
        ]}
        dataSource={rows}
      />
      <Pagination
        current={pageNo}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        showSizeChanger
        total={rows.length}
        onChange={(next, size) => {
          setPageNo(next)
          setPageSize(size)
        }}
      />
    </>
  )
}

interface Order {
  orderNo: string
  customerName: string
  amount: number
  status: string
  createdAt: string
  remark?: string
}
