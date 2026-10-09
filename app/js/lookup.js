// Online product lookup by barcode: Open Food Facts, then its sister databases for non-food items.
// Food also comes with its nutrition facts.

import { lookupVariants } from './codes.js';

const SOURCES = [
  ['Open Food Facts', 'https://world.openfoodfacts.org'],
  ['Open Products Facts', 'https://world.openproductsfacts.org'],
  ['Open Beauty Facts', 'https://world.openbeautyfacts.org'],
];
const FIELDS = [
  'product_name', 'product_name_en', 'generic_name', 'brands', 'quantity', 'image_front_small_url', 'image_small_url',
  'categories_tags', 'nutriments', 'nutriscore_grade', 'nova_group', 'serving_size', 'ingredients_text',
  'ingredients_text_en', 'allergens_tags',
].join(',');

// Our name → the Open Food Facts nutriment, per 100 g (or 100 ml).
const NUTRIENTS = [
  ['kcal', 'energy-kcal'], ['kj', 'energy-kj'], ['fat', 'fat'], ['saturated', 'saturated-fat'], ['carbs', 'carbohydrates'],
  ['sugars', 'sugars'], ['fiber', 'fiber'], ['protein', 'proteins'], ['salt', 'salt'],
];

const tagText = t => String(t).replace(/^[a-z]{2}:/, '').replace(/-/g, ' ');

/**
 * The nutrition facts of an Open Food Facts product, or null when it has none: { per: 'g' | 'ml',
 * per100: { kcal, kj, fat, saturated, carbs, sugars, fiber, protein, salt } (those known), nutriScore
 * ('a'–'e' | null), nova (1–4 | null), serving, ingredients, allergens: [..], source, fetchedAt }.
 */
export function nutritionOf(p, source = 'Open Food Facts', now = Date.now()) {
  const n = (p && p.nutriments) || {};
  const per100 = {};
  for (const [key, name] of NUTRIENTS) {
    const raw = n[`${name}_100g`];
    const v = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0) per100[key] = Math.round(v * 100) / 100;
  }
  if (per100.kcal === undefined && per100.kj !== undefined) per100.kcal = Math.round(per100.kj / 4.184);
  const grade = String(p.nutriscore_grade || '').toLowerCase();
  const nova = Number(p.nova_group);
  const ingredients = String(p.ingredients_text || p.ingredients_text_en || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  const allergens = [...new Set((p.allergens_tags || []).map(tagText).filter(Boolean))].slice(0, 20);
  const nutriScore = /^[a-e]$/.test(grade) ? grade : null;
  if (!Object.keys(per100).length && !nutriScore && !ingredients && !allergens.length) return null;
  return {
    per: /\d\s*(ml|cl|dl|l)\b/i.test(String(p.quantity || '')) ? 'ml' : 'g',
    per100,
    nutriScore,
    nova: nova >= 1 && nova <= 4 ? nova : null,
    serving: String(p.serving_size || '').trim().slice(0, 40),
    ingredients,
    allergens,
    source,
    fetchedAt: now,
  };
}

async function fetchOne(base, code, signal, source) {
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
    nutrition: nutritionOf(p, source),
  };
}

/**
 * Look a barcode up online. Resolves to { name, brand, size, imageUrl, categories, nutrition, source }
 * or null when no database knows it. Rejects when every request failed (offline, timeouts).
 */
export async function lookupProduct(code, { timeout = 7000 } = {}) {
  for (const variant of lookupVariants(code)) {
    const signal = AbortSignal.timeout(timeout);
    const results = await Promise.allSettled(
      SOURCES.map(([source, base]) => fetchOne(base, variant, signal, source).then(r => r && { ...r, source })),
    );
    const hit = results.find(r => r.status === 'fulfilled' && r.value);
    if (hit) return hit.value;
    if (results.every(r => r.status === 'rejected')) throw new Error('Lookup failed — are you offline?');
  }
  return null;
}

/** The nutrition facts for a product's barcodes (the first that has some), or null. Rejects when offline. */
export async function lookupNutrition(codes) {
  let reached = false;
  let failure = null;
  for (const code of codes) {
    try {
      const r = await lookupProduct(code);
      reached = true;
      if (r && r.nutrition) return r.nutrition;
    } catch (e) {
      failure = e;
    }
  }
  if (!reached && failure) throw failure;
  return null;
}

// Words in Open Food Facts category tags -> which of the user's categories they suggest.
const HINTS = [
  [['coffee', 'coffees', 'tea', 'teas', 'infusion', 'infusions', 'espresso'], /coffee|tea/i],
  [['milk', 'milks', 'dairy', 'dairies', 'yogurt', 'yogurts', 'yoghurt', 'yoghurts', 'cheese', 'cheeses', 'butter', 'butters', 'cream', 'creams'], /dairy|fridge/i],
  [['water', 'waters', 'beverage', 'beverages', 'drink', 'drinks', 'juice', 'juices', 'soda', 'sodas', 'colas'], /drink/i],
  [['snack', 'snacks', 'chips', 'crisps', 'biscuit', 'biscuits', 'cookie', 'cookies', 'chocolate', 'chocolates', 'candy', 'candies', 'confectioneries', 'bars', 'nuts', 'crackers'], /snack/i],
  [['fruit', 'fruits', 'apples', 'bananas'], /fruit/i],
  [['detergent', 'detergents', 'cleaner', 'cleaners', 'dishwashing', 'soap', 'soaps', 'disinfectants'], /clean/i],
  [['paper', 'papers', 'tissues', 'napkins', 'towels', 'cups', 'plates'], /paper|dispos/i],
];
const UMBRELLA = /and-beverages|beverages-and|foods-and|-and-their-products/;

/**
 * Pick one of the user's categories from Open Food Facts category tags. Tags run from general to
 * specific, so the most specific tag wins, and its last word (the noun: "milk-chocolates") counts first.
 */
export function guessCategory(tags, categories) {
  const list = (tags || []).map(t => String(t).replace(/^[a-z]{2}:/, '')).filter(t => !UMBRELLA.test(t)).reverse();
  const pick = word => {
    for (const [words, name] of HINTS) {
      if (words.includes(word)) {
        const c = categories.find(x => name.test(x.name));
        if (c) return c.id;
      }
    }
    return null;
  };
  for (const tag of list) {
    const hit = pick(tag.split('-').pop());
    if (hit) return hit;
  }
  for (const tag of list) {
    for (const word of tag.split('-')) {
      const hit = pick(word);
      if (hit) return hit;
    }
  }
  return null;
}
