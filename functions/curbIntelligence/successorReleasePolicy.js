'use strict';

const APPROVED_PDF = Object.freeze({
  sha256: 'b98255a244046fc8b779652df2a36266fde71e133f9021ced03f809b92017ef4',
  byteLength: 1389272,
  byteIdentity: 'RETAINED_MATCHES_PUBLIC',
});
const APPROVED_LION = Object.freeze({
  sha256: '14a2514303f0c53419cdc370bfd851db41dec038450b88b19d0897a35dad0660',
  byteLength: 45981902,
  edition: '26B',
  packageObservationMethod: 'GDB_ITEMS_CITATION',
});
const APPROVED_SND = Object.freeze({
  sha256: '545e3d7145f397f92cf251a63505ae668658a72ef68f8c0465b0a8e6d599f470',
  byteLength: 2966071,
  edition: '26B',
  observationMethod: 'EMBEDDED_COW_HEADER',
});
const APPROVED_PAGE = Object.freeze({
  edition: '26B',
  pageNumber: 1,
  observationMethod: 'VISUAL_INSPECTION',
});
const PRESERVED_TITLE = Object.freeze({
  edition: '26C',
  observationMethod: 'PDF_INFO_XMP_TITLE',
  parser: 'si03-pdf-document-info-1',
});
const RECOGNIZED_EDITIONS = new Set(['26B', '26C']);
const CATALOG_METHOD = 'lion-metadata-before';
const NODE_METHOD = 'lion-metadata-after';
const SUCCESSOR_POLICY_VERSION = 'successor-release-candidate-1';
const FROZEN_READINESS_POLICY = 'ONE_CONSISTENT_RELEASE_OBSERVATION';

function same(left, right) {
  return left === right;
}

function tokenClass(value) {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  return RECOGNIZED_EDITIONS.has(value) ? 'recognized' : 'unrecognized';
}

function callerClaimsAuthority(observation) {
  const claims = [
    ['certificationStatus', 'NOT_CERTIFIED'],
    ['productionAuthoritative', false],
    ['topologyApproved', false],
    ['canonicalSupported', false],
    ['pageCitationIsReadinessAuthority', false],
    ['releaseCertification', 'BLOCKED'],
    ['checksumIsCertification', false],
    ['canonicalResolution', 'NOT_CANONICAL'],
    ['sourceEditionReconciled', undefined],
    ['publishedLionEdition', undefined],
  ];
  return claims.some(([key, allowed]) => Object.hasOwn(observation, key) && observation[key] !== allowed);
}

function evaluateSuccessorRelease(observation) {
  const unmet = [];
  const input = observation && typeof observation === 'object' && !Array.isArray(observation) ? observation : null;
  if (!input) unmet.push('evidence_missing');
  else if (callerClaimsAuthority(input)) unmet.push('caller_release_flag_rejected');

  const pdf = input?.pdf && typeof input.pdf === 'object' ? input.pdf : {};
  const page = pdf.pageCitation && typeof pdf.pageCitation === 'object' ? pdf.pageCitation : {};
  const title = pdf.titleMetadata && typeof pdf.titleMetadata === 'object' ? pdf.titleMetadata : {};
  const lion = input?.lion && typeof input.lion === 'object' ? input.lion : {};
  const snd = input?.snd && typeof input.snd === 'object' ? input.snd : {};
  const geosupport = input?.geosupport && typeof input.geosupport === 'object' ? input.geosupport : {};

  const pdfIdentity = same(pdf.sha256, APPROVED_PDF.sha256)
    && same(pdf.byteLength, APPROVED_PDF.byteLength)
    && same(pdf.byteIdentity, APPROVED_PDF.byteIdentity);
  if (input && !pdfIdentity) unmet.push('pdf_identity_mismatch');

  const visualCitation = same(page.edition, APPROVED_PAGE.edition)
    && same(page.pageNumber, APPROVED_PAGE.pageNumber)
    && same(page.observationMethod, APPROVED_PAGE.observationMethod);
  if (input && !visualCitation) {
    unmet.push(tokenClass(page.edition) === 'unrecognized' ? 'unrecognized_source_version' : 'visual_citation_missing');
  }
  if (input && pdf.parserExtractedPageText !== false) unmet.push('page_parser_claim_rejected');

  const titlePreserved = same(title.edition, PRESERVED_TITLE.edition)
    && same(title.observationMethod, PRESERVED_TITLE.observationMethod)
    && same(title.parser, PRESERVED_TITLE.parser);
  if (input && !titlePreserved) {
    unmet.push(tokenClass(title.edition) === 'unrecognized' ? 'unrecognized_source_version' : 'pdf_title_conflict_not_preserved');
  }

  const lionIdentity = same(lion.sha256, APPROVED_LION.sha256)
    && same(lion.byteLength, APPROVED_LION.byteLength)
    && same(lion.packageObservationMethod, APPROVED_LION.packageObservationMethod);
  if (input && !lionIdentity) unmet.push('lion_identity_mismatch');
  if (input && tokenClass(lion.packageEdition) === 'unrecognized') unmet.push('unrecognized_source_version');
  else if (input && lion.packageEdition !== APPROVED_LION.edition) unmet.push('lion_edition_mismatch');

  if (input && !same(lion.catalogObservationMethod, CATALOG_METHOD)) unmet.push('catalog_evidence_missing');
  else if (input && tokenClass(lion.catalogEdition) === 'unrecognized') unmet.push('unrecognized_source_version');
  else if (input && lion.catalogEdition !== APPROVED_LION.edition) unmet.push('catalog_edition_disagreement');

  if (input && !same(lion.nodeObservationMethod, NODE_METHOD)) unmet.push('contradictory_package_observation');
  else if (input && tokenClass(lion.nodeEdition) === 'unrecognized') unmet.push('unrecognized_source_version');
  else if (input && lion.nodeEdition !== APPROVED_LION.edition) unmet.push('contradictory_package_observation');

  const sndIdentity = same(snd.sha256, APPROVED_SND.sha256)
    && same(snd.byteLength, APPROVED_SND.byteLength)
    && same(snd.observationMethod, APPROVED_SND.observationMethod);
  if (input && !sndIdentity) unmet.push('snd_evidence_missing');
  if (input && tokenClass(snd.edition) === 'unrecognized') unmet.push('unrecognized_source_version');
  else if (input && snd.edition !== APPROVED_SND.edition) unmet.push('snd_edition_mismatch');

  if (input && tokenClass(geosupport.edition) === 'unrecognized') unmet.push('unrecognized_source_version');
  const geosupportRecorded = same(geosupport.edition, '26C')
    && same(geosupport.observationMethod, 'RECORDED_NATIVE_RELEASE');

  const unique = [...new Set(unmet)];
  const reconciled = unique.length === 0;
  return Object.freeze({
    policyId: 'successor-offline-edition-reconciliation-1',
    active: false,
    productionAuthoritative: false,
    certificationStatus: 'NOT_CERTIFIED',
    releaseCertification: 'BLOCKED',
    topologyApproved: false,
    canonicalSupported: false,
    checksumIsCertification: false,
    pageDecodedByParser: false,
    publishedLionEdition: reconciled ? APPROVED_PAGE.edition : null,
    pdfCitationRecognized: reconciled,
    pdfTitle: title.edition || null,
    pdfTitleConflictPreserved: titlePreserved,
    frozenReadinessAuthority: 'PDF_INFO_XMP_TITLE',
    sourceEditionReconciled: reconciled,
    unmetConditions: Object.freeze(unique),
    compatibility: Object.freeze({
      publishedSourceEdition: reconciled ? 'RECONCILED_26B' : 'UNRESOLVED',
      lionSnd: reconciled ? 'RECORDED_EDITIONS_AGREE_26B' : 'UNRESOLVED',
      geosupport: geosupportRecorded ? 'SEPARATE_PRODUCT_UNRESOLVED' : 'UNRESOLVED',
      geosupportEditionEqualityRequired: false,
      sampleCompatibilityAssumed: false,
      topologyAuthority: 'UNRESOLVED',
      driverSideEvidence: 'ABSENT',
    }),
  });
}

function recordedSuccessorObservation() {
  return {
    pdf: {
      sha256: APPROVED_PDF.sha256,
      byteLength: APPROVED_PDF.byteLength,
      byteIdentity: APPROVED_PDF.byteIdentity,
      pageCitation: { ...APPROVED_PAGE },
      titleMetadata: { ...PRESERVED_TITLE },
      parserExtractedPageText: false,
    },
    lion: {
      sha256: APPROVED_LION.sha256,
      byteLength: APPROVED_LION.byteLength,
      packageEdition: APPROVED_LION.edition,
      packageObservationMethod: APPROVED_LION.packageObservationMethod,
      catalogEdition: APPROVED_LION.edition,
      catalogObservationMethod: CATALOG_METHOD,
      nodeEdition: APPROVED_LION.edition,
      nodeObservationMethod: NODE_METHOD,
    },
    snd: {
      sha256: APPROVED_SND.sha256,
      byteLength: APPROVED_SND.byteLength,
      edition: APPROVED_SND.edition,
      observationMethod: APPROVED_SND.observationMethod,
    },
    geosupport: { edition: '26C', observationMethod: 'RECORDED_NATIVE_RELEASE' },
    certificationStatus: 'NOT_CERTIFIED',
    productionAuthoritative: false,
    topologyApproved: false,
    canonicalSupported: false,
    pageCitationIsReadinessAuthority: false,
    releaseCertification: 'BLOCKED',
    checksumIsCertification: false,
    canonicalResolution: 'NOT_CANONICAL',
  };
}

module.exports = {
  APPROVED_LION,
  APPROVED_PDF,
  APPROVED_SND,
  FROZEN_READINESS_POLICY,
  SUCCESSOR_POLICY_VERSION,
  evaluateSuccessorRelease,
  recordedSuccessorObservation,
};
