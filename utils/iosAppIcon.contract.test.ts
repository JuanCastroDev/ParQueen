import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CANONICAL_SHA256 = '6cea755c7f607c5d8ba966f373c034500879276ace4b5e5b72e83ed2f5790978';
const IOS_ICON_SHA256 = '25db96373c23e5aa91dae29e098e08152aad7b48498bf36064301d8bf7059a3a';
const SIMPLIFIED_PIN_SHA256 = '664366567175b702b42f8b5095ec37f2222cddf9498ce7a95180c53913cb6d5a';

const canonicalPath = '../public/icons/parqueen-512.png';
const iosIconPath = '../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
const contentsPath = '../ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));

const parsePng = (bytes: Buffer) => {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const chunks = new Set<string>();
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    chunks.add(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    chunks,
  };
};

describe('canonical iOS app icon', () => {
  it('locks the crowned 512 source and the opaque 1024 iOS icon', () => {
    const canonical = read(canonicalPath);
    const iosIcon = read(iosIconPath);
    const canonicalPng = parsePng(canonical);
    const iosPng = parsePng(iosIcon);

    expect(canonicalPng).toMatchObject({ width: 512, height: 512, bitDepth: 8, colorType: 2 });
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(CANONICAL_SHA256);

    expect(iosPng).toMatchObject({ width: 1024, height: 1024, bitDepth: 8, colorType: 2 });
    expect(iosPng.chunks.has('tRNS')).toBe(false);
    expect(createHash('sha256').update(iosIcon).digest('hex')).toBe(IOS_ICON_SHA256);
    expect(createHash('sha256').update(iosIcon).digest('hex')).not.toBe(SIMPLIFIED_PIN_SHA256);
  });

  it('keeps the universal 1024 iOS app icon catalog entry', () => {
    const contents = JSON.parse(read(contentsPath).toString('utf8'));
    expect(contents.images).toEqual([
      {
        filename: 'AppIcon-512@2x.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
    ]);
  });
});
