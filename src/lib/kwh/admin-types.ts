import type { Category, PaymentStatus, ProductionStatus } from "./types";

export interface EventInfo {
  id: string;
  name: string;
  status: "active" | "completed" | "archived";
  created_at: string;
  ended_at: string | null;
  orders_issued: number;
}

export interface FullReport {
  event: EventInfo;
  totals: {
    active_orders: number;
    active_revenue: number;
    paid_total: number;
    debt_total: number;
    orders_paid: number;
    orders_unpaid: number;
    cancelled_orders: number;
    cancelled_value: number;
    items_sold: number;
  };
  products: { product_name: string; quantity: number; revenue: number }[];
  cancelled: {
    queue_number: string;
    customer_name: string;
    customer_class: string;
    total_amount: number;
    cancel_reason: string;
    cancelled_at: string;
    cancelled_by_role: string;
  }[];
  reconciliation: {
    reconciled: boolean;
    active_revenue: number;
    paid_plus_debt: number;
    difference: number;
    items_total: number;
    ledger_net_paid: number;
    issues: {
      queue_number: string;
      issue: string;
      payment_status: PaymentStatus;
      total_amount: number;
      items_sum: number;
      ledger_net: number;
    }[];
  };
  by_category: { category: Category; items: number; revenue: number }[];
  by_hour: { hour: string; orders: number; revenue: number }[];
  cancel_reasons: { reason: string; count: number }[];
  reversals: { queue_number: string; amount: number; note: string; recorded_by_role: string; created_at: string }[];
  expenses: {
    total_modal: number;
    reimbursed_total: number;
    remaining_total: number;
    voided_count: number;
    entries_count: number;
    by_worker: { worker_name: string; total: number; reimbursed: number; remaining: number }[];
  };
  profit: { net: number; margin_pct: number | null; paid_pct: number | null; avg_order: number };
  period: { first_order_at: string | null; last_order_at: string | null };
  cash: { counted_amount: number; system_amount: number; difference: number; note: string | null; counted_at: string } | null;
}

export type ExpenseCategory = "bahan" | "kemasan" | "transport" | "peralatan" | "lainnya";
export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: "bahan", label: "Bahan" },
  { value: "kemasan", label: "Kemasan" },
  { value: "transport", label: "Transport" },
  { value: "peralatan", label: "Peralatan" },
  { value: "lainnya", label: "Lainnya" },
];

export interface Expense {
  id: string;
  event_id: string;
  worker_name: string;
  item: string;
  category: ExpenseCategory;
  amount: number;
  receipt_no: string | null;
  spent_on: string;
  reimbursed: boolean;
  reimbursed_at: string | null;
  voided: boolean;
  void_reason: string | null;
  created_at: string;
}

export interface AdminOrder {
  id: string;
  queue_number: string;
  customer_name: string;
  customer_class: string;
  total_amount: number;
  payment_status: PaymentStatus;
  production_status: ProductionStatus;
  created_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  cancelled_by_role: string | null;
  cancel_reason: string | null;
  items: { product_name: string; unit_price: number; quantity: number; subtotal: number }[];
}

export interface EventListItem {
  event: EventInfo;
  totals: FullReport["totals"];
  reconciled: boolean;
}
