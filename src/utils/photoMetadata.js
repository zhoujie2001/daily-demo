const TIFF_TYPE_SIZE = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

function isJpeg(view) {
  return view.byteLength >= 4 && view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8;
}

function findExifTiffOffset(view) {
  if (!isJpeg(view)) return -1;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return -1;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) break;
    const segmentLength = view.getUint16(offset + 2, false);
    if (segmentLength < 2 || offset + 2 + segmentLength > view.byteLength) return -1;
    if (
      marker === 0xe1 &&
      segmentLength >= 8 &&
      view.getUint8(offset + 4) === 0x45 &&
      view.getUint8(offset + 5) === 0x78 &&
      view.getUint8(offset + 6) === 0x69 &&
      view.getUint8(offset + 7) === 0x66 &&
      view.getUint8(offset + 8) === 0x00 &&
      view.getUint8(offset + 9) === 0x00
    ) {
      return offset + 10;
    }
    offset += segmentLength + 2;
  }
  return -1;
}

function createTiffReader(view, tiffOffset) {
  const byteOrder = String.fromCharCode(view.getUint8(tiffOffset), view.getUint8(tiffOffset + 1));
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') throw new Error('Unsupported EXIF byte order');
  if (view.getUint16(tiffOffset + 2, littleEndian) !== 42) throw new Error('Invalid EXIF header');

  const uint16 = (offset) => view.getUint16(offset, littleEndian);
  const uint32 = (offset) => view.getUint32(offset, littleEndian);
  const int32 = (offset) => view.getInt32(offset, littleEndian);

  function readEntries(relativeOffset) {
    if (!relativeOffset) return new Map();
    const directoryOffset = tiffOffset + relativeOffset;
    if (directoryOffset + 2 > view.byteLength) return new Map();
    const count = uint16(directoryOffset);
    const entries = new Map();

    for (let index = 0; index < count; index += 1) {
      const entryOffset = directoryOffset + 2 + index * 12;
      if (entryOffset + 12 > view.byteLength) break;
      const tag = uint16(entryOffset);
      const type = uint16(entryOffset + 2);
      const valueCount = uint32(entryOffset + 4);
      const byteLength = (TIFF_TYPE_SIZE[type] || 1) * valueCount;
      const valueOffset = byteLength <= 4 ? entryOffset + 8 : tiffOffset + uint32(entryOffset + 8);
      if (valueOffset < 0 || valueOffset + byteLength > view.byteLength) continue;
      entries.set(tag, { type, count: valueCount, offset: valueOffset });
    }
    return entries;
  }

  function readAscii(entry) {
    if (!entry || entry.type !== 2) return '';
    let value = '';
    for (let index = 0; index < entry.count; index += 1) {
      const character = view.getUint8(entry.offset + index);
      if (character === 0) break;
      value += String.fromCharCode(character);
    }
    return value.trim();
  }

  function readUnsigned(entry, index = 0) {
    if (!entry || index >= entry.count) return null;
    if (entry.type === 1 || entry.type === 7) return view.getUint8(entry.offset + index);
    if (entry.type === 3) return uint16(entry.offset + index * 2);
    if (entry.type === 4) return uint32(entry.offset + index * 4);
    return null;
  }

  function readRational(entry, index = 0) {
    if (!entry || index >= entry.count || (entry.type !== 5 && entry.type !== 10)) return null;
    const offset = entry.offset + index * 8;
    const numerator = entry.type === 10 ? int32(offset) : uint32(offset);
    const denominator = entry.type === 10 ? int32(offset + 4) : uint32(offset + 4);
    return denominator ? numerator / denominator : null;
  }

  return { uint32, readEntries, readAscii, readUnsigned, readRational };
}

function normalizeExifDate(value) {
  if (!value) return '';
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : '';
}

function gpsCoordinate(reader, entries, valueTag, referenceTag) {
  const value = entries.get(valueTag);
  const reference = reader.readAscii(entries.get(referenceTag)).toUpperCase();
  if (!value || value.count < 3 || !reference) return null;
  const degrees = reader.readRational(value, 0);
  const minutes = reader.readRational(value, 1);
  const seconds = reader.readRational(value, 2);
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  const coordinate = degrees + minutes / 60 + seconds / 3600;
  return reference === 'S' || reference === 'W' ? -coordinate : coordinate;
}

export function readJpegPhotoMetadata(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const tiffOffset = findExifTiffOffset(view);
  if (tiffOffset < 0) return {};

  try {
    const reader = createTiffReader(view, tiffOffset);
    const ifd0Offset = reader.uint32(tiffOffset + 4);
    const ifd0 = reader.readEntries(ifd0Offset);
    const exifPointer = reader.readUnsigned(ifd0.get(0x8769));
    const gpsPointer = reader.readUnsigned(ifd0.get(0x8825));
    const exif = reader.readEntries(exifPointer);
    const gps = reader.readEntries(gpsPointer);
    const capturedAt = normalizeExifDate(
      reader.readAscii(exif.get(0x9003)) ||
      reader.readAscii(exif.get(0x9004)) ||
      reader.readAscii(ifd0.get(0x9003)) ||
      reader.readAscii(ifd0.get(0x9004)) ||
      reader.readAscii(ifd0.get(0x0132))
    );
    const latitude = gpsCoordinate(reader, gps, 0x0002, 0x0001);
    const longitude = gpsCoordinate(reader, gps, 0x0004, 0x0003);
    const altitudeValue = reader.readRational(gps.get(0x0006));
    const altitudeReference = reader.readUnsigned(gps.get(0x0005));
    const altitude = Number.isFinite(altitudeValue)
      ? (altitudeReference === 1 ? -altitudeValue : altitudeValue)
      : null;

    return normalizePhotoMetadata({
      capturedAt,
      latitude,
      longitude,
      altitude,
      make: reader.readAscii(ifd0.get(0x010f)),
      model: reader.readAscii(ifd0.get(0x0110)),
    });
  } catch {
    return {};
  }
}

export async function extractPhotoMetadata(file) {
  if (!file || typeof file.arrayBuffer !== 'function') return {};
  const isLikelyJpeg = /jpe?g/i.test(file.type || '') || /\.jpe?g$/i.test(file.name || '');
  if (!isLikelyJpeg) return {};
  return readJpegPhotoMetadata(await file.arrayBuffer());
}

export function normalizePhotoMetadata(value = {}) {
  const hasLatitudeValue = value.latitude !== null && value.latitude !== undefined && value.latitude !== '';
  const hasLongitudeValue = value.longitude !== null && value.longitude !== undefined && value.longitude !== '';
  const latitude = hasLatitudeValue ? Number(value.latitude) : null;
  const longitude = hasLongitudeValue ? Number(value.longitude) : null;
  const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
  const hasAltitudeValue = value.altitude !== null && value.altitude !== undefined && value.altitude !== '';
  const make = typeof value.make === 'string' ? value.make.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const capturedAt = typeof value.capturedAt === 'string' ? value.capturedAt.trim() : '';
  const camera = [make, model].filter((part, index, list) => part && list.indexOf(part) === index).join(' ');

  return {
    capturedAt,
    latitude: hasLocation ? latitude : null,
    longitude: hasLocation ? longitude : null,
    altitude: hasAltitudeValue && Number.isFinite(Number(value.altitude)) ? Number(value.altitude) : null,
    make,
    model,
    showCapturedAt: Boolean(capturedAt && value.showCapturedAt),
    showLocation: Boolean(hasLocation && value.showLocation),
    showCamera: Boolean(camera && value.showCamera),
  };
}

export function applyDefaultPhotoMetadataVisibility(value = {}) {
  const normalized = normalizePhotoMetadata(value);
  return normalizePhotoMetadata({
    ...normalized,
    showCapturedAt: Boolean(normalized.capturedAt),
    // Location is intentionally opt-in because publishing it can reveal a
    // private home or workplace address.
    showLocation: false,
    showCamera: Boolean(normalized.make || normalized.model),
  });
}

export function getPhotoMetadataAvailability(metadata = {}) {
  const value = normalizePhotoMetadata(metadata);
  return {
    capturedAt: Boolean(value.capturedAt),
    location: Number.isFinite(value.latitude) && Number.isFinite(value.longitude),
    camera: Boolean(value.make || value.model),
  };
}

export function formatCapturedAt(value) {
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/)
    : null;
  if (!match) return '';
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日 ${match[4]}:${match[5]}`;
}

export function formatPhotoLocation(metadata = {}) {
  const value = normalizePhotoMetadata(metadata);
  if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) return '';
  return `${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)}`;
}

export function formatCamera(metadata = {}) {
  const value = normalizePhotoMetadata(metadata);
  return [value.make, value.model].filter((part, index, list) => part && list.indexOf(part) === index).join(' ');
}
