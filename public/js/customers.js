// Customer helpers: phone cleaning + lookups. Customers are stored on the server, keyed by phone number.
import * as api from './api.js';

/** "+91 98765-43210" -> "9876543210"; returns null when it is not a valid 10-digit Indian mobile number. */
export function normPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** -> customer {phone, name, visits, totalSpent, ...} or null when this number is new (or the server is unreachable). */
export const findCustomer = (phone) => api.lookupCustomer(phone).catch(() => null);
export const listCustomers = api.listCustomers;
