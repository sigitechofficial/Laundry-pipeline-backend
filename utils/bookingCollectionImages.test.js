'use strict';

const assert = require('assert');
const {
  normalizeCollectionImageUrls,
  isCollectFromOutside,
} = require('./bookingCollectionImages');

// Old apps: field missing or wrong type -> nothing saved, no error.
assert.deepStrictEqual(normalizeCollectionImageUrls(undefined), []);
assert.deepStrictEqual(normalizeCollectionImageUrls(null), []);
assert.deepStrictEqual(normalizeCollectionImageUrls('Public/collectionImages/a.jpg'), []);
assert.deepStrictEqual(normalizeCollectionImageUrls([]), []);

// Valid paths kept, trimmed, de-duplicated.
assert.deepStrictEqual(
  normalizeCollectionImageUrls([' Public/collectionImages/a.jpg ', 'Public/collectionImages/a.jpg', 'Public/collectionImages/b.png']),
  ['Public/collectionImages/a.jpg', 'Public/collectionImages/b.png']
);

// Windows separators normalised.
assert.deepStrictEqual(
  normalizeCollectionImageUrls(['Public\\collectionImages\\c.jpg']),
  ['Public/collectionImages/c.jpg']
);

// Other folders, traversal, sub-folders, empty names and non-strings dropped.
assert.deepStrictEqual(
  normalizeCollectionImageUrls([
    'Public/Profile/x.jpg',
    'Public/collectionImages/../Profile/x.jpg',
    'Public/collectionImages/sub/x.jpg',
    'Public/collectionImages/',
    'https://evil.example/x.jpg',
    null,
    42,
  ]),
  []
);

// Capped at 3.
assert.deepStrictEqual(
  normalizeCollectionImageUrls(['a', 'b', 'c', 'd'].map((n) => `Public/collectionImages/${n}.jpg`)),
  ['a', 'b', 'c'].map((n) => `Public/collectionImages/${n}.jpg`)
);

assert.strictEqual(isCollectFromOutside('Collect from Outside'), true);
assert.strictEqual(isCollectFromOutside(' Collect from Outside '), true);
assert.strictEqual(isCollectFromOutside('Collect from me in person'), false);
assert.strictEqual(isCollectFromOutside(undefined), false);

console.log('bookingCollectionImages tests passed');
