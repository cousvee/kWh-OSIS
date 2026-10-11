/**
 * Server functions raise short error codes (e.g. "NO_ACTIVE_EVENT").
 * Raw database errors are never shown to customers: everything is mapped
 * to a human-readable Indonesian message here.
 */
export class KwhError extends Error {
  code: string;
  detail?: string;
  constructor(code: string, detail?: string) {
    super(code);
    this.name = "KwhError";
    this.code = code;
    this.detail = detail;
  }
}

const MESSAGES: Record<string, string> = {
  NO_ACTIVE_EVENT: "Belum ada acara yang sedang berlangsung. Silakan hubungi panitia.",
  EVENT_CLOSED: "Acara sudah ditutup. Pesanan tidak bisa dibuat lagi.",
  EMPTY_CART: "Keranjang masih kosong. Pilih menu terlebih dahulu.",
  INVALID_CUSTOMER_NAME: "Nama wajib diisi (maksimal 60 karakter).",
  INVALID_CUSTOMER_CLASS: "Kelas wajib diisi (maksimal 20 karakter).",
  INVALID_QUANTITY: "Jumlah tidak valid. Pilih 1 sampai 99 untuk setiap menu.",
  INVALID_ITEMS: "Ada menu yang tidak valid. Muat ulang halaman lalu coba lagi.",
  PRODUCT_NOT_FOUND: "Ada menu yang sudah tidak ada. Menu sudah diperbarui, silakan periksa pesanan Anda.",
  INVALID_REQUEST: "Permintaan tidak valid. Muat ulang halaman lalu coba lagi.",
  INVALID_CREDENTIALS: "Peran atau passcode salah.",
  TOO_MANY_ATTEMPTS: "Terlalu banyak percobaan gagal. Tunggu beberapa menit lalu coba lagi.",
  SESSION_INVALID: "Sesi tidak valid. Silakan masuk kembali.",
  SESSION_EXPIRED: "Sesi sudah berakhir. Silakan masuk kembali.",
  FORBIDDEN: "Anda tidak punya izin untuk tindakan ini.",
  PASSCODE_CHANGE_REQUIRED: "Anda harus mengganti passcode sementara terlebih dahulu.",
  PASSCODE_INVALID: "Passcode baru harus 6 sampai 72 karakter.",
  INVALID_CURRENT_PASSCODE: "Passcode saat ini salah.",
  PASSCODE_SAME: "Passcode baru tidak boleh sama dengan yang lama.",
  ORDER_NOT_FOUND: "Pesanan tidak ditemukan.",
  ORDER_CANCELLED: "Pesanan ini sudah dibatalkan.",
  INVALID_TRANSITION: "Status pesanan sudah berubah. Daftar diperbarui.",
  INVALID_STATUS: "Status tidak valid.",
  REASON_REQUIRED: "Alasan pembatalan wajib diisi (minimal 3 karakter).",
  ORDER_PAID_REVERSE_FIRST: "Pesanan sudah dibayar. Admin harus membatalkan pembayaran dulu.",
  NETWORK:
    "Koneksi bermasalah. Periksa internet Anda lalu tekan BUAT PESANAN lagi. Pesanan tidak akan terkirim dua kali.",
  CONFIG: "Aplikasi belum dikonfigurasi dengan benar. Silakan hubungi panitia.",
  UNKNOWN: "Terjadi kesalahan di server. Silakan coba lagi sebentar lagi.",
};

export function messageFor(err: unknown): string {
  const e = err instanceof KwhError ? err : new KwhError("UNKNOWN");
  if (e.code === "PRODUCT_UNAVAILABLE") {
    return e.detail
      ? `Maaf, ${e.detail} baru saja habis. Menu sudah diperbarui.`
      : "Maaf, ada menu yang baru saja habis. Menu sudah diperbarui.";
  }
  return MESSAGES[e.code] ?? MESSAGES.UNKNOWN;
}
