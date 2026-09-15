import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { associateCleaningRules } = require('./cleaningRuleAssociation');
const { createFaceAssociationContext } = require('./dotFaceAssociation');
const { normalizeDotSignRow } = require('./dotSignNormalizer');

const VERSION = { resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-09-15T10:04:47Z', viewLastModified: '2026-09-15T10:00:16Z' };
const description = (days, times) => `NO PARKING (SANITATION BROOM SYMBOL) ${days} ${times} <->`;
const raw = ({ code = 'PS-TEST', text = description('MONDAY', '8AM-8:30AM'), order = 'P-1', recordType = 'Current', side = 'W' } = {}) => ({
  order_number: order, record_type: recordType, order_type: 'P-', borough: 'Manhattan',
  on_street: 'GOLD STREET', from_street: 'BEEKMAN STREET', to_street: 'ANN STREET', side_of_street: side,
  sign_code: code, sign_description: text, distance_from_intersection: '36', sign_x_coord: '982905', sign_y_coord: '197775',
});
const normalized = input => normalizeDotSignRow(raw(input), VERSION).record;
const context = (orderApplicability, extra = {}) => createFaceAssociationContext({
  curbIdentityState: 'SUPPORTED', borough: 'Manhattan', streetNames: ['Gold Street'],
  fromNames: ['Beekman Street'], toNames: ['Ann Street'], side: 'W',
  officialRelationship: { providerId: 'official-fixture-context', version: '2026-09-15', orderApplicability },
  ...extra,
});
const snapshot = (candidates, state = 'COMPLETE') => ({ candidates, sourceVersion: VERSION, completeness: { state, reason: state === 'COMPLETE' ? null : 'source_query_truncated' } });

describe('cleaning rule association', () => {
  it.each([
    ['7AM-7:30AM', 30], ['6:30AM-7:30AM', 60], ['11AM-12:30PM', 90], ['MIDNIGHT-3AM', 180],
  ])('retains a complete reviewed %s schedule (%i minutes)', (times, minutes) => {
    const candidate = normalized({ text: description('MONDAY', times) });
    const result = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE' }), candidateSnapshot: snapshot([candidate]) });
    expect(result.confidence).toBe('SUPPORTED');
    expect(result.rules[0]).toMatchObject({ type: 'CLEANING', associationState: 'SUPPORTED', applicability: 'WHOLE_FACE' });
    expect(result.rules[0].schedules[0].durationMinutes).toBe(minutes);
  });

  it('canonicalizes EXCEPT SUNDAY and discrete days', () => {
    const exceptSunday = normalized({ order: 'P-1', text: description('', '7AM-7:30AM EXCEPT SUNDAY') });
    const discrete = normalized({ order: 'P-2', text: description('MONDAY TUESDAY THURSDAY FRIDAY', '6:30AM-7:30AM') });
    const result = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE', 'P-2': 'WHOLE_FACE' }), candidateSnapshot: snapshot([exceptSunday, discrete]) });
    expect(result.rules.map(rule => rule.fingerprint).sort()).toEqual([
      'Mon,Tue,Thu,Fri|06:30|07:30', 'Mon,Tue,Wed,Thu,Fri,Sat|07:00|07:30',
    ]);
  });

  it('keeps legitimate multiple schedules and is invariant to input order', () => {
    const monday = normalized({ order: 'P-1', code: 'PS-MON', text: description('MONDAY', '8AM-9:30AM') });
    const thursday = normalized({ order: 'P-2', code: 'PS-THU', text: description('THURSDAY', '8AM-9:30AM') });
    const first = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE', 'P-2': 'WHOLE_FACE' }), candidateSnapshot: snapshot([monday, thursday]) });
    const second = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE', 'P-2': 'WHOLE_FACE' }), candidateSnapshot: snapshot([thursday, monday]) });
    expect(first.fingerprint).toBe('Mon|08:00|09:30;Thu|08:00|09:30');
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.reasons).not.toContain('conflicting_cleaning_rules');
  });

  it('deduplicates corroborating rows but flags differing schedules for one official regulation identity', () => {
    const sameA = normalized({ order: 'P-1', code: 'PS-20B', text: description('MONDAY', '8AM-9AM') });
    const sameB = normalized({ order: 'P-2', code: 'PS-20B', text: description('MONDAY', '8AM-9AM') });
    const corroborated = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE', 'P-2': 'WHOLE_FACE' }), candidateSnapshot: snapshot([sameA, sameB]) });
    expect(corroborated.rules).toHaveLength(1);
    expect(corroborated.rules[0].provenance).toHaveLength(2);

    const conflicting = normalized({ order: 'P-1', code: 'PS-20B', text: description('MONDAY', '9AM-10AM') });
    const result = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE' }), candidateSnapshot: snapshot([sameA, conflicting]) });
    expect(result).toMatchObject({ confidence: 'UNKNOWN', reasons: ['conflicting_cleaning_rules'] });
  });

  it('rejects non-broom, rider, template, and malformed rows instead of creating cleaning', () => {
    const rows = [
      normalized({ order: 'P-1', code: 'PS-15G', text: 'NO PARKING MONDAY-FRIDAY 8AM-6PM <->' }),
      normalized({ order: 'P-2', code: 'PS-7A', text: 'METERS ARE NOT IN EFFECT ABOVE TIMES (TO BE USED ONLY FOR CONFLICTING STREET CLEANING AND METERED PARKING REGULATIONS)' }),
      normalized({ order: 'P-3', code: 'SP-798C', text: 'NO PARKING <----> SANITATION BROOM (SYMBOL) XYY-XYY TIMES & DAYS TO BE SPECIFIED' }),
    ];
    const result = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE', 'P-2': 'WHOLE_FACE', 'P-3': 'WHOLE_FACE' }), candidateSnapshot: snapshot(rows), meterEvidence: [{ zoneId: '100124' }] });
    expect(result).toMatchObject({ rules: [], confidence: 'UNKNOWN', reasons: ['no_reviewed_cleaning_rule'] });
  });

  it('does not silently ignore a malformed reviewed cleaning schedule beside valid evidence', () => {
    const rows = [
      normalized({ order: 'P-1', code: 'PS-20B', text: description('MONDAY', '8AM-9AM') }),
      normalized({ order: 'P-2', code: 'PS-20B', text: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY TIMES VARY <->' }),
    ];
    const result = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE', 'P-2': 'WHOLE_FACE' }), candidateSnapshot: snapshot(rows) });
    expect(result).toMatchObject({ confidence: 'UNKNOWN', reasons: ['incomplete_cleaning_rule'] });
  });

  it('retains reviewed typo provenance without fuzzy matching', () => {
    const typo = normalized({ order: 'P-1', code: 'PS-162BA', text: 'NO PARKING (SANITATION BROOMM SYMBOL) FRIDAY 10:30AM-NOON --> (SUPERSEDES SP-401CA)' });
    const result = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE' }), candidateSnapshot: snapshot([typo]) });
    expect(result.rules[0].rawEvidence.identityKind).toBe('reviewed_exception');
  });

  it.each([
    ['CAUTION', 'CAUTION'], ['UNKNOWN', 'UNKNOWN'],
  ])('caps an otherwise supported cleaning association at %s curb identity', (curbState, expected) => {
    const result = associateCleaningRules({ curbIdentity: { state: curbState }, faceContext: context({ 'P-1': 'WHOLE_FACE' }, { curbIdentityState: curbState }), candidateSnapshot: snapshot([normalized()]) });
    expect(result.confidence).toBe(expected);
    expect(result.rules[0].associationState).toBe(expected);
    expect(result.reasons).toContain(`curb_identity_${curbState.toLowerCase()}`);
  });

  it('fails closed for partial-face and incomplete source evidence', () => {
    const partial = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'PARTIAL_FACE' }), candidateSnapshot: snapshot([normalized()]) });
    expect(partial).toMatchObject({ confidence: 'CAUTION', reasons: ['partial_face_detected'] });
    const incomplete = associateCleaningRules({ curbIdentity: { state: 'SUPPORTED' }, faceContext: context({ 'P-1': 'WHOLE_FACE' }), candidateSnapshot: snapshot([normalized()], 'INCOMPLETE') });
    expect(incomplete).toMatchObject({ confidence: 'UNKNOWN', reasons: ['candidate_source_incomplete'] });
  });
});
