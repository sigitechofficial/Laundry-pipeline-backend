'use strict';

/**
 * Dry Clean wash-catalog from laundaryImages sheets.
 * Batches of 3 categories — seeders import BATCH_N only; ALL_CATEGORY_NAMES
 * is the allowlist so disable-old never turns off later-batch names.
 *
 * Prices: sensible UK dry-clean defaults (GBP). Admin can edit after seed.
 */

/** Category base prices (GBP) — typical UK high-street / local cleaner range. */
const CATEGORY_BASE_PRICE = {
  Trousers: 7.5,
  Shorts: 6,
  Jackets: 12,
  Suits: 18,
  Dresses: 14,
  Shirts: 4.5,
  'Knitwear / Cardigans': 9,
  Skirts: 8,
  'Tops & Blouses': 7,
  Coats: 18,
  'Miscellaneous Items': 5,
  Leather: 42,
  Suede: 40,
  'Waxed Garments': 28,
  'Ski Wear': 22,
  'Motorcycle Clothing': 32,
  'Jewish / Religious Items': 16,
};

/** Exact overrides when name needs a fixed UK default (GBP). */
const ITEM_PRICE_OVERRIDES = {
  // Suits
  '2 Piece Suit': 18,
  '2 Piece Suit (Child)': 14,
  '3 Piece Suit': 24,
  '3 Piece Suit (Child)': 18,
  '2 Piece Suit (Linen)': 20,
  '3 Piece Suit (Linen)': 26,
  '2 Piece Suit (Velvet)': 22,
  '2 Piece Suit (Silk)': 24,
  'Short Suit (2 Piece)': 17,
  'Dinner Suit (2 Piece)': 22,
  'Dinner Suit (3 Piece)': 28,
  'Kurta Pajama Suit (2 Piece)': 20,
  'Sherwani / Sari Suit (1 Piece)': 28,
  'Sherwani / Sari Suit (2 Piece)': 32,
  'Sherwani / Sari Suit (3 Piece)': 38,
  'Morning Suit (2 Piece)': 22,
  'Morning Suit (3 Piece)': 28,
  'Sports Suit (2 Piece)': 18,
  'Long Jacket Suit (2 Piece)': 20,

  // Dresses – special occasions
  'Wedding Dress': 85,
  'Wedding Dress with Beading': 110,
  'Prom Dress': 35,
  'Evening Dress': 22,
  'Evening Dress with Beading': 28,
  'Cocktail Dress': 18,
  'Party Dress': 16,
  'Formal Dress': 18,
  "Child's Party Dress": 12,

  // Misc accessories
  Tie: 4.5,
  'Bow Tie': 4.5,
  Scarf: 6,
  'Silk Scarf': 8,
  Pashmina: 10,
  Waistcoat: 8,
  'Linen Waistcoat': 9,
  'Velvet Waistcoat': 10,
  'Gloves — Pair': 6,
  Hat: 8,
  Cap: 6,
  'Silk Handkerchief': 4,
  Belt: 5,
  Handbag: 18,
  Shoes: 15,
  'Socks — Pair': 4,

  // Religious
  Tallit: 18,
  'Tallit with Silver Atarah': 28,
  'Tallit Cover': 12,
  Kittel: 16,
  'Kittel with Belt': 18,
  'Kippah / Yarmulke': 6,
  'Tzitzit Garment': 12,
  'Shtreimel Cover': 14,
  'Chuppah Cover': 35,
  Chuppah: 55,
  'Sefer Torah Cover': 45,
  'Parochet – Small': 30,
  'Parochet – Medium': 40,
  'Parochet – Large': 55,
};

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * UK default dry-clean price for a catalog item (GBP).
 * @param {string} categoryName
 * @param {string} itemName
 * @returns {number}
 */
function priceForItem(categoryName, itemName) {
  if (ITEM_PRICE_OVERRIDES[itemName] != null) {
    return round2(ITEM_PRICE_OVERRIDES[itemName]);
  }

  const n = String(itemName || '').toLowerCase();
  let price = CATEGORY_BASE_PRICE[categoryName];
  if (price == null) price = 8;

  // Fabric / finish premiums
  if (/\bcashmere\b/.test(n)) price += 4;
  else if (/\bsilk\b/.test(n)) price += 3;
  else if (/\bvelvet\b/.test(n)) price += 3;
  else if (/\blinen\b/.test(n)) price += 1.5;
  else if (/\bwool\b|\bmerino\b|\blambswool\b/.test(n)) price += 1.5;
  else if (/\bcorduroy\b/.test(n)) price += 1;
  else if (/\bdenim\b|\bjeans\b/.test(n)) price += 0.5;

  if (/\bbead|embellish|embroider/.test(n)) price += 5;
  if (/\bpleated\b/.test(n)) price += 2;
  if (/\bbelt\b/.test(n)) price += 1;
  if (/\bheavy\b|\bwinter\b|\bpuffer\b|\bdown\b|\bpadded\b/.test(n)) price += 4;
  if (/\braincoat\b|\bwaterproof\b/.test(n)) price += 2;
  if (/\bdinner\b|\btuxedo\b|\bmorning suit\b/.test(n)) price += 3;
  if (/\blong\b|\bmaxi\b|\bfull length\b|\blongline\b|\bovercoat\b|\btrench\b/.test(n)) {
    price += 2;
  }
  if (/\bleather\b|\bfaux leather\b/.test(n) && categoryName !== 'Leather') {
    price += 15;
  }
  if (/\bchild|children|school\b/.test(n)) price -= 1.5;

  // Jacket / coat style bumps already partly in base
  if (categoryName === 'Jackets' && /\bblazer\b/.test(n)) price = Math.max(price, 12);
  if (categoryName === 'Coats' && /\bdown\b|\bpuffer\b/.test(n)) price += 2;

  // Floor
  if (price < 3.5) price = 3.5;

  return round2(price);
}

/** Full planned category set (all batches). Used when disabling legacy rows. */
const ALL_CATEGORY_NAMES = [
  'Trousers',
  'Shorts',
  'Jackets',
  'Suits',
  'Dresses',
  'Shirts',
  'Knitwear / Cardigans',
  'Skirts',
  'Tops & Blouses',
  'Coats',
  'Miscellaneous Items',
  'Leather',
  'Suede',
  'Waxed Garments',
  'Ski Wear',
  'Motorcycle Clothing',
  'Jewish / Religious Items',
];

const BATCH_1 = [
  {
    name: 'Trousers',
    sortOrder: 1,
    description: 'Trousers – Dry Cleaning (arranged by popularity)',
    items: [
      'Standard Trousers',
      'Wool Trousers',
      'Cotton Trousers',
      'Chino Trousers',
      'Linen Trousers',
      'Corduroy Trousers',
      'Denim Jeans',
      'Joggers / Tracksuit Bottoms',
      'Cargo Trousers',
      'Dinner / Tuxedo Trousers',
      'Heavy Wool Trousers',
      'Velvet Trousers',
      'Silk Trousers',
      'Cashmere Trousers',
      'Trousers with Belt',
      'Embellished / Beaded Trousers',
      'Morning Suit Trousers',
      'Hunting / Shooting Trousers',
      "Children's Trousers",
      'Pyjama Bottoms',
    ],
  },
  {
    name: 'Shorts',
    sortOrder: 2,
    description: 'Shorts – Dry Cleaning (arranged by popularity)',
    items: [
      'Casual Shorts (Regular)',
      'Sports Shorts',
      'Denim Shorts',
      'Cotton Shorts',
      'Linen Shorts',
      'Chino Shorts',
      'Cargo Shorts',
      'Gym / Training Shorts',
      'Running Shorts',
      'Swim Shorts',
      'Board Shorts',
      'Basketball Shorts',
      'Football Shorts',
      'Cycling Shorts',
      'Sweat Shorts / Fleece Shorts',
      'Corduroy Shorts',
      'Dress Shorts',
      'Silk Shorts',
      'Velvet Shorts',
      "Children's Shorts",
    ],
  },
  {
    name: 'Jackets',
    sortOrder: 3,
    description: 'Jackets – Dry Cleaning (arranged by popularity)',
    items: [
      'Jacket (Regular / Casual)',
      'Blazer',
      'Denim Jacket',
      'Bomber Jacket',
      'Hooded Jacket',
      'Puffer Jacket',
      'Sports Jacket',
      'Jacket with Belt',
      'Jacket Zip-Up',
      'Jacket Light (Summer / Thin)',
      'Jacket Linen',
      'Jacket Silk',
      'Jacket Cashmere',
      'Jacket Wool',
      'Jacket Fleece',
      'Jacket Heavy (Winter / Padded)',
      'Jacket Hunting / Field',
      'Jacket Velvet',
      'Child Jacket',
      'School Blazer',
      'Dinner Jacket / Tuxedo Jacket',
      'Raincoat / Waterproof Jacket',
      'Windbreaker',
    ],
  },
];

const BATCH_2 = [
  {
    name: 'Suits',
    sortOrder: 4,
    description: 'Suits – Dry Cleaning (arranged by popularity)',
    items: [
      '2 Piece Suit',
      '2 Piece Suit (Child)',
      '3 Piece Suit',
      '3 Piece Suit (Child)',
      '2 Piece Suit (Linen)',
      '3 Piece Suit (Linen)',
      '2 Piece Suit (Velvet)',
      '2 Piece Suit (Silk)',
      'Short Suit (2 Piece)',
      'Dinner Suit (2 Piece)',
      'Dinner Suit (3 Piece)',
      'Kurta Pajama Suit (2 Piece)',
      'Sherwani / Sari Suit (1 Piece)',
      'Sherwani / Sari Suit (2 Piece)',
      'Sherwani / Sari Suit (3 Piece)',
      'Morning Suit (2 Piece)',
      'Morning Suit (3 Piece)',
      'Sports Suit (2 Piece)',
      'Long Jacket Suit (2 Piece)',
    ],
  },
  {
    name: 'Dresses',
    sortOrder: 5,
    description: 'Dresses – Dry Cleaning (arranged by popularity)',
    items: [
      'Dress (Regular)',
      'Day Dress',
      'Midi Dress',
      'Maxi Dress',
      'Party Dress',
      'Cocktail Dress',
      'Evening Dress',
      'Formal Dress',
      "Child's Dress",
      "Child's Party Dress",
      'Linen Dress',
      'Long Linen Dress',
      'Silk Dress',
      'Long Silk Dress',
      'Pleated Dress',
      'Long Pleated Dress',
      'Denim Dress',
      'Wool Dress',
      'Cashmere Dress',
      'Velvet Dress',
      'Beaded / Embellished Dress',
      'Evening Dress with Beading',
      'Prom Dress',
      'Wedding Dress',
      'Wedding Dress with Beading',
      'Dressing Gown',
      'Silk Dressing Gown',
      'Jumpsuit',
      'Linen Jumpsuit',
      'Silk Jumpsuit',
      'Denim Jumpsuit',
    ],
  },
  {
    name: 'Shirts',
    sortOrder: 6,
    description: 'Shirts – Dry Cleaning (arranged by popularity)',
    items: [
      'Dress Shirt',
      'Formal Shirt',
      "Ladies' Dress Shirt",
      'Polo Shirt',
      'T-Shirt',
      'Linen Shirt',
      'Silk Shirt',
      'Wool Shirt',
      'Cashmere Shirt',
      'Velvet Shirt',
      'Embroidered Shirt',
      'Beaded / Embellished Shirt',
      'Pleated Shirt',
      'Designer / Delicate Shirt',
    ],
  },
];

const BATCH_3 = [
  {
    name: 'Knitwear / Cardigans',
    sortOrder: 7,
    description: 'Knitwear / Cardigans – Dry Cleaning (arranged by popularity)',
    items: [
      'Knitwear (Regular Sweater)',
      'Cashmere Knitwear',
      'Merino Wool Knitwear',
      'Lambswool Knitwear',
      'V-Neck Knitwear',
      'Crew Neck Knitwear',
      'Cardigan (Regular)',
      'Cashmere Cardigan',
      'Merino Wool Cardigan',
      'Longline Cardigan',
      'Cardigan (Hooded)',
      'Hooded Knitwear',
      'Beaded / Embellished Knitwear',
      'Knitwear with Beads',
      'Slipover (Sweater Vest)',
      'Zip-Up Knitwear / Cardigan',
    ],
  },
  {
    name: 'Skirts',
    sortOrder: 8,
    description: 'Skirts – Dry Cleaning (arranged by popularity)',
    items: [
      'Skirt (Regular)',
      'Skirt Medium / Knee Length',
      'Skirt Full Length / Maxi',
      'Skirt Denim / Jeans',
      'Skirt Wool',
      'Skirt Silk',
      'Skirt Cashmere',
      'Skirt with Beads',
      'Skirt with Belt',
      'Kilt',
      'Skirt Pleated',
      'Skirt Pleated Medium',
      'Skirt Pleated Full Length',
      'Skirt Silk Long',
      'Skirt Silk Pleated',
      'Skirt A-Line',
      'Skirt Wrap',
      'Skirt Pencil',
      'Skirt Circle / Flared',
      'Skirt Tulle / Net',
      'Skirt Lace',
      'Skirt Leather / Faux Leather',
    ],
  },
  {
    name: 'Tops & Blouses',
    sortOrder: 9,
    description: 'Tops & Blouses – Dry Cleaning (arranged by popularity)',
    items: [
      'Blouse',
      'Blouse Linen',
      'Blouse Silk',
      'Blouse with Beads / Embellished',
      'Top (Regular)',
      'Top Silk',
      'Top Linen',
      'Top with Beads / Embellished',
      'Blouse Pleated',
      'Top Pleated',
      'Top Cotton',
      'Top Chiffon / Georgette',
      'Top Crepe',
      'Top Satin',
      'Cami Top / Spaghetti Strap Top',
      'Sleeveless Top',
      'Wrap Top',
      'Peplum Top',
    ],
  },
];

const BATCH_4 = [
  {
    name: 'Coats',
    sortOrder: 10,
    description: 'Coats – Dry Cleaning (arranged by popularity)',
    items: [
      'Coat (Regular)',
      'Long Coat',
      'Wool Coat',
      'Heavy / Winter Coat',
      'Overcoat',
      'Trench Coat',
      'Coat with Belt',
      'Raincoat',
      'Raincoat with Belt',
      'Puffer Coat',
      'Down Coat',
      "Child's Coat",
    ],
  },
  {
    name: 'Miscellaneous Items',
    sortOrder: 11,
    description: 'Miscellaneous Items – Dry Cleaning (arranged by popularity)',
    items: [
      'Tie',
      'Scarf',
      'Silk Scarf',
      'Pashmina',
      'Waistcoat',
      'Linen Waistcoat',
      'Velvet Waistcoat',
      'Bow Tie',
      'Gloves — Pair',
      'Hat',
      'Cap',
      'Silk Handkerchief',
      'Belt',
      'Handbag',
      'Shoes',
      'Socks — Pair',
    ],
  },
  {
    name: 'Leather',
    sortOrder: 12,
    description: 'Leather – Specialist Cleaning (arranged by popularity)',
    items: [
      'Leather Jacket',
      'Leather Coat',
      'Leather Trousers',
      'Leather Skirt',
      'Leather Waistcoat',
      'Leather Gloves – Pair',
      'Leather Handbag',
    ],
  },
];

const BATCH_5 = [
  {
    name: 'Suede',
    sortOrder: 13,
    description: 'Suede – Specialist Cleaning (arranged by popularity)',
    items: [
      'Suede Jacket',
      'Suede Coat',
      'Suede Trousers',
      'Suede Skirt',
      'Suede Waistcoat',
      'Suede Gloves – Pair',
      'Suede Handbag',
    ],
  },
  {
    name: 'Waxed Garments',
    sortOrder: 14,
    description: 'Waxed Garments (arranged by popularity)',
    items: ['Waxed Jacket', 'Waxed Coat', 'Waxed Trousers'],
  },
  {
    name: 'Ski Wear',
    sortOrder: 15,
    description: 'Ski Wear – Dry Cleaning (arranged by popularity)',
    items: [
      'Ski Jacket',
      'Ski Trousers',
      'Ski Suit — 2 Piece',
      'Ski Suit — 1 Piece',
      'Ski Salopettes',
      'Ski Vest / Gilet',
      'Ski Thermal Top',
      'Ski Thermal Bottom',
      'Ski Gloves — Pair',
    ],
  },
];

const BATCH_6 = [
  {
    name: 'Motorcycle Clothing',
    sortOrder: 16,
    description: 'Motorcycle Clothing (arranged by popularity)',
    items: [
      'Motorcycle Jacket',
      'Motorcycle Trousers',
      'Motorcycle Suit – 2 Piece',
      'Motorcycle Suit – 1 Piece',
      'Motorcycle Gloves – Pair',
    ],
  },
  {
    name: 'Jewish / Religious Items',
    sortOrder: 17,
    description: 'Jewish / Religious Items (arranged by popularity)',
    items: [
      'Tallit',
      'Tallit with Silver Atarah',
      'Tallit Cover',
      'Kittel',
      'Kittel with Belt',
      'Kippah / Yarmulke',
      'Tzitzit Garment',
      'Shtreimel Cover',
      'Chuppah Cover',
      'Chuppah',
      'Sefer Torah Cover',
      'Parochet – Small',
      'Parochet – Medium',
      'Parochet – Large',
    ],
  },
];

module.exports = {
  CATEGORY_BASE_PRICE,
  ITEM_PRICE_OVERRIDES,
  priceForItem,
  ALL_CATEGORY_NAMES,
  BATCH_1,
  BATCH_2,
  BATCH_3,
  BATCH_4,
  BATCH_5,
  BATCH_6,
  SERVICE_NAME: 'Dry Clean',
};
