'use strict';

// Minimal public records retained from the official SND 26b COW archive.
// The digest was computed locally from the exact snd.zip bytes; NYC does not
// publish this value as an official checksum.
const source = Object.freeze({
  datasetId: 'w4v2-rv6b',
  release: '26b',
  archiveSha256: '545e3d7145f397f92cf251a63505ae668658a72ef68f8c0465b0a8e6d599f470',
});

const cow = value => value.padEnd(200, ' ');

const header = Object.freeze({
  ordinal: 0,
  cowRecord: cow('0000SND 26041726B 00121550'),
});

const records = Object.freeze([
  Object.freeze({ ordinal: 103, cowRecord: cow('11   6 AVENUE                     VS11051001010  N 11   6 AVENUE') }),
  Object.freeze({ ordinal: 106, cowRecord: cow('11   6 AVENUE NORTHBOUND ROADBED  VS11051002020  N 30   6 AVENUE NORTHBOUND ROADBED                        R') }),
  Object.freeze({ ordinal: 107, cowRecord: cow('11   6 AVENUE SOUTHBOUND ROADBED  VS11051003020  N 30   6 AVENUE SOUTHBOUND ROADBED                        R') }),
  Object.freeze({ ordinal: 1886, cowRecord: cow('11AVENUE OF THE AMERICAS          PF11051001030    22AVENUE OF THE AMERICAS') }),
  Object.freeze({ ordinal: 3055, cowRecord: cow('11CAMP LA GUARDIA ROAD            VS10380201020    20CAMP LA GUARDIA ROAD                                  U') }),
  Object.freeze({ ordinal: 3056, cowRecord: cow('11CAMP LAGUARDIA ROAD             PF10380201010    19CAMP LAGUARDIA ROAD                                   U') }),
  Object.freeze({ ordinal: 8689, cowRecord: cow('11FORT WASHINGTON AVENUE          PF12119001020    22FORT WASHINGTON AVENUE') }),
]);

module.exports = { source, header, records };
