'use strict';

// Inverse of EPSG:2263, NAD83 New York Long Island, US survey feet.
// This converts official LION geometry into the WGS84 degrees used by CSCL.

const HALF_PI = Math.PI / 2;
const A = 6378137;
const RF = 298.257222101;
const B = A * (1 - 1 / RF);
const US_FT = 0.3048006096012192;
const LAT1 = 40.66666666666666 * Math.PI / 180;
const LAT2 = 41.03333333333333 * Math.PI / 180;
const LAT0 = 40.16666666666666 * Math.PI / 180;
const LON0 = -74 * Math.PI / 180;
const FALSE_EAST_METERS = 300000.0000000001;
const FALSE_NORTH_METERS = 0;

const E = Math.sqrt(1 - (B / A) * (B / A));

function msfnz(sinphi, cosphi) {
  const con = E * sinphi;
  return cosphi / Math.sqrt(1 - con * con);
}

function tsfnz(phi, sinphi) {
  const con = E * sinphi;
  const com = 0.5 * E;
  return Math.tan(0.5 * (HALF_PI - phi)) / Math.pow((1 - con) / (1 + con), com);
}

function phi2z(ts) {
  const eccnth = 0.5 * E;
  let phi = HALF_PI - 2 * Math.atan(ts);
  for (let i = 0; i <= 15; i += 1) {
    const con = E * Math.sin(phi);
    const dphi = HALF_PI - 2 * Math.atan(ts * Math.pow((1 - con) / (1 + con), eccnth)) - phi;
    phi += dphi;
    if (Math.abs(dphi) <= 1e-10) return phi;
  }
  return null;
}

const ms1 = msfnz(Math.sin(LAT1), Math.cos(LAT1));
const ts1 = tsfnz(LAT1, Math.sin(LAT1));
const ms2 = msfnz(Math.sin(LAT2), Math.cos(LAT2));
const ts2 = tsfnz(LAT2, Math.sin(LAT2));
const ts0 = tsfnz(LAT0, Math.sin(LAT0));
const NS = Math.log(ms1 / ms2) / Math.log(ts1 / ts2);
const F0 = ms1 / (NS * Math.pow(ts1, NS));
const RH = A * F0 * Math.pow(ts0, NS);

function nyLongIslandUsFtToWgs84(xFeet, yFeet) {
  if (!Number.isFinite(xFeet) || !Number.isFinite(yFeet)) return null;
  const x = xFeet * US_FT - FALSE_EAST_METERS;
  const y = RH - (yFeet * US_FT - FALSE_NORTH_METERS);
  const rh1 = Math.sqrt(x * x + y * y);
  const theta = rh1 === 0 ? 0 : Math.atan2(x, y);
  const ts = Math.pow(rh1 / (A * F0), 1 / NS);
  const lat = phi2z(ts);
  if (lat == null) return null;
  let lon = theta / NS + LON0;
  if (Math.abs(lon) > Math.PI) lon -= Math.sign(lon) * 2 * Math.PI;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

module.exports = { nyLongIslandUsFtToWgs84 };
