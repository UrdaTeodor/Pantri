// Online product lookup by barcode: Open Food Facts, then its sister databases for non-food items.

import { lookupVariants } from './codes.js';

const SOURCES = [
  ['Open Food Facts', 'https://world.openfoodfacts.org'],
  ['Open Products Facts', 'https://world.openproductsfacts.org'],
  ['Open Beauty Facts', 'https://world.openbeautyfacts.org'],
];
const FIELDS = 'product_name,product_name_en,generic_name,brands,quantity,image_front_small_url,image_small_url,categories_tags';

async function fetchOne(base, code, signal) {
  const res = await fetch(`${base}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const p = j.status === 1 && j.product;
  if (!p) return null;
  const name = (p.product_name || p.product_name_en || p.generic_name || '').trim();
  const brand = (p.brands || '').split(',')[0].trim();
  if (!name && !brand) return null;
  return {
    name,
    brand,
    size: (p.quantity || '').trim(),
    imageUrl: p.image_front_small_url || p.image_small_url || '',
    categories: p.categories_tags || [],
  };
}

/**
 * Look a barcode up online. Resolves to { name, brand, size, imageUrl, categories, source } or null
 * when no database knows it. Rejects when every request failed (offline, timeouts).
 */
export async function lookupProduct(code, { timeout = 7000 } = {}) {
  for (const variant of lookupVariants(code)) {
    const signal = AbortSignal.timeout(timeout);
    const results = await Promise.allSettled(
      SOURCES.map(([source, base]) => fetchOne(base, variant, signal).then(r => r && { ...r, source })),
    );
    const hit = results.find(r => r.status === 'fulfilled' && r.value);
    if (hit) return hit.value;
    if (results.every(r => r.status === 'rejected')) throw new Error('Lookup failed — are you offline?');
  }
  return null;
}

const HINTS = [
  [/coffee|tea|infusion/, /coffee|tea/i],
  [/milk|dair|yogurt|yoghurt|cheese|butter|cream/, /dairy|fridge/i],
  [/water|beverage|drink|juice|soda/, /drink/i],
  [/snack|chip|crisp|biscuit|cookie|chocolate|candy|confection|cereal-bar|nut/, /snack/i],
  [/fruit/, /fruit/i],
  [/clean|detergent|dishwash|soap|disinfect/, /clean/i],
  [/paper|tissue|napkin|towel|cup|plate/, /paper|dispos/i],
];

/** Pick one of the user's categories from Open Food Facts category tags, if any obviously fits. */
export function guessCategory(tags, categories) {
  const t = (tags || []).join(' ');
  for (const [re, name] of HINTS) {
    if (re.test(t)) {
      const c = categories.find(c => name.test(c.name));
      if (c) return c.id;
    }
  }
  return null;
}
