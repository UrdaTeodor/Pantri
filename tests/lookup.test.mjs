// Turning an Open Food Facts product into what Pantri keeps: nutrition facts and a category guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nutritionOf, guessCategory, englishIngredients, NUTRITION_VERSION } from '../app/js/lookup.js';

const NOW = Date.UTC(2026, 9, 12);

test('nutrition facts per 100 g, rounded, with Nutri-Score, NOVA, allergens and ingredients', () => {
  const n = nutritionOf({
    quantity: '150 g',
    nutriments: {
      'energy-kcal_100g': 536, 'energy-kj_100g': 2243, fat_100g: 34.6, 'saturated-fat_100g': 3.1234,
      carbohydrates_100g: '49', sugars_100g: 0.6, fiber_100g: 4.4, proteins_100g: 6.6, salt_100g: 1.29, 'nova-group': 4,
    },
    nutriscore_grade: 'D',
    nova_group: '4',
    serving_size: '30 g',
    ingredients_text: 'Potatoes,   sunflower oil,\n salt.',
    allergens_tags: ['en:milk', 'en:gluten', 'en:milk'],
  }, 'Open Food Facts', NOW);
  assert.deepEqual(n, {
    v: NUTRITION_VERSION,
    per: 'g',
    per100: { kcal: 536, kj: 2243, fat: 34.6, saturated: 3.12, carbs: 49, sugars: 0.6, fiber: 4.4, protein: 6.6, salt: 1.29 },
    nutriScore: 'd',
    nova: 4,
    serving: '30 g',
    ingredients: 'Potatoes, sunflower oil, salt.',
    lang: null, // not known: shown as it is
    allergens: ['milk', 'gluten'],
    source: 'Open Food Facts',
    fetchedAt: NOW,
  });
});

test('ingredients in English: the English text, else the ingredient list when every item is known, else none yet', () => {
  const ru = {
    lang: 'ru',
    serving_size: '30 г',
    ingredients_text: 'Вода, сахар, диоксид углерода, краситель (сахарный колер IV), регулятор кислотности (ортофосфорная кислота).',
    ingredients: [
      { id: 'en:water', text: 'Вода' }, { id: 'en:sugar', text: 'сахар', percent: 10.6 }, { id: 'en:carbon-dioxide', text: 'диоксид углерода' },
      { id: 'en:colour', text: 'краситель', ingredients: [{ id: 'en:e150d', text: 'сахарный колер IV' }] },
      { id: 'en:acidity-regulator', text: 'регулятор кислотности', ingredients: [{ id: 'en:e338', text: 'ортофосфорная кислота' }] },
    ],
    allergens_tags: [],
  };
  const fromList = nutritionOf(ru);
  assert.equal(fromList.lang, 'ru');
  assert.equal(fromList.serving, '30 g');
  assert.equal(fromList.ingredients, ru.ingredients_text);
  assert.equal(fromList.ingredientsEn, 'Water, sugar 10.6%, carbon dioxide, colour (E150d), acidity regulator (E338)');

  const unknown = { ...ru, ingredients: [...ru.ingredients, { id: 'ru:что-то-ещё', text: 'что-то ещё' }] };
  assert.equal(nutritionOf(unknown).ingredientsEn, undefined); // to be translated
  assert.equal(englishIngredients(unknown.ingredients), null);

  const english = { ...unknown, ingredients_text_en: 'Water, sugar, carbon dioxide, colour (caramel IV), acidity regulator (phosphoric acid).' };
  assert.equal(nutritionOf(english).ingredientsEn, english.ingredients_text_en);

  const onlyEnglish = nutritionOf({ lang: 'fr', ingredients_text_en: 'Water, salt.' });
  assert.deepEqual([onlyEnglish.ingredients, onlyEnglish.lang, onlyEnglish.ingredientsEn], ['Water, salt.', 'en', 'Water, salt.']);
  assert.equal(nutritionOf({ lang: 'en', ingredients_text: 'Water, salt.' }).ingredientsEn, 'Water, salt.');
});

test('drinks are per 100 ml; energy from kJ when kcal is missing; nothing known means null', () => {
  const n = nutritionOf({ quantity: '0,5 L', nutriments: { 'energy-kj_100g': 180, sugars_100g: 10.6 } });
  assert.equal(n.per, 'ml');
  assert.deepEqual(n.per100, { kj: 180, kcal: 43, sugars: 10.6 });
  assert.equal(n.nutriScore, null);
  assert.equal(nutritionOf({ quantity: '330 ml' }), null);
  assert.equal(nutritionOf({ nutriments: { fat_100g: '' }, nutriscore_grade: 'unknown' }), null);
});

test('category guess from the most specific tag', () => {
  const categories = [{ id: 'd', name: 'Drinks' }, { id: 's', name: 'Snacks' }, { id: 'c', name: 'Coffee & tea' }];
  assert.equal(guessCategory(['en:beverages', 'en:carbonated-drinks', 'en:colas'], categories), 'd');
  assert.equal(guessCategory(['en:snacks', 'en:salty-snacks', 'en:crisps'], categories), 's');
  assert.equal(guessCategory(['en:plant-based-foods-and-beverages', 'en:coffees'], categories), 'c');
  assert.equal(guessCategory([], categories), null);
});
