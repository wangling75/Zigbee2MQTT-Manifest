#!/usr/bin/env node
/**
 * Z2M -> ESP32 Converter Extractor & IR v3 Generator
 * Compatible with latest zigbee-herdsman-converters
 * Uses prepareDefinition() to fully expand modernExtend, fromZigbee, toZigbee,
 * configure, fingerprint, endpoints, and Tuya DP profiles.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const outDir = process.argv[2] || 'build_ir';
fs.mkdirSync(outDir, { recursive: true });

// Import ZHC core modules
const zhc = await import('zigbee-herdsman-converters');
const devMod = await import('zigbee-herdsman-converters/devices/index');
const defs = devMod.default?.default || devMod.default || devMod.definitions || [];

let zh = null;
try {
  zh = await import('zigbee-herdsman');
} catch (e) {
  // Optional fallback
}

let tuya = null;
try {
  tuya = await import('zigbee-herdsman-converters/lib/tuya');
} catch (e) {}

console.log(`[IR Extractor] Loaded ${defs.length} definitions from zigbee-herdsman-converters.`);

// Cluster name to uint16 ID mapping
const CLUSTER_NAME_TO_ID = {
  genBasic: 0x0000,
  genPowerCfg: 0x0001,
  genDeviceTempCfg: 0x0002,
  genIdentify: 0x0003,
  genGroups: 0x0004,
  genScenes: 0x0005,
  genOnOff: 0x0006,
  genOnOffSwitchCfg: 0x0007,
  genLevelCtrl: 0x0008,
  genAlarms: 0x0009,
  genTime: 0x000A,
  closuresDoorLock: 0x0101,
  closuresWindowCovering: 0x0102,
  hvacThermostat: 0x0201,
  hvacFanCtrl: 0x0202,
  hvacUserInterfaceCfg: 0x0204,
  lightingColorCtrl: 0x0300,
  lightingBallastCfg: 0x0301,
  msIlluminanceMeasurement: 0x0400,
  msIlluminanceLevelSensing: 0x0401,
  msTemperatureMeasurement: 0x0402,
  msPressureMeasurement: 0x0403,
  msFlowMeasurement: 0x0404,
  msRelativeHumidity: 0x0405,
  msOccupancySensing: 0x0406,
  msCO2: 0x040D,
  ssIasZone: 0x0500,
  ssIasAce: 0x0501,
  ssIasWd: 0x0502,
  seMetering: 0x0702,
  haElectricalMeasurement: 0x0B04,
  manuSpecificTuya: 0xEF00,
  manuSpecificLumi: 0xFCC0,
};

if (zh && zh.Zcl && zh.Zcl.Clusters) {
  for (const [name, cl] of Object.entries(zh.Zcl.Clusters)) {
    if (cl && typeof cl.ID === 'number') {
      CLUSTER_NAME_TO_ID[name] = cl.ID;
    }
  }
}

function resolveClusterId(cl) {
  if (typeof cl === 'number') return cl;
  if (!cl) return 0;
  if (typeof cl === 'string') {
    const trimmed = cl.trim();
    if (CLUSTER_NAME_TO_ID[trimmed] !== undefined) {
      return CLUSTER_NAME_TO_ID[trimmed];
    }
    if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
      return parseInt(trimmed, 16);
    }
    const parsed = parseInt(trimmed, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return 0;
}

function hex16(num) {
  return '0x' + (num & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
}

// Category classification
function classifyCategory(exposesList, descStr = '', clusterIds = new Set()) {
  const s = (JSON.stringify(exposesList) + ' ' + descStr).toLowerCase();

  if (s.includes('cover') || s.includes('curtain') || s.includes('blind') || s.includes('shutter') || clusterIds.has(0x0102)) {
    return 'window_covering';
  }
  if (s.includes('lock') || clusterIds.has(0x0101)) {
    return 'door_lock';
  }
  if (s.includes('climate') || s.includes('thermostat') || s.includes('target_temperature') || clusterIds.has(0x0201)) {
    return 'thermostat';
  }
  if (s.includes('color_xy') || s.includes('color_temp') || s.includes('hue') || clusterIds.has(0x0300)) {
    return 'color_light';
  }
  if (s.includes('brightness') || clusterIds.has(0x0008)) {
    return 'dimmable_light';
  }
  if (s.includes('water_leak') || s.includes('waterleak')) {
    return 'water_leak_sensor';
  }
  if (s.includes('smoke') || s.includes('gas_leak')) {
    return 'smoke_sensor';
  }
  if (s.includes('occupancy') || s.includes('presence') || clusterIds.has(0x0406)) {
    return 'occupancy_sensor';
  }
  if (s.includes('contact') || s.includes('door_state') || s.includes('window_state')) {
    return 'contact_sensor';
  }
  if (s.includes('humidity') || clusterIds.has(0x0405)) {
    return 'humidity_sensor';
  }
  if (s.includes('temperature') || clusterIds.has(0x0402)) {
    return 'temp_sensor';
  }
  if (s.includes('illuminance') || clusterIds.has(0x0400)) {
    return 'light_sensor';
  }
  if (s.includes('outlet') || s.includes('plug') || s.includes('socket')) {
    return 'on_off_plugin_unit';
  }
  if (s.includes('switch') || s.includes('state') || clusterIds.has(0x0006)) {
    return 'on_off_switch';
  }
  return 'generic_device';
}

// Extract exposes properties
function parseExposes(rawExposes) {
  let list = [];
  if (typeof rawExposes === 'function') {
    try {
      list = rawExposes({ isDummyDevice: true }, {});
    } catch {
      list = [];
    }
  } else if (Array.isArray(rawExposes)) {
    list = rawExposes;
  }
  const result = [];
  function walk(item) {
    if (!item) return;
    if (item.type === 'composite' && Array.isArray(item.features)) {
      item.features.forEach(walk);
      return;
    }
    if (Array.isArray(item.features)) {
      item.features.forEach(walk);
    }
    const prop = item.property || item.name;
    if (prop) {
      result.push({
        name: String(item.name || prop),
        property: String(prop),
        type: String(item.type || 'numeric'),
        access: typeof item.access === 'number' ? item.access : 3,
        unit: item.unit ? String(item.unit) : '',
        values: Array.isArray(item.values) ? item.values.map(String) : undefined
      });
    }
  }
  list.forEach(walk);
  return result;
}

// Extract Tuya DP definitions
function extractTuyaDatapoints(prep) {
  const dps = [];
  if (!prep.meta || !prep.meta.tuyaDatapoints) {
    return dps;
  }
  const vc = tuya ? tuya.valueConverter : {};
  const meta = prep.meta;

  for (const item of meta.tuyaDatapoints) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const dpId = item[0];
    const prop = item[1];
    if (!prop) continue;
    const conv = item[2];

    let datatype = 'value';
    let scale = 1.0;
    let offset = 0.0;
    let map = null;

    if (conv) {
      if (vc.divideBy10 && conv === vc.divideBy10) {
        datatype = 'value';
        scale = 0.1;
      } else if (vc.divideBy100 && conv === vc.divideBy100) {
        datatype = 'value';
        scale = 0.01;
      } else if (vc.divideBy1000 && conv === vc.divideBy1000) {
        datatype = 'value';
        scale = 0.001;
      } else if (vc.divideBy2 && conv === vc.divideBy2) {
        datatype = 'value';
        scale = 0.5;
      } else if (vc.raw && conv === vc.raw) {
        datatype = 'value';
        scale = 1.0;
      } else if (vc.trueFalse0 && conv === vc.trueFalse0) {
        datatype = 'bool';
      } else if (vc.trueFalse1 && conv === vc.trueFalse1) {
        datatype = 'bool';
      } else if (vc.trueFalseInvert && conv === vc.trueFalseInvert) {
        datatype = 'bool';
        scale = -1.0; // Inverted
      } else if (vc.onOff && conv === vc.onOff) {
        datatype = 'bool';
      } else if (vc.lockUnlock && conv === vc.lockUnlock) {
        datatype = 'enum';
        map = { '0': 'unlock', '1': 'lock' };
      } else if (vc.powerOnBehavior && conv === vc.powerOnBehavior) {
        datatype = 'enum';
        map = { '0': 'off', '1': 'on', '2': 'previous' };
      } else if (vc.temperatureUnit && conv === vc.temperatureUnit) {
        datatype = 'enum';
        map = { '0': 'celsius', '1': 'fahrenheit' };
      } else if (vc.batteryState && conv === vc.batteryState) {
        datatype = 'enum';
        map = { '0': 'low', '1': 'medium', '2': 'high' };
      } else if (vc.countdown && conv === vc.countdown) {
        datatype = 'value';
        scale = 1.0;
      } else if (vc.coverPosition && conv === vc.coverPosition) {
        datatype = 'value';
        scale = 1.0;
      } else if (vc.coverPositionInverted && conv === vc.coverPositionInverted) {
        datatype = 'value';
        scale = -1.0;
        offset = 100.0;
      } else {
        // Check string conversion inspection for dynamic factories
        const fromStr = conv.from ? conv.from.toString() : '';
        if (fromStr.includes('/ 10') || fromStr.includes('0.1')) {
          datatype = 'value';
          scale = 0.1;
        } else if (fromStr.includes('/ 100') || fromStr.includes('0.01')) {
          datatype = 'value';
          scale = 0.01;
        } else if (fromStr.includes('/ 1000') || fromStr.includes('0.001')) {
          datatype = 'value';
          scale = 0.001;
        }
      }
    }

    // Check metadata thermostat lookup maps
    if (prop === 'system_mode' && meta.tuyaThermostatSystemMode) {
      datatype = 'enum';
      map = { ...meta.tuyaThermostatSystemMode };
    } else if (prop === 'preset' && meta.tuyaThermostatPreset) {
      datatype = 'enum';
      map = { ...meta.tuyaThermostatPreset };
    }

    dps.push({
      dp: Number(dpId),
      target: String(prop),
      datatype,
      scale,
      offset,
      map
    });
  }
  return dps;
}

// Extract Endpoints
function extractEndpoints(prep) {
  const epMap = {};
  if (typeof prep.endpoint === 'function') {
    try {
      const dummyDevice = {
        endpoints: [
          { ID: 1, inputClusters: [6, 8], outputClusters: [] },
          { ID: 2, inputClusters: [6], outputClusters: [] },
          { ID: 3, inputClusters: [6], outputClusters: [] },
          { ID: 4, inputClusters: [6], outputClusters: [] },
          { ID: 10, inputClusters: [6], outputClusters: [] },
          { ID: 11, inputClusters: [6], outputClusters: [] }
        ],
        getEndpoint: (id) => ({ ID: id, inputClusters: [6], outputClusters: [] })
      };
      const res = prep.endpoint(dummyDevice);
      if (res && typeof res === 'object') {
        for (const [k, v] of Object.entries(res)) {
          if (typeof v === 'number') epMap[k] = v;
        }
      }
    } catch {}
  } else if (prep.endpoint && typeof prep.endpoint === 'object') {
    for (const [k, v] of Object.entries(prep.endpoint)) {
      if (typeof v === 'number') epMap[k] = v;
    }
  }

  // Check fingerprint endpoints
  if (Array.isArray(prep.fingerprint)) {
    for (const fp of prep.fingerprint) {
      if (Array.isArray(fp.endpoints)) {
        for (const ep of fp.endpoints) {
          if (ep.ID) epMap[`ep_${ep.ID}`] = ep.ID;
        }
      }
    }
  }

  if (Object.keys(epMap).length === 0) {
    epMap['default'] = 1;
  }
  return epMap;
}

// Convert fromZigbee list to IR v3 rules
function generateFromZigbeeIR(prep, clusterIds) {
  const rules = [];
  const addedKeys = new Set();

  function addRule(rule) {
    const key = `${rule.cluster}:${rule.attr}:${rule.target}:${rule.endpoint || 0}`;
    if (!addedKeys.has(key)) {
      addedKeys.add(key);
      rules.push(rule);
    }
  }

  // Iterate over prep.fromZigbee
  if (Array.isArray(prep.fromZigbee)) {
    for (const fz of prep.fromZigbee) {
      if (!fz) continue;
      const clusters = Array.isArray(fz.cluster) ? fz.cluster : [fz.cluster];
      for (const clName of clusters) {
        const clId = resolveClusterId(clName);
        if (!clId) continue;
        clusterIds.add(clId);

        // Standard ZCL Cluster Mapping
        if (clId === 0x0006) { // OnOff
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0006), attr: hex16(0x0000), datatype: 'bool', scale: 1.0, offset: 0.0, target: 'state' });
        } else if (clId === 0x0008) { // LevelControl
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0008), attr: hex16(0x0000), datatype: 'uint8', scale: 1.0, offset: 0.0, target: 'brightness' });
        } else if (clId === 0x0300) { // ColorControl
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0300), attr: hex16(0x0007), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'color_temp' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0300), attr: hex16(0x0003), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'color_x' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0300), attr: hex16(0x0004), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'color_y' });
        } else if (clId === 0x0402) { // Temperature
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0402), attr: hex16(0x0000), datatype: 'int16', scale: 0.01, offset: 0.0, target: 'temperature' });
        } else if (clId === 0x0405) { // Humidity
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0405), attr: hex16(0x0000), datatype: 'uint16', scale: 0.01, offset: 0.0, target: 'humidity' });
        } else if (clId === 0x0406) { // Occupancy
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0406), attr: hex16(0x0000), datatype: 'uint8', scale: 1.0, offset: 0.0, target: 'occupancy' });
        } else if (clId === 0x0400) { // Illuminance
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0400), attr: hex16(0x0000), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'illuminance' });
        } else if (clId === 0x0500) { // IAS Zone
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0500), attr: hex16(0x0002), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'contact' });
        } else if (clId === 0x0001) { // PowerCfg
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0001), attr: hex16(0x0021), datatype: 'uint8', scale: 0.5, offset: 0.0, target: 'battery' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0001), attr: hex16(0x0020), datatype: 'uint8', scale: 0.1, offset: 0.0, target: 'voltage' });
        } else if (clId === 0x0B04) { // Electrical Measurement
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0B04), attr: hex16(0x050B), datatype: 'int16', scale: 1.0, offset: 0.0, target: 'power' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0B04), attr: hex16(0x0505), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'voltage' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0B04), attr: hex16(0x0508), datatype: 'uint16', scale: 0.001, offset: 0.0, target: 'current' });
        } else if (clId === 0x0702) { // Metering
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0702), attr: hex16(0x0000), datatype: 'uint48', scale: 0.001, offset: 0.0, target: 'energy' });
        } else if (clId === 0x0101) { // Door Lock
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0101), attr: hex16(0x0000), datatype: 'uint8', scale: 1.0, offset: 0.0, target: 'lock_state' });
        } else if (clId === 0x0102) { // Window Covering
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0102), attr: hex16(0x0008), datatype: 'uint8', scale: 1.0, offset: 0.0, target: 'position' });
        } else if (clId === 0x0201) { // Thermostat
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0201), attr: hex16(0x0000), datatype: 'int16', scale: 0.01, offset: 0.0, target: 'local_temperature' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0201), attr: hex16(0x0012), datatype: 'int16', scale: 0.01, offset: 0.0, target: 'occupied_heating_setpoint' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0201), attr: hex16(0x001C), datatype: 'enum8', scale: 1.0, offset: 0.0, target: 'system_mode' });
        }
      }
    }
  }

  return rules;
}

// Convert toZigbee list to IR v3 rules
function generateToZigbeeIR(prep, clusterIds) {
  const rules = [];
  const keys = new Set();
  if (Array.isArray(prep.toZigbee)) {
    for (const tz of prep.toZigbee) {
      if (Array.isArray(tz.key)) {
        tz.key.forEach(k => keys.add(k));
      }
    }
  }

  if (keys.has('state')) {
    rules.push({
      op: 'COMMAND',
      target: 'state',
      cluster: hex16(0x0006),
      cmd: hex16(0x02), // Toggle
      cmd_on: hex16(0x01), // On
      cmd_off: hex16(0x00), // Off
      scale: 1.0
    });
  }
  if (keys.has('brightness') || keys.has('brightness_percent')) {
    rules.push({
      op: 'COMMAND',
      target: 'brightness',
      cluster: hex16(0x0008),
      cmd: hex16(0x04), // MoveToLevelWithOnOff
      scale: 1.0
    });
  }
  if (keys.has('color_temp')) {
    rules.push({
      op: 'COMMAND',
      target: 'color_temp',
      cluster: hex16(0x0300),
      cmd: hex16(0x0A), // MoveToColorTemperature
      scale: 1.0
    });
  }
  if (keys.has('color') || keys.has('color_xy')) {
    rules.push({
      op: 'COMMAND',
      target: 'color_xy',
      cluster: hex16(0x0300),
      cmd: hex16(0x07), // MoveToColor
      scale: 1.0
    });
  }
  if (keys.has('position') || keys.has('cover')) {
    rules.push({
      op: 'COMMAND',
      target: 'position',
      cluster: hex16(0x0102),
      cmd: hex16(0x05), // GoToLiftPercentage
      scale: 1.0
    });
  }
  if (keys.has('occupied_heating_setpoint')) {
    rules.push({
      op: 'WRITE_ATTRIBUTE',
      target: 'occupied_heating_setpoint',
      cluster: hex16(0x0201),
      attr: hex16(0x0012),
      datatype: 'int16',
      scale: 100.0
    });
  }
  if (keys.has('system_mode')) {
    rules.push({
      op: 'WRITE_ATTRIBUTE',
      target: 'system_mode',
      cluster: hex16(0x0201),
      attr: hex16(0x001C),
      datatype: 'enum8',
      scale: 1.0
    });
  }

  return rules;
}

// Process all definitions
const records = [];
const modelIndex = {};
const fingerprintIndex = {};

let processedCount = 0;
let modernExtendCount = 0;
let tuyaDpCount = 0;
let fingerprintCount = 0;

for (let i = 0; i < defs.length; i++) {
  const d = defs[i];
  let prep = null;
  try {
    prep = await zhc.prepareDefinition(d);
  } catch (err) {
    prep = d;
  }

  const model = String(prep.model || d.model || '').trim();
  if (!model) continue;

  const vendor = String(prep.vendor || d.vendor || '').trim();
  const description = String(prep.description || d.description || '').trim();

  // Models list
  const models = new Set();
  models.add(model);
  if (Array.isArray(prep.zigbeeModel)) {
    prep.zigbeeModel.forEach(m => m && models.add(String(m).trim()));
  }
  if (Array.isArray(d.zigbeeModel)) {
    d.zigbeeModel.forEach(m => m && models.add(String(m).trim()));
  }

  // Fingerprints list
  const fingerprints = [];
  const rawFps = [...(prep.fingerprint || []), ...(d.fingerprint || [])];
  for (const fp of rawFps) {
    if (!fp) continue;
    const fpModel = fp.modelID ? String(fp.modelID).trim() : '';
    const fpMfg = fp.manufacturerName ? String(fp.manufacturerName).trim() : '';
    if (fpModel || fpMfg) {
      fingerprints.push({
        modelID: fpModel,
        manufacturerName: fpMfg,
        manufacturerCode: fp.manufacturerCode || 0
      });
      if (fpModel) models.add(fpModel);
    }
  }

  // Exposes
  const exposes = parseExposes(prep.exposes || d.exposes);

  // Clusters, Endpoints & IR Rules
  const clusterIds = new Set();
  const endpoints = extractEndpoints(prep);
  const fromZigbeeIR = generateFromZigbeeIR(prep, clusterIds);
  const toZigbeeIR = generateToZigbeeIR(prep, clusterIds);
  const tuyaDatapoints = extractTuyaDatapoints(prep);

  if (d.extend) modernExtendCount++;
  if (tuyaDatapoints.length > 0) tuyaDpCount++;
  if (fingerprints.length > 0) fingerprintCount += fingerprints.length;

  // Category
  const category = classifyCategory(exposes, description, clusterIds);

  // Flags: bit0: tuya, bit1: battery, bit2: multiep, bit3: color, bit4: reporting
  let flags = 0;
  const s = (vendor + ' ' + model + ' ' + description).toLowerCase();
  const isTuya = s.includes('tuya') || s.includes('_tz') || clusterIds.has(0xEF00) || tuyaDatapoints.length > 0;
  if (isTuya) flags |= 0x0001;
  const isBattery = category.includes('sensor') || s.includes('battery') || clusterIds.has(0x0001);
  if (isBattery) flags |= 0x0002;
  if (Object.keys(endpoints).length > 1) flags |= 0x0004;
  if (category === 'color_light' || clusterIds.has(0x0300)) flags |= 0x0008;
  if (fromZigbeeIR.length > 0) flags |= 0x0010;

  // Configure reporting & binds
  const binds = Array.from(clusterIds).map(hex16);
  const reporting = fromZigbeeIR.map(f => ({
    cluster: f.cluster,
    attr: f.attr,
    min: f.cluster === hex16(0x0006) ? 0 : 10,
    max: 3600,
    change: 1
  }));

  const filename = `z2m_${crypto.createHash('sha1').update(model).digest('hex').slice(0, 10)}.json`;

  const record = {
    filename,
    model,
    vendor,
    description,
    category,
    matter_type: category,
    homekit_type: category,
    models: Array.from(models),
    fingerprints,
    flags,
    endpoints,
    fromZigbee: fromZigbeeIR,
    toZigbee: toZigbeeIR,
    tuyaDatapoints,
    configure: { binds, reporting },
    exposes
  };

  records.push(record);

  // Update indexes
  for (const m of models) {
    modelIndex[m] = filename;
  }
  for (const fp of fingerprints) {
    const key = `${fp.manufacturerName}|${fp.modelID}`;
    fingerprintIndex[key] = filename;
  }

  processedCount++;
}

console.log(`[IR Extractor] Successfully compiled ${records.length} records.`);
console.log(`  - With modernExtend: ${modernExtendCount}`);
console.log(`  - With Tuya Datapoints: ${tuyaDpCount}`);
console.log(`  - Total Fingerprints: ${fingerprintCount}`);
console.log(`  - Unique Model Keys: ${Object.keys(modelIndex).length}`);
console.log(`  - Unique Fingerprint Keys: ${Object.keys(fingerprintIndex).length}`);

// Write outputs
const ndjson = records.map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(path.join(outDir, 'z2m_bundle.ndjson'), ndjson);

const idxBody = JSON.stringify(modelIndex, null, 2);
fs.writeFileSync(path.join(outDir, 'z2m_index.json'), idxBody);

const fpBody = JSON.stringify(fingerprintIndex, null, 2);
fs.writeFileSync(path.join(outDir, 'z2m_fingerprints.json'), fpBody);

const b = Buffer.from(ndjson);
const ib = Buffer.from(idxBody);

const manifest = {
  format: 'z2m-esp32-manifest-v3',
  version: '3.0.0',
  generated_at: new Date().toISOString(),
  source: 'zigbee-herdsman-converters',
  source_version: process.env.ZHC_VERSION || 'latest',
  bundle: 'z2m_bundle.ndjson',
  sha256: crypto.createHash('sha256').update(b).digest('hex'),
  bytes: b.length,
  index: 'z2m_index.json',
  index_sha256: crypto.createHash('sha256').update(ib).digest('hex'),
  index_bytes: ib.length,
  device_count: records.length,
  model_keys_count: Object.keys(modelIndex).length,
  fingerprint_keys_count: Object.keys(fingerprintIndex).length
};

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`[IR Extractor] Output written to ${outDir}/: z2m_bundle.ndjson (${(b.length/1024/1024).toFixed(2)} MB), z2m_index.json, manifest.json`);
