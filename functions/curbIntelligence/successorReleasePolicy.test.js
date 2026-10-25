import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { evaluateSuccessorRelease } = require('./successorReleasePolicy');
const { hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');

function publishedObservation(overrides = {}) {
  const observation = {
    pdf: {
      sha256: 'b98255a244046fc8b779652df2a36266fde71e133f9021ced03f809b92017ef4',
      byteLength: 1389272,
      byteIdentity: 'RETAINED_MATCHES_PUBLIC',
      pageCitation: { edition: '26B', pageNumber: 1, observationMethod: 'VISUAL_INSPECTION' },
      titleMetadata: {
        edition: '26C',
        observationMethod: 'PDF_INFO_XMP_TITLE',
        parser: 'si03-pdf-document-info-1',
      },
      parserExtractedPageText: false,
    },
    lion: {
      sha256: '14a2514303f0c53419cdc370bfd851db41dec038450b88b19d0897a35dad0660',
      byteLength: 45981902,
      packageEdition: '26B',
      packageObservationMethod: 'GDB_ITEMS_CITATION',
      catalogEdition: '26B',
      catalogObservationMethod: 'lion-metadata-before',
      nodeEdition: '26B',
      nodeObservationMethod: 'lion-metadata-after',
    },
    snd: {
      sha256: '545e3d7145f397f92cf251a63505ae668658a72ef68f8c0465b0a8e6d599f470',
      byteLength: 2966071,
      edition: '26B',
      observationMethod: 'EMBEDDED_COW_HEADER',
    },
    geosupport: { edition: '26C', observationMethod: 'RECORDED_NATIVE_RELEASE' },
    certificationStatus: 'NOT_CERTIFIED',
    productionAuthoritative: false,
    topologyApproved: false,
    canonicalSupported: false,
    pageCitationIsReadinessAuthority: false,
    releaseCertification: 'BLOCKED',
    checksumIsCertification: false,
  };
  return {
    ...observation,
    ...overrides,
    pdf: { ...observation.pdf, ...overrides.pdf },
    lion: { ...observation.lion, ...overrides.lion },
    snd: { ...observation.snd, ...overrides.snd },
    geosupport: { ...observation.geosupport, ...overrides.geosupport },
  };
}

describe('successor offline edition reconciliation', () => {
  it('recognizes the recorded 26B page citation without rewriting the 26C title', () => {
    const observation = publishedObservation();
    const result = evaluateSuccessorRelease(observation);

    expect(result).toMatchObject({
      active: false,
      productionAuthoritative: false,
      certificationStatus: 'NOT_CERTIFIED',
      releaseCertification: 'BLOCKED',
      publishedLionEdition: '26B',
      pdfCitationRecognized: true,
      pdfTitle: '26C',
      pdfTitleConflictPreserved: true,
      pageDecodedByParser: false,
      sourceEditionReconciled: true,
      canonicalSupported: false,
      topologyApproved: false,
      checksumIsCertification: false,
      frozenReadinessAuthority: 'PDF_INFO_XMP_TITLE',
    });
    expect(result.compatibility).toMatchObject({
      publishedSourceEdition: 'RECONCILED_26B',
      lionSnd: 'RECORDED_EDITIONS_AGREE_26B',
      geosupport: 'SEPARATE_PRODUCT_UNRESOLVED',
      geosupportEditionEqualityRequired: false,
      sampleCompatibilityAssumed: false,
      topologyAuthority: 'UNRESOLVED',
      driverSideEvidence: 'ABSENT',
    });
    expect(observation.pdf.titleMetadata.edition).toBe('26C');
    expect(hasPrimaryTopologyAuthority(result)).toBe(false);
  });

  it('rejects a different PDF digest, LION edition, SND edition, or missing visual citation', () => {
    expect(evaluateSuccessorRelease(publishedObservation({
      pdf: { sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    })).unmetConditions).toContain('pdf_identity_mismatch');
    expect(evaluateSuccessorRelease(publishedObservation({
      lion: { packageEdition: '26C' },
    })).unmetConditions).toContain('lion_edition_mismatch');
    expect(evaluateSuccessorRelease(publishedObservation({
      snd: { edition: '26C' },
    })).unmetConditions).toContain('snd_edition_mismatch');
    expect(evaluateSuccessorRelease(publishedObservation({
      lion: { catalogEdition: '26C' },
    })).unmetConditions).toContain('catalog_edition_disagreement');
    expect(evaluateSuccessorRelease(publishedObservation({
      lion: { nodeEdition: '26C' },
    })).unmetConditions).toContain('contradictory_package_observation');
    const missingCitation = evaluateSuccessorRelease(publishedObservation({
      pdf: { pageCitation: { edition: '26B', pageNumber: 1, observationMethod: 'PDF_INFO_XMP_TITLE' } },
    }));
    expect(missingCitation.unmetConditions).toContain('visual_citation_missing');
    expect(missingCitation.pdfCitationRecognized).toBe(false);
    expect(missingCitation.publishedLionEdition).toBeNull();
  });

  it('rejects caller release flags, unrecognized versions, and a rewritten PDF title', () => {
    const claimed = evaluateSuccessorRelease(publishedObservation({ certificationStatus: 'CERTIFIED' }));
    expect(claimed.unmetConditions).toContain('caller_release_flag_rejected');
    expect(claimed.sourceEditionReconciled).toBe(false);
    expect(claimed.canonicalSupported).toBe(false);
    expect(hasPrimaryTopologyAuthority(claimed)).toBe(false);

    expect(evaluateSuccessorRelease(publishedObservation({
      lion: { packageEdition: '26Z' },
    })).unmetConditions).toContain('unrecognized_source_version');
    const rewritten = evaluateSuccessorRelease(publishedObservation({
      pdf: { titleMetadata: { edition: '26B', observationMethod: 'PDF_INFO_XMP_TITLE', parser: 'si03-pdf-document-info-1' } },
    }));
    expect(rewritten.unmetConditions).toContain('pdf_title_conflict_not_preserved');
    expect(rewritten.pdfTitle).toBe('26B');
    expect(rewritten.sourceEditionReconciled).toBe(false);
  });

  it('keeps Geosupport compatibility separate from the reconciled LION edition', () => {
    const matched = evaluateSuccessorRelease(publishedObservation({
      geosupport: { edition: '26B', observationMethod: 'RECORDED_NATIVE_RELEASE' },
    }));
    expect(matched.publishedLionEdition).toBe('26B');
    expect(matched.compatibility.geosupport).toBe('UNRESOLVED');
    expect(matched.compatibility.geosupportEditionEqualityRequired).toBe(false);
    expect(matched.compatibility.sampleCompatibilityAssumed).toBe(false);
  });

  it('leaves the frozen release policy and primary topology path unchanged', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const resolver = readFileSync(new URL('./canonicalCurbResolver.js', import.meta.url), 'utf8');
    const artifact = readFileSync(new URL('./runtimeSourceArtifact.js', import.meta.url), 'utf8');
    expect(index.includes('successorReleasePolicy')).toBe(false);
    expect(resolver.includes('successorReleasePolicy')).toBe(false);
    expect(artifact.includes('successorReleasePolicy')).toBe(true);
    expect(artifact.includes("document.editions?.pdfTitle !== '26C'")).toBe(true);
    expect(artifact.includes('document.editions?.pageCitationIsReadinessAuthority !== false')).toBe(true);
    expect(index.includes('enforceAppCheck: true')).toBe(true);
    expect(index.includes('request.data?.protocolVersion !== 2')).toBe(true);
  });
});
