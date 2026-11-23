import type { GenerateInput } from '../shared/types'
import customerForm from '../samples/customer-form.prd.md?raw'
import orderList from '../samples/order-list.prd.md?raw'
import stockBoard from '../samples/stock-board.prd.md?raw'

export interface Sample {
  id: string
  prd: string
}

/** 只给演示直链用：?sample=order-list&autorun=1 */
export const SAMPLES: Sample[] = [
  { id: 'order-list', prd: orderList },
  { id: 'customer-form', prd: customerForm },
  { id: 'stock-board', prd: stockBoard },
]

export const DEFAULT_INPUT: GenerateInput = {
  prd: '',
  stack: 'react',
  uiLib: '@company/ui',
}
