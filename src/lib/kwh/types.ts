export type Category = "makanan" | "minuman" | "snack" | "lainnya";
export type PaymentStatus = "unpaid" | "paid";
export type ProductionStatus =
  | "waiting"
  | "processing"
  | "ready"
  | "completed"
  | "cancelled";

export interface ActiveEvent {
  id: string;
  name: string;
  status: string;
  accepting_orders: boolean;
}

/** Only statuses: what the live ticket polls (needs the order's secret id). */
export interface TicketStatus {
  queue_number: string;
  payment_status: PaymentStatus;
  production_status: ProductionStatus;
}

/** Public pickup screen: queue numbers only. */
export interface PickupBoardData {
  event_name: string;
  preparing: string[];
  ready: string[];
}

export interface Product {
  id: string;
  name: string;
  category: Category;
  price: number;
  available: boolean;
}

export interface TicketItem {
  product_name: string;
  unit_price: number;
  quantity: number;
  subtotal: number;
}

/** Order as returned to customers by create_customer_order (server-authoritative). */
export interface Ticket {
  id: string;
  queue_number: string;
  queue_seq: number;
  customer_name: string;
  customer_class: string;
  order_type: string;
  total_amount: number;
  payment_status: PaymentStatus;
  production_status: ProductionStatus;
  created_at: string;
  items: TicketItem[];
}

export interface CreateOrderResponse {
  replayed: boolean;
  event_name: string;
  order: Ticket;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  makanan: "Makanan",
  minuman: "Minuman",
  snack: "Snack",
  lainnya: "Lainnya",
};

export const CATEGORY_ORDER: Category[] = [
  "makanan",
  "minuman",
  "snack",
  "lainnya",
];

export const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  unpaid: "BELUM DIBAYAR",
  paid: "SUDAH DIBAYAR",
};

export const PRODUCTION_LABELS: Record<ProductionStatus, string> = {
  waiting: "MENUNGGU",
  processing: "DIPROSES",
  ready: "SIAP DIAMBIL",
  completed: "SELESAI",
  cancelled: "DIBATALKAN",
};
