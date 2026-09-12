#!/usr/bin/env node
/**
 * Z2M -> ESP32 declarative IR generator.
 *
 * This build intentionally never serializes executable converter functions.
 * It extracts stable device metadata, exposes, fingerprints, endpoint hints,
 * converter keys/clusters and safe generic ZCL rules for the ESP32 runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const out = process.argv[2] || 'build_ir';
fs.mkdirSync(out, {recursive: true});

let devicesMod;
try {
  devicesMod = await import('zigbee-herdsman-converters/devices/index');
} catch (err) {
  console.error('ERROR: cannot import zigbee-herdsman-converters/devices/index');
  console.error(err?.stack || err);
  process.exit(1);
}

const defs = devicesMod.default || devicesMod.definitions || [];
if (!Array.isArray(defs)) {
  console.error('ERROR: upstream definitions export is not an array');
  console.error('Exports:', Object.keys(devicesMod));
  process.exit(1);
}

let zhc = null;
try {
  zhc = await import('zigbee-herdsman-converters');
} catch (err) {
  console.warn('WARN: root converter package import failed; continuing with base definitions');
}

function safeString(v) { return typeof v === 'string' ? v : ''; }
function exposeType(x) { return x?.type || x?.name || ''; }
function exposeName(x) { return x?.name || x?.property || ''; }
function normalizeNumber(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const h = Number.parseInt(v, 0);
    if (Number.isFinite(h)) return h;
  }
  return fallback;
}
function lowerText(v) { return JSON.stringify(v ?? '').toLowerCase(); }
function hasText(text, names) { return names.some(n => text.includes(n)); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function hex16(n) { return `0x${normalizeNumber(n).toString(16).padStart(4, '0').toUpperCase()}`; }

function callExposes(d) {
  try {
    return typeof d.exposes === 'function' ? (d.exposes({isDummyDevice: true}, {}) || []) : (d.exposes || []);
  } catch (e) {
    return [];
  }
}

function prepare(d) {
  try {
    if (zhc?.prepareDefinition) return zhc.prepareDefinition(d);
  } catch (e) {
    // Some releases expose prepareDefinition but a particular definition may
    // require runtime context. Fall back to the base definition.
  }
  return d;
}

function endpointHints(d) {
  const out = [];
  const fingerprints = Array.isArray(d.fingerprint) ? d.fingerprint : [];
  for (const f of fingerprints) {
    for (const ep of (f.endpoints || [])) {
      out.push({
        id: normalizeNumber(ep.ID),
        profileId: normalizeNumber(ep.profileID),
        inputClusters: unique((ep.inputClusters || []).map(normalizeNumber)),
        outputClusters: unique((ep.outputClusters || []).map(normalizeNumber)),
      });
    }
  }
  return out;
}

function genericRules(exposes, text) {
  const fz = [], tz = [];
  const addF = (cluster, attr, type, field, matter_cluster = '', matter_attr = '', multiply = 1) => {
    fz.push({cluster, attr, endpoint: 0, type, multiply, expose_to: field, matter_cluster, matter_attr});
  };

  if (hasText(text, ['temperature'])) addF('0x0402', '0x0000', 'int16', 'temperature', 'temperature_measurement', 'measured_value', 0.01);
  if (hasText(text, ['humidity'])) addF('0x0405', '0x0000', 'uint16', 'humidity', 'relative_humidity_measurement', 'measured_value', 0.01);
  if (hasText(text, ['occupancy', 'presence'])) addF('0x0406', '0x0000', 'uint8', 'occupancy', 'occupancy_sensing', 'occupancy_detected', 1);
  if (hasText(text, ['contact'])) addF('0x0500', '0x0002', 'uint8', 'contact', 'boolean_state', 'state_value', 1);
  if (hasText(text, ['battery'])) addF('0x0001', '0x0021', 'uint8', 'battery', 'power_source', 'bat_percent_remaining', 0.5);
  if (hasText(text, ['illuminance'])) addF('0x0400', '0x0000', 'uint16', 'illuminance', 'illuminance_measurement', 'measured_value', 1);
  if (hasText(text, ['power'])) addF('0x0702', '0x0000', 'uint48', 'power', '', '', 1);
  if (hasText(text, ['voltage'])) addF('0x0B04', '0x0505', 'uint16', 'voltage', '', '', 1);
  if (hasText(text, ['current'])) addF('0x0B04', '0x0508', 'uint16', 'current', '', '', 1);

  if (hasText(text, ['state', 'switch', 'on_off', 'light'])) {
    addF('0x0006', '0x0000', 'bool', 'state', 'on_off', 'on_off', 1);
    tz.push({field:'state', endpoint:0, matter_cluster:'on_off', matter_cmd:'toggle', zcl_cluster:'0x0006', zcl_cmd:'0x02', zcl_cmd_on:'0x01', zcl_cmd_off:'0x00'});
  }
  if (hasText(text, ['brightness', 'level'])) {
    addF('0x0008', '0x0000', 'uint8', 'brightness', 'level_control', 'current_level', 1);
    tz.push({field:'brightness', endpoint:0, matter_cluster:'level_control', matter_cmd:'move_to_level', zcl_cluster:'0x0008', zcl_cmd:'0x04'});
  }
  if (hasText(text, ['color_temperature', 'color_temp'])) {
    tz.push({field:'color_temp', endpoint:0, matter_cluster:'color_control', matter_cmd:'move_to_color_temperature', zcl_cluster:'0x0300', zcl_cmd:'0x0A'});
  }
  if (hasText(text, ['color_xy', 'hue', 'saturation', 'color'])) {
    tz.push({field:'color', endpoint:0, matter_cluster:'color_control', matter_cmd:'move_to_color', zcl_cluster:'0x0300', zcl_cmd:'0x07'});
  }
  if (hasText(text, ['dp', 'tuya', 'datapoint']) || text.includes('0xef00')) {
    addF('0xEF00', '0x0000', 'tuya_dp', 'tuya_data', '', '', 1);
  }
  return {fromZigbee:fz, toZigbee:tz};
}

function extractConverterHints(d) {
  const fz = Array.isArray(d.fromZigbee) ? d.fromZigbee : [];
  const tz = Array.isArray(d.toZigbee) ? d.toZigbee : [];
  const from = fz.map(x => ({
    type: safeString(x?.type),
    cluster: safeString(x?.cluster) || (typeof x?.cluster === 'number' ? hex16(x.cluster) : ''),
    keys: Array.isArray(x?.keys) ? x.keys.map(String) : [],
    key: Array.isArray(x?.key) ? x.key.map(String) : (x?.key ? [String(x.key)] : []),
  }));
  const to = tz.map(x => ({
    key: Array.isArray(x?.key) ? x.key.map(String) : (x?.key ? [String(x.key)] : []),
    type: safeString(x?.type),
  }));
  return {from, to};
}

function classify(text) {
  if (hasText(text, ['cover', 'curtain', 'blind', 'shutter', 'window_covering'])) return 'window_covering';
  if (hasText(text, ['climate', 'target_temperature', 'system_mode', 'thermostat'])) return 'thermostat';
  if (hasText(text, ['color_temp', 'color_xy', 'hue', 'saturation'])) return 'color_light';
  if (hasText(text, ['brightness', 'level_control'])) return 'dimmable_light';
  if (hasText(text, ['water_leak', 'leak'])) return 'water_leak_sensor';
  if (hasText(text, ['smoke', 'gas'])) return 'smoke_sensor';
  if (hasText(text, ['occupancy', 'presence'])) return 'occupancy_sensor';
  if (hasText(text, ['contact'])) return 'contact_sensor';
  if (hasText(text, ['humidity'])) return 'humidity_sensor';
  if (hasText(text, ['temperature'])) return 'temp_sensor';
  if (hasText(text, ['illuminance'])) return 'light_sensor';
  if (hasText(text, ['switch', 'state'])) return 'on_off_switch';
  return 'unknown';
}

const index = {};
const records = [];
const seenRecordKeys = new Set();
let preparedCount = 0;
let failedPrepare = 0;

for (const base of defs) {
  const d = prepare(base);
  if (d !== base) preparedCount++;

  let exposes = callExposes(d);
  const text = lowerText(exposes);
  const models = unique([...(d.zigbeeModel || []), ...(d.fingerprint || []).map(f => f.modelID)]);
  if (!models.length) continue;

  const safe = genericRules(exposes, text);
  const converterHints = extractConverterHints(d);
  const endpoints = endpointHints(d);
  const category = classify(text);
  const manufacturerNames = unique((d.fingerprint || []).map(f => f.manufacturerName));
  const vendor = safeString(d.vendor) || manufacturerNames[0] || '';
  const definitionKey = safeString(d.model) || models[0];
  const filename = `z2m_${crypto.createHash('sha1').update(definitionKey).digest('hex').slice(0, 12)}.json`;

  const record = {
    format: 'z2m-esp32-ir-v2',
    filename,
    model: safeString(d.model) || models[0],
    models,
    vendor,
    manufacturers: manufacturerNames,
    description: safeString(d.description),
    category,
    homekit_type: category,
    matter_type: category,
    fromZigbee: safe.fromZigbee,
    toZigbee: safe.toZigbee,
    converterHints,
    endpoints,
    exposes: exposes.map(e => ({type: exposeType(e), name: exposeName(e), property: e?.property || '', access: e?.access, unit: e?.unit})),
    flags: {
      tuya: text.includes('tuya') || text.includes('0xef00'),
      battery: text.includes('battery'),
      multiEndpoint: endpoints.length > 1,
      hasConfigure: typeof d.configure === 'function',
      hasOnEvent: typeof d.onEvent === 'function',
    },
  };

  const key = `${record.model}\u0000${vendor}`;
  if (seenRecordKeys.has(key)) continue;
  seenRecordKeys.add(key);
  records.push(record);
  for (const m of models) index[m] = filename;
}

records.sort((a,b) => a.model.localeCompare(b.model));
const ndjson = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
const idxBody = JSON.stringify(index);
fs.writeFileSync(path.join(out, 'z2m_bundle.ndjson'), ndjson);
fs.writeFileSync(path.join(out, 'z2m_index.json'), idxBody);

const b = Buffer.from(ndjson);
const ib = Buffer.from(idxBody);
const manifest = {
  format: 'z2m-esp32-manifest-v3',
  ir_version: 2,
  generated_at: new Date().toISOString(),
  source: 'zigbee-herdsman-converters',
  source_version: process.env.ZHC_VERSION || 'unknown',
  bundle: 'z2m_bundle.ndjson',
  sha256: crypto.createHash('sha256').update(b).digest('hex'),
  bytes: b.length,
  index: 'z2m_index.json',
  index_sha256: crypto.createHash('sha256').update(ib).digest('hex'),
  index_bytes: ib.length,
  device_count: records.length,
  model_count: Object.keys(index).length,
  prepared_definitions: preparedCount,
  compiler_note: 'Executable Z2M JS is not copied to ESP32; converter behavior is represented as declarative hints/generic ZCL rules.',
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Loaded ${defs.length} upstream definitions`);
console.log(`Prepared ${preparedCount} definitions`);
console.log(`Generated ${records.length} device definitions / ${Object.keys(index).length} model aliases`);
console.log(`NDJSON ${b.length} bytes`);
