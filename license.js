/**
 * M3 POS License Manager
 * 
 * Core functionality is licensed under AGPL-3.0
 * Premium features require a valid subscription license
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LICENSE_FILE = path.join(process.cwd(), 'data', 'license.json');

const PREMIUM_FEATURES = new Set([
  'ai_scan',           // AI catalog scanning
  'voice_ordering',    // Voice ordering
  'whatsapp_announce', // WhatsApp announcements
  'whatsapp_payment',  // Payment screenshot handling
  'cloud_sync',        // Cloud synchronization
  'multi_store',       // Multi-store management
]);

let cachedLicense = null;

export function loadLicense() {
  if (cachedLicense) return cachedLicense;
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      cachedLicense = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    } else {
      cachedLicense = { type: 'community', features: [], valid: true };
    }
  } catch {
    cachedLicense = { type: 'community', features: [], valid: true };
  }
  return cachedLicense;
}

export function hasFeature(feature) {
  const license = loadLicense();
  if (!license.valid) return false;
  if (license.type === 'commercial' || license.type === 'enterprise') {
    return true; // All features included
  }
  if (license.type === 'pro') {
    return license.features?.includes(feature) || PREMIUM_FEATURES.has(feature) && license.features?.includes('*');
  }
  // Community/AGPL edition - only core features
  if (license.type === 'community' || !license.type) {
    // Core features are always free
    const coreFeatures = new Set(['billing', 'products', 'customers', 'receipts', 'inventory']);
    if (coreFeatures.has(feature)) return true;
    return false; // Premium features locked in community edition
  }
  return false;
}

export function requireFeature(feature) {
  if (!hasFeature(feature)) {
    throw new Error(`Feature '${feature}' requires a M3 POS Pro subscription. Visit https://m3pos.app/pricing for details.`);
  }
}

export function getLicenseInfo() {
  const license = loadLicense();
  return {
    type: license.type || 'community',
    valid: license.valid !== false,
    features: license.features || [],
    expiresAt: license.expiresAt || null,
    customerId: license.customerId ? license.customerId.substring(0, 8) + '...' : null
  };
}

export function setLicense(licenseData) {
  try {
    const dir = path.dirname(LICENSE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2));
    cachedLicense = null;
    return true;
  } catch (e) {
    console.error('Failed to save license:', e.message);
    return false;
  }
}
