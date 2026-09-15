import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  normalizeParkNycRow,
  parseMaximumDuration,
  parseMeterRate,
  parseMeterSchedule,
} = require('./parkNycNormalizer');

const VERSION = { resourceId: 'e7yp-wx55', rowsUpdatedAt: '2026-09-01T10:21:51Z', viewLastModified: '2026-09-01T10:20:59Z' };
const GEOMETRY = { type: 'MultiLineString', coordinates: [[[-74.00515, 40.70949], [-74.00494, 40.70968]]] };
const base = (overrides = {}) => ({
  the_geom: GEOMETRY, pay_by_cel: '100124', vehicle_ty: 'All Vehicles',
  all_vehicl: '2 Hours', all_vehi_1: 'Monday-Saturday 8 AM-7 PM',
  all_vehi_2: '$5.50 1st Hour / $9.00 2nd Hour', all_vehi_3: '$14.50',
  commercial: 'N/A', commerci_1: 'N/A', commerci_2: 'N/A', commerci_3: 'N/A',
  on_street: 'Gold Street', side_of_st: 'W', from_stree: 'Beekman Street',
  to_street: 'Ann Street', borough: 'Manhattan', meter_rate: 'Zone M1', shape_leng: '92.4031597906',
  ...overrides,
});

describe('ParkNYC typed term parsers', () => {
  it.each([['2 Hours', 120], ['3 Hours', 180], ['1 Hour', 60]])('parses maximum duration %s', (raw, minutes) => {
    expect(parseMaximumDuration(raw)).toEqual({ ok: true, minutes, raw });
  });

  it('treats N/A and malformed duration as unavailable rather than zero', () => {
    expect(parseMaximumDuration('N/A')).toEqual({ ok: false, reason: 'term_unavailable', raw: 'N/A' });
    expect(parseMaximumDuration('No Limit')).toEqual({ ok: false, reason: 'unsupported_duration_format', raw: 'No Limit' });
  });

  it('parses observed NYC civil-time day ranges and overnight windows', () => {
    expect(parseMeterSchedule('Monday-Saturday 7:30 AM-7 PM')).toEqual({
      ok: true,
      windows: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], startTime: '07:30', endTime: '19:00', overnight: false }],
      raw: 'Monday-Saturday 7:30 AM-7 PM',
      timeZone: 'America/New_York',
    });
    expect(parseMeterSchedule('Friday 10 PM-2 AM')).toMatchObject({
      ok: true, windows: [{ days: ['Fri'], startTime: '22:00', endTime: '02:00', overnight: true }],
    });
  });

  it('preserves multiple payment windows and rejects any unsupported clause', () => {
    expect(parseMeterSchedule('Monday-Friday 7 AM-7 PM; Saturday 8 AM-6 PM').windows).toHaveLength(2);
    expect(parseMeterSchedule('Weekdays except holidays 7 AM-7 PM'))
      .toEqual({ ok: false, reason: 'unsupported_schedule_format', raw: 'Weekdays except holidays 7 AM-7 PM' });
  });

  it('parses observed tiered and fixed rates while retaining raw terms', () => {
    expect(parseMeterRate('$5.00 1st Hour / $8.25 2nd Hour')).toEqual({
      ok: true, kind: 'TIERED_HOURLY', tiers: [{ ordinal: 1, amount: 5 }, { ordinal: 2, amount: 8.25 }], raw: '$5.00 1st Hour / $8.25 2nd Hour',
    });
    expect(parseMeterRate('$1.50 per Hour')).toEqual({ ok: true, kind: 'FIXED', amount: 1.5, unitMinutes: 60, raw: '$1.50 per Hour' });
    expect(parseMeterRate('$2.00 per 30 Minutes')).toEqual({ ok: true, kind: 'FIXED', amount: 2, unitMinutes: 30, raw: '$2.00 per 30 Minutes' });
    expect(parseMeterRate('$5 first hour; special event pricing')).toEqual({ ok: false, reason: 'unsupported_rate_format', raw: '$5 first hour; special event pricing' });
  });
});

describe('official ParkNYC row normalization', () => {
  it('normalizes All Vehicles as passenger-applicable with complete observed terms', () => {
    const result = normalizeParkNycRow(base(), VERSION);
    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      zoneId: '100124', vehicleClass: 'ALL_VEHICLES', passengerApplicable: true,
      commercialApplicable: true, borough: 'MANHATTAN', side: 'W', onStreet: 'GOLD STREET',
      rateZone: 'Zone M1', geometry: GEOMETRY, sourceVersion: VERSION,
    });
    expect(result.record.branches.passenger).toMatchObject({ complete: true, maximumMinutes: 120 });
    expect(result.record.sourceNative).toEqual(base());
  });

  it('excludes Commercial Only and Charter Bus Only from passenger obligation', () => {
    const commercial = normalizeParkNycRow(base({
      vehicle_ty: 'Commercial Only', all_vehicl: 'N/A', all_vehi_1: 'N/A', all_vehi_2: 'N/A', all_vehi_3: 'N/A',
      commercial: '3 Hours', commerci_1: 'Monday-Friday 7 AM-7 PM', commerci_2: '$7.00 1st Hour / $10.00 2nd Hour / $13.00 3rd Hour', commerci_3: '$30.00',
    }), VERSION).record;
    expect(commercial).toMatchObject({ vehicleClass: 'COMMERCIAL_ONLY', passengerApplicable: false, commercialApplicable: true });
    expect(commercial.branches.passenger).toBeNull();
    expect(commercial.branches.commercial.maximumMinutes).toBe(180);

    const charter = normalizeParkNycRow(base({ vehicle_ty: 'Charter Bus Only' }), VERSION).record;
    expect(charter).toMatchObject({ vehicleClass: 'CHARTER_BUS_ONLY', passengerApplicable: false, commercialApplicable: false });
  });

  it('preserves Dual passenger and commercial terms as independent branches', () => {
    const result = normalizeParkNycRow(base({
      vehicle_ty: 'Dual (Commercial / All Vehicles)', commercial: '3 Hours',
      commerci_1: 'Monday-Friday 7 AM-7 PM', commerci_2: '$7.00 1st Hour / $10.00 2nd Hour / $13.00 3rd Hour', commerci_3: '$30.00',
    }), VERSION);
    expect(result.record).toMatchObject({ vehicleClass: 'DUAL', passengerApplicable: true, commercialApplicable: true });
    expect(result.record.branches.passenger.maximumMinutes).toBe(120);
    expect(result.record.branches.commercial.maximumMinutes).toBe(180);
    expect(result.record.branches.commercial.rate.raw).not.toBe(result.record.branches.passenger.rate.raw);
  });

  it('fails closed for unknown vehicle class, missing geometry, invalid zone, or source identity', () => {
    expect(normalizeParkNycRow(base({ vehicle_ty: 'Passenger Maybe' }), VERSION)).toMatchObject({ ok: false, reason: 'unknown_vehicle_class' });
    expect(normalizeParkNycRow(base({ the_geom: null }), VERSION)).toMatchObject({ ok: false, reason: 'invalid_meter_geometry' });
    expect(normalizeParkNycRow(base({ pay_by_cel: '' }), VERSION)).toMatchObject({ ok: false, reason: 'invalid_zone_id' });
    expect(normalizeParkNycRow(base(), { ...VERSION, resourceId: 'other' })).toMatchObject({ ok: false, reason: 'invalid_source_version' });
    expect(normalizeParkNycRow(base(), { ...VERSION, viewLastModified: 'not-a-time' })).toMatchObject({ ok: false, reason: 'invalid_source_version' });
  });

  it('marks essential schedule failure incomplete and noncritical rate/cap failures as caution evidence', () => {
    const schedule = normalizeParkNycRow(base({ all_vehi_1: 'Weekdays except holidays 7 AM-7 PM' }), VERSION).record.branches.passenger;
    expect(schedule).toMatchObject({ complete: false, essentialReason: 'unsupported_schedule_format' });
    const rate = normalizeParkNycRow(base({ all_vehi_2: 'SPECIAL RATE', all_vehi_3: '$4.00/$6.00' }), VERSION).record.branches.passenger;
    expect(rate).toMatchObject({ complete: true, rateComplete: false });
    expect(rate.rate.raw).toBe('SPECIAL RATE');
    expect(rate.maximumCharge.raw).toBe('$4.00/$6.00');
  });

  it('never derives cleaning or real-time free-parking claims', () => {
    const record = normalizeParkNycRow(base(), VERSION).record;
    expect(record).not.toHaveProperty('cleaning');
    expect(JSON.stringify(record).toLowerCase()).not.toContain('free parking');
  });
});
