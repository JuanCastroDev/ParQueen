'use strict';

// New-scheme deadline-bound publications use isolated collection names so
// older app versions that query streetSegments / streetRules (including
// collectionGroup('streetRules')) cannot observe unverified generations.
const LEGACY_SEGMENT_COLLECTION = 'streetSegments';
const LEGACY_RULES_SUBCOLLECTION = 'streetRules';
const PUBLIC_SEGMENT_COLLECTION = 'streetSegmentsV2';
const PUBLIC_RULES_SUBCOLLECTION = 'streetRulesV2';
const FIRESTORE_MAX_WRITES_PER_TRANSACTION = 500;

function remapDeadlineBoundDocuments(db, documents, key) {
  if (!db || typeof db.doc !== 'function' || !Array.isArray(documents)) return documents;
  return documents.map(([ref, value]) => {
    if (ref?.path === `${LEGACY_SEGMENT_COLLECTION}/${key}`) {
      return [db.doc(`${PUBLIC_SEGMENT_COLLECTION}/${key}`), value];
    }
    const prefix = `${LEGACY_SEGMENT_COLLECTION}/${key}/${LEGACY_RULES_SUBCOLLECTION}/`;
    if (ref?.path?.startsWith(prefix)) {
      const ruleId = ref.path.slice(prefix.length);
      return [db.doc(`${PUBLIC_SEGMENT_COLLECTION}/${key}/${PUBLIC_RULES_SUBCOLLECTION}/${ruleId}`), value];
    }
    return [ref, value];
  });
}

function publicSegmentPath(key) {
  return `${PUBLIC_SEGMENT_COLLECTION}/${key}`;
}

function publicRulesCollectionPath(key) {
  return `${PUBLIC_SEGMENT_COLLECTION}/${key}/${PUBLIC_RULES_SUBCOLLECTION}`;
}

function legacySegmentPath(key) {
  return `${LEGACY_SEGMENT_COLLECTION}/${key}`;
}

function legacyRulesCollectionPath(key) {
  return `${LEGACY_SEGMENT_COLLECTION}/${key}/${LEGACY_RULES_SUBCOLLECTION}`;
}

module.exports = {
  LEGACY_SEGMENT_COLLECTION,
  LEGACY_RULES_SUBCOLLECTION,
  PUBLIC_SEGMENT_COLLECTION,
  PUBLIC_RULES_SUBCOLLECTION,
  FIRESTORE_MAX_WRITES_PER_TRANSACTION,
  remapDeadlineBoundDocuments,
  publicSegmentPath,
  publicRulesCollectionPath,
  legacySegmentPath,
  legacyRulesCollectionPath,
};
