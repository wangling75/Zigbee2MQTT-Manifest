#!/usr/bin/env node
/**
 * Z2M -> ESP32 Converter Extractor & IR v5 Generator
 * Compatible with latest zigbee-herdsman-converters
 * Uses prepareDefinition() to fully expand modernExtend, fromZigbee, toZigbee,
 * configure, fingerprint, endpoints, and Tuya DP profiles.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let legacyTuya = null;
try {
  legacyTuya = await import('zigbee-herdsman-converters/lib/legacy');
} catch {}

// Tuya's modern DP factories build fresh closures around getHandlersForDP().
// The generated converter objects intentionally expose only cluster/type/
// convert, so meta.tuyaDatapoints is not present for these definitions.
// Tag the official converter instances with the factory arguments before
// the device modules are loaded. This is metadata only: the converter
// function itself remains untouched and remains the source of truth.
let tuyaModernExtend = null;
try {
  const tuyaModule = await import('zigbee-herdsman-converters/lib/tuya');
  tuyaModernExtend = tuyaModule.modernExtend || tuyaModule.default?.modernExtend || null;
  if (tuyaModernExtend) {
    const dpFactories = [
      'dpEnumLookup', 'dpBinary', 'dpNumeric', 'dpLight',
      'dpTemperature', 'dpHumidity', 'dpBattery', 'dpBatteryState',
      'dpTemperatureUnit', 'dpContact', 'dpAction', 'dpIlluminance',
      'dpGas', 'dpOnOff', 'dpPowerOnBehavior', 'dpBacklightMode',
      'dpChildLock', 'dpTHZBSettings',
    ];
    const tagFactoryResult = (factoryName, args, result) => {
      if (!result || typeof result !== 'object') return result;
      const metadata = {
        factory: String(factoryName || ''),
        args: args && typeof args === 'object' ? {...args} : {},
      };
      for (const fz of (Array.isArray(result.fromZigbee) ? result.fromZigbee : [])) {
        if (!fz || typeof fz !== 'object') continue;
        if (fz.__z2mTuyaDpFactory) continue;
        Object.defineProperty(fz, '__z2mTuyaDpFactory', {
          // dpLight/dpTemperature/dpHumidity delegate to inner DP factories.
          // Preserve the innermost exact state/brightness/scale arguments.
          value: metadata,
          enumerable: false,
          configurable: true,
        });
      }
      for (const tz of (Array.isArray(result.toZigbee) ? result.toZigbee : [])) {
        if (!tz || typeof tz !== 'object') continue;
        if (tz.__z2mTuyaDpFactory) continue;
        Object.defineProperty(tz, '__z2mTuyaDpFactory', {
          // Do not overwrite metadata added by an inner factory.
          value: metadata,
          enumerable: false,
          configurable: true,
        });
      }
      return result;
    };
    for (const factoryName of dpFactories) {
      const original = tuyaModernExtend[factoryName];
      if (typeof original !== 'function') continue;
      tuyaModernExtend[factoryName] = function(args = {}) {
        return tagFactoryResult(factoryName, args, original.call(this, args));
      };
    }
  }
} catch {}

// lumiBattery() stores its curve and attribute IDs in closure variables.
// Wrap the exported factory once so the generator can serialize those
// official values into the Bundle without maintaining a model allowlist.
let lumiBatteryFactory = null;
try {
  const lumiModule = await import('zigbee-herdsman-converters/lib/lumi');
  const lumiModernExtend = lumiModule.lumiModernExtend ||
    lumiModule.default?.lumiModernExtend;
  if (lumiModernExtend && typeof lumiModernExtend.lumiBattery === 'function') {
    const originalLumiBattery = lumiModernExtend.lumiBattery;
    lumiBatteryFactory = originalLumiBattery;
    lumiModernExtend.lumiBattery = function(args = {}) {
      const result = originalLumiBattery(args);
      const metadata = { ...args };
      for (const fz of result && result.fromZigbee || []) {
        Object.defineProperty(fz, '__z2mBatteryArgs', {
          value: metadata,
          enumerable: false,
        });
      }
      return result;
    };
  }
} catch {}


const outDir = process.argv[2] || 'build_ir';
fs.mkdirSync(outDir, { recursive: true });

// Import ZHC core modules
const zhc = await import('zigbee-herdsman-converters');
const DECLARATIVE_FROM_ZIGBEE_KEYS = new Set([
  // Attribute converters represented by the generic cluster/attribute IR.
  'linkquality_from_basic', 'battery', 'temperature', 'device_temperature',
  'humidity', 'pm25', 'flow', 'soil_moisture', 'pressure', 'co2',
  'occupancy', 'brightness', 'color_colortemp', 'metering',
  'electrical_measurement', 'gas_metering', 'on_off',
  'on_off_force_multiendpoint', 'on_off_skip_duplicate_transaction',
  'ias_no_alarm', 'ias_siren', 'ias_water_leak_alarm_1',
  'ias_water_leak_alarm_1_report', 'ias_vibration_alarm_1',
  'ias_gas_alarm_1', 'ias_gas_alarm_2', 'ias_smoke_alarm_1',
  'ias_contact_alarm_1', 'ias_contact_alarm_1_report',
  'ias_carbon_monoxide_alarm_1', 'ias_carbon_monoxide_alarm_1_gas_alarm_2',
  'ias_sos_alarm_2', 'ias_occupancy_alarm_1',
  'ias_occupancy_alarm_1_report', 'ias_occupancy_alarm_2',
  'ias_alarm_only_alarm_1', 'ias_occupancy_only_alarm_2',
  'cover_position_tilt', 'cover_position_via_brightness',
  'cover_state_via_onoff', 'curtain_position_analog_output',
  // Command-event converters implemented by generateCommandEventIR().
  'command_store', 'command_recall', 'command_panic', 'command_arm',
  'command_cover_stop', 'command_cover_open', 'command_cover_close',
  'command_on', 'command_off', 'command_off_with_effect', 'command_toggle',
  'command_move_to_level', 'command_move', 'command_step', 'command_stop',
  'command_move_color_temperature', 'command_stop_move_step',
  'command_step_color_temperature',
  'command_enhanced_move_to_hue_and_saturation',
  'command_move_to_hue_and_saturation', 'command_step_hue',
  'command_step_saturation', 'command_color_loop_set',
  'command_move_to_color_temp', 'command_move_to_color',
  'command_move_hue', 'command_move_to_saturation', 'command_move_to_hue',
  'command_emergency', 'command_on_state', 'command_off_state',
  'ewelink_action', 'command_status_change_notification_action',
  'ignore_command_on', 'ignore_command_off', 'ignore_command_off_with_effect',
  'ignore_command_step', 'ignore_command_stop',
  'ignore_iaszone_statuschange',
]);

function declarativeFromZigbeeKey(fz) {
  if (!fz || typeof fz.convert !== 'function') return null;
  for (const [key, candidate] of Object.entries(zhc.fromZigbee || {})) {
    if (!DECLARATIVE_FROM_ZIGBEE_KEYS.has(key) || !candidate) continue;
    if (candidate === fz || candidate.convert === fz.convert) return key;
  }
  return null;
}

const OPTIONAL_FROM_ZIGBEE_KEYS = new Set([
  'power_on_behavior', 'switch_type', 'backlight_mode', 'backlight_mode_2',
  'start_up_on_off', 'level_config', 'illuminance_raw', 'linkquality_from_basic',
]);

function optionalFromZigbeeKey(fz) {
  if (!fz || typeof fz.convert !== 'function') return null;
  for (const [key, candidate] of Object.entries(zhc.fromZigbee || {})) {
    if (!OPTIONAL_FROM_ZIGBEE_KEYS.has(key) || !candidate) continue;
    if (candidate === fz || candidate.convert === fz.convert) return key;
  }
  return null;
}

function extractBatterySemantics(prep, exposes, clusterIds) {
  const properties = new Set((Array.isArray(exposes) ? exposes : [])
    .map(exp => String(exp && exp.property || '').toLowerCase())
    .filter(Boolean));
  const batteryMeta = prep && prep.meta && prep.meta.battery && typeof prep.meta.battery === 'object'
    ? prep.meta.battery : {};
  const fromZigbee = Array.isArray(prep && prep.fromZigbee) ? prep.fromZigbee : [];
  const source = fromZigbee
    .map(fz => String(fz && fz.convert || ''))
    .join(' ')
    .replace(/\s+/g, ' ');
  const batteryConverters = fromZigbee.filter(fz => {
    const convert = String(fz && fz.convert || '');
    const cluster = String(fz && fz.cluster || '');
    return cluster === 'genPowerCfg' || cluster === 'manuSpecificLumi' ||
      /batteryPercentageRemaining|batteryVoltage|batteryAlarmState|numericAttributes2Payload/.test(convert);
  });
  const hasPowerCfg = clusterIds.has(0x0001) ||
    fromZigbee.some(fz => String(fz && fz.cluster || '') === 'genPowerCfg');
  const hasBatteryConverter = batteryConverters.length > 0;
  const enabled = hasBatteryConverter || hasPowerCfg || properties.has('battery') ||
    properties.has('battery_percentage') || properties.has('battery_level') ||
    properties.has('voltage') || properties.has('battery_voltage') ||
    properties.has('battery_low');
  if (!enabled) return null;

  const lumiBatteryArgs = batteryConverters
    .map(fz => fz && fz.__z2mBatteryArgs)
    .find(args => args && typeof args === 'object') || null;
  let voltageToPercentage = batteryMeta.voltageToPercentage;
  if (voltageToPercentage === undefined && lumiBatteryArgs) {
    voltageToPercentage = lumiBatteryArgs.voltageToPercentage;
  }
  if (voltageToPercentage === undefined) {
    const curveMatch = source.match(/voltageToPercentage\s*:\s*(\{[^}]+\}|\"[^\"]+\"|'[^']+')/);
    if (curveMatch) {
      try {
        voltageToPercentage = Function(`return (${curveMatch[1]})`)();
      } catch {}
    }
  }
  let curve = 0;
  let minVoltage = 0;
  let maxVoltage = 0;
  let voltageOffset = 0;
  if (voltageToPercentage === '3V_2100') {
    curve = 2;
  } else if (voltageToPercentage === '3V_1500_2800') {
    curve = 3;
  } else if (voltageToPercentage && typeof voltageToPercentage === 'object') {
    curve = 1;
    minVoltage = Number(voltageToPercentage.min) || 0;
    maxVoltage = Number(voltageToPercentage.max) || 0;
    voltageOffset = Number(voltageToPercentage.vOffset) || 0;
  }

  let dropPercentageValue = 0;
  let dropVoltageThreshold = 0;
  const exceptions = [];
  if (source.includes('batteryPercentageRemaining === 200') && source.includes('batteryVoltage < 30')) {
    dropPercentageValue = 200;
    dropVoltageThreshold = 30;
    const exceptionMatch = source.match(/\["([^"]+)"\]\.includes\(meta\.device\.manufacturerName\)/);
    if (exceptionMatch) exceptions.push(exceptionMatch[1]);
  }

  return {
    enabled: true,
    percentage: properties.has('battery') || properties.has('battery_percentage') ||
      properties.has('battery_level') || hasBatteryConverter,
    voltage: properties.has('voltage') || properties.has('battery_voltage') ||
      hasBatteryConverter,
    lowStatus: properties.has('battery_low'),
    dontDividePercentage: batteryMeta.dontDividePercentage === true,
    curve,
    minVoltage,
    maxVoltage,
    voltageOffset,
    dropPercentageValue,
    dropVoltageThreshold,
    exceptions,
    privateVoltageAttribute: lumiBatteryArgs ?
      (lumiBatteryArgs.voltageAttribute === undefined ? 1 :
        (Number(lumiBatteryArgs.voltageAttribute) || 0)) : 0,
    // lumiBattery() applies its default percentageAttribute: 1
    // before the fromZigbee converter captures the closure. Preserve
    // that default here so voltage-only definitions still match it.
    privatePercentageAttribute: lumiBatteryArgs ?
      (lumiBatteryArgs.percentageAttribute === undefined ? 1 :
        (Number(lumiBatteryArgs.percentageAttribute) || 0)) : 0,
    privateCluster: lumiBatteryArgs && String(lumiBatteryArgs.cluster || 'manuSpecificLumi') === 'genBasic'
      ? 'genBasic' : (lumiBatteryArgs ? 'manuSpecificLumi' : ''),
  };
}

// lumi_basic delegates every tag to numericAttributes2Payload(). Probe the
// official converter at build time so the firmware never needs a model
// allowlist. The probes recover scale, offset, polarity, and enums.
async function extractLumiSemanticRules(prep, exposes, batterySemantics) {
  // prepareDefinition() may inline the Lumi converter instead of exposing
  // it through zhc.fromZigbee. Probe the prepared definition's converters
  // directly; this keeps the extractor compatible across ZHC releases.
  const candidates = (Array.isArray(prep && prep.fromZigbee) ? prep.fromZigbee : [])
    .filter(fz => fz && typeof fz.convert === 'function')
    .filter(fz => {
      const cluster = String(fz.cluster || '');
      const source = String(fz.convert || '');
      return (cluster === 'genBasic' || cluster === 'manuSpecificLumi') &&
        source.includes('numericAttributes2Payload');
    });
  const converter = candidates[0];
  if (!converter) return [];
  const model = {
    model: String(prep && prep.model || ''),
    meta: prep && prep.meta && typeof prep.meta === 'object' ? prep.meta : {},
  };
  const meta = {
    device: {
      applicationVersion: 0,
      manufacturerName: String(prep && prep.vendor || ''),
      meta: {},
      save: () => {},
    },
  };
  const msg = {endpoint: {getDevice: () => meta.device}, data: {}};
  const probes = [0, 1, 2, 4, 10, 50, 100, 255, 1000, 65000, 65535];
  const rules = [];
  const seen = new Set();
  const lumiTags = [0,1,2,3,4,5,6,8,9,10,11,12,13,17,100,101,102,103,105,106,107,149,150,151,152,154,159,160,161,162,163,164,165,166,238,240,247,258,268,293,294,295,313,314,315,316,317,320,322,323,324,326,328,329,331,332,338,512,513,514,515,519,523,550,645,1025,1028,1032,1033,1034,1035,1055,1056,1057,1061,1063,1064,1065,1289,1299,1300,65281,65282,65522];
  for (const tag of lumiTags) {
    const outputs = [];
    for (const probe of probes) {
      try {
        const payload = await converter.convert(model, {...msg, data: {[tag]: probe}}, null, {}, meta);
        if (payload && typeof payload === 'object') outputs.push({probe, payload});
      } catch {}
    }
    if (!outputs.length) continue;
    const targets = new Set();
    for (const item of outputs) {
      for (const target of Object.keys(item.payload)) targets.add(target);
    }
    for (const target of targets) {
      const key = `${tag}|${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const samples = [];
      for (const item of outputs) {
        if (Object.prototype.hasOwnProperty.call(item.payload, target)) {
          samples.push([item.probe, item.payload[target]]);
        }
      }
      if (!samples.length) continue;
      const first = samples[0][1];
      let transform = 'identity';
      let scale = 1.0;
      let offset = 0.0;
      let flags = 0;
      let map = null;
      if (typeof first === 'boolean') {
        transform = 'boolean';
        const atOne = samples.find(item => item[0] === 1);
        if (atOne && atOne[1] === false) flags |= 0x04;
      } else if (typeof first === 'string') {
        transform = 'enum';
        map = {};
        for (const item of samples) {
          if (item[1] !== null && item[1] !== undefined) map[String(item[0])] = item[1];
        }
        flags |= 0x08;
      } else if (typeof first === 'number') {
        const numeric = samples.filter(item => typeof item[1] === 'number' && Number.isFinite(item[1]));
        if (numeric.length >= 2) {
          const [x0, y0] = numeric[0];
          const other = numeric.find(item => item[0] !== x0);
          if (other) {
            const [x1, y1] = other;
            scale = (Number(y1) - Number(y0)) / (Number(x1) - Number(x0));
            offset = Number(y0) - scale * Number(x0);
          }
        }
        transform = (Math.abs(scale - 1.0) < 1e-9 && Math.abs(offset) < 1e-9) ? 'identity' : 'linear';
      } else {
        continue;
      }
      if (target === 'contact') transform = 'lumi_contact';
      if (target === 'battery' && batterySemantics &&
          Number(batterySemantics.privatePercentageAttribute || 0) === tag) {
        transform = 'lumi_battery';
      }
      if (target === 'battery' && tag === 1 && batterySemantics &&
          Number(batterySemantics.curve || 0) !== 0) {
        // numericAttributes2Payload publishes voltage and derives battery
        // through the device's official voltage curve for this tag.
        transform = 'lumi_battery';
      }
      rules.push({
        source: 1,
        tag,
        target: String(target),
        transform,
        flags,
        scale,
        offset,
        rangeMin: 0,
        rangeMax: 0,
        map,
      });
    }
  }
  return rules;
}

function auditFromZigbeeCoverage(prep, category) {
  const missing = [];
  // Optional configuration/diagnostic converters are audited but do not
  // reduce the support level of the primary device semantics.
  for (const fz of (Array.isArray(prep && prep.fromZigbee) ? prep.fromZigbee : [])) {
    if (optionalFromZigbeeKey(fz)) continue;
    if (declarativeFromZigbeeKey(fz)) continue;
    // Modern Tuya DP factories are serialized into the richer
    // tuyaDatapoints table below. Their original closures are only
    // implementation detail and must not make an otherwise complete
    // definition look partially unsupported.
    if (fz && fz.__z2mTuyaDpFactory) continue;
    if (String(fz && fz.convert || '') === String(zhc.fromZigbee.lumi_basic && zhc.fromZigbee.lumi_basic.convert || '') ||
        String(fz && fz.cluster || '') === 'genBasic' && String(fz && fz.convert || '').includes('numericAttributes2Payload')) continue;
    const source = String(fz && fz.convert || '').replace(/\s+/g, ' ');
    let reason = 'unmodeled_from';
    if (!fz || typeof fz.convert !== 'function') reason = 'missing_convert';
    else if (fz.convert.constructor && fz.convert.constructor.name === 'AsyncFunction') reason = 'async_from';
    else if (/\b(?:globalStore|setInterval|setTimeout|Date\.now|clearInterval|clearTimeout)\b/.test(source)) reason = 'stateful_from';
    missing.push({reason, source: source.slice(0, 200)});
    converterCoverageAudit.push({
      model: String(prep.model || ''),
      vendor: String(prep.vendor || ''),
      category: String(category || ''),
      reason,
      source: source.slice(0, 200),
    });
  }
  return missing;
}
const devMod = await import('zigbee-herdsman-converters/devices/index');
const defs = devMod.default?.default || devMod.default || devMod.definitions || [];

// Official candidate order used by ZHC's MODELS_INDEX fallback.
let modelsIndex = {};
try {
  modelsIndex = JSON.parse(fs.readFileSync(new URL('../node_modules/zigbee-herdsman-converters/dist/models-index.json', import.meta.url), 'utf8'));
} catch {}

const moduleDefinitionCache = new Map();
async function getModuleDefinitions(moduleName) {
  if (moduleDefinitionCache.has(moduleName)) return moduleDefinitionCache.get(moduleName);
  try {
    const url = new URL(`../node_modules/zigbee-herdsman-converters/dist/devices/${moduleName}`, import.meta.url);
    const mod = await import(url.href);
    const list = mod.definitions || mod.default?.definitions || mod.default || [];
    moduleDefinitionCache.set(moduleName, list);
    return list;
  } catch {
    moduleDefinitionCache.set(moduleName, []);
    return [];
  }
}

const modelPriorities = {};
// DPs whose official inbound converter cannot be reproduced by the
// declarative rule set. Written to z2m_vm_unsupported.ndjson for auditing.
const inboundAudit = [];
// Every official fromZigbee converter that is not represented by the
// declarative IR path. Tuya DPs are audited separately at their call
// sites; this list also covers non-Tuya vendor closures, async code,
// timers/globalStore, and converters whose output is not fully modeled.
const converterCoverageAudit = [];
const definitionModelRanks = new Map();
function normalizeModelKey(value) {
  return String(value || '').replace(/\0(.|\n)*$/g, '').trim().toLowerCase();
}


for (const [model, entries] of Object.entries(modelsIndex)) {
  const rawKey = String(model || '').toLowerCase();
  const key = normalizeModelKey(rawKey);
  // MODELS_INDEX may contain keys that normalize to the empty string
  // (for example an all-NUL modelID). ZHC still looks up the raw key
  // first, so those definitions must remain addressable.
  if (!rawKey) continue;
  const rankByDefinition = new Map();
  for (let rank = 0; rank < entries.length; rank++) {
    const [moduleName, index] = entries[rank];
    const definitions = await getModuleDefinitions(moduleName);
    const definition = definitions[index];
    if (definition && !rankByDefinition.has(definition)) rankByDefinition.set(definition, rank);
  }
  // ZHC first looks up the exact lower-cased modelID and only falls back
  // to the NUL/whitespace-normalized key when that exact key is absent.
  // Preserve both lookup classes so candidates are never merged across
  // distinct official keys.
  if (!modelPriorities[rawKey]) modelPriorities[rawKey] = rankByDefinition;
  // Only expose the normalized lookup key when MODELS_INDEX itself contains
  // that key. Otherwise a key such as "mill international\0threa" would
  // invent a new "mill international" alias that official ZHC cannot resolve.
  if (key && Object.prototype.hasOwnProperty.call(modelsIndex, key) && !modelPriorities[key]) {
    modelPriorities[key] = rankByDefinition;
  }
  for (const [definition, rank] of rankByDefinition) {
    let ranks = definitionModelRanks.get(definition);
    if (!ranks) {
      ranks = new Map();
      definitionModelRanks.set(definition, ranks);
    }
    if (!ranks.has(rawKey) || rank < ranks.get(rawKey)) ranks.set(rawKey, rank);
    if (key && Object.prototype.hasOwnProperty.call(modelsIndex, key) &&
        (!ranks.has(key) || rank < ranks.get(key))) ranks.set(key, rank);
  }
}
const definitionExactModelKeys = new Map();
const definitionNormalizedModelKeys = new Map();

function addDefinitionKey(map, definition, value) {
  if (!definition || !value) return;
  let keys = map.get(definition);
  if (!keys) {
    keys = new Set();
    map.set(definition, keys);
  }
  keys.add(value);
}

for (const [model, entries] of Object.entries(modelsIndex)) {
  const rawKey = String(model || '').toLowerCase();
  const key = normalizeModelKey(rawKey);
  if (!rawKey) continue;
  for (const [moduleName, index] of entries) {
    const definitions = await getModuleDefinitions(moduleName);
    const definition = definitions[index];
    addDefinitionKey(definitionExactModelKeys, definition, rawKey);
    if (key && Object.prototype.hasOwnProperty.call(modelsIndex, key)) {
      addDefinitionKey(definitionNormalizedModelKeys, definition, key);
    }
  }
}

const NO_MODEL_RANK = 0x7FFF;
function rankForModelDefinition(model, definition) {
  const rawKey = String(model || '').toLowerCase();
  const normalizedKey = normalizeModelKey(rawKey);
  const ranks = modelPriorities[rawKey] || modelPriorities[normalizedKey];
  if (!ranks) return NO_MODEL_RANK;
  const rank = ranks.get(definition);
  return rank === undefined ? NO_MODEL_RANK : rank;
}

function declaredModelKeys(prep, d) {
  const keys = new Set();
  const add = value => {
    const raw = String(value ?? '');
    if (raw) keys.add(raw);
  };
  if (Array.isArray(prep?.zigbeeModel)) prep.zigbeeModel.forEach(add);
  if (Array.isArray(d?.zigbeeModel)) d.zigbeeModel.forEach(add);
  return keys;
}

function buildModelPriorityMap(modelKeys, definition) {
  const result = {};
  for (const modelKey of modelKeys) {
    const rank = rankForModelDefinition(modelKey, definition);
    if (rank !== NO_MODEL_RANK) result[modelKey] = rank;
  }
  return result;
}

function buildFingerprintCandidateRanks(fpModel, declaredModels, definition) {
  const result = {};
  const keys = fpModel ? [fpModel] : Array.from(declaredModels);
  for (const key of keys) {
    const rank = rankForModelDefinition(key, definition);
    if (rank !== NO_MODEL_RANK) result[key] = rank;
  }
  return result;
}

let zhcPackageVersion = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(new URL('../node_modules/zigbee-herdsman-converters/package.json', import.meta.url), 'utf8'));
  zhcPackageVersion = String(pkg.version || 'unknown');
} catch {}

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

// ZCL cluster-specific command IDs used by the official fromZigbee
// command converters. Keep this table explicit: command IDs and attribute
// IDs often share numbers but have unrelated semantics.
// Official ZCL command names differ from their Zigbee2MQTT converter type
// names. Resolve IDs from the official cluster tables instead of keeping a
// hand-maintained global map: commandStop is 0x03 in genLevelCtrl but 0x02
// in closuresWindowCovering. A global map silently misroutes one of them.
function officialCommandId(clusterName, converterType) {
  const raw = String(converterType || '');
  if (!raw.startsWith('command')) return undefined;
  const commandName = raw.slice('command'.length);
  const cluster = zh && zh.Zcl && zh.Zcl.Clusters && zh.Zcl.Clusters[clusterName];
  if (!cluster) return undefined;
  for (const tableName of ['commands', 'commandsResponse']) {
    const table = cluster[tableName];
    if (!table) continue;
    for (const definition of Object.values(table)) {
      if (definition && typeof definition.ID === 'number' &&
          String(definition.name || '').toLowerCase() === commandName.toLowerCase()) {
        return definition.ID;
      }
    }
  }
  return undefined;
}

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

// Per-definition custom clusters recovered by collectCustomClusters().
// They take precedence over the global ZCL table because vendor names such
// as "genBasic" can be redefined with manufacturer-specific attributes.
function resolveClusterIdForDefinition(cl, customClusters) {
  if (typeof cl === 'string' && customClusters && customClusters.has(cl.trim())) {
    const entry = customClusters.get(cl.trim());
    return entry && typeof entry === 'object' ? entry.id : entry;
  }
  return resolveClusterId(cl);
}

// deviceAddCustomCluster() is an official modernExtend. Its configure/onEvent
// callbacks call device.addCustomCluster(name, definition) at runtime, so the
// cluster definition is not present on prepareDefinition() output. Replay only
// those callbacks against a dummy device to recover the official name -> ID
// mapping. This keeps vendor custom clusters generic instead of hardcoding
// IKEA/Develco/Tuya/Lumi IDs in the extractor.
function collectCustomClusters(prep, definition = null) {
  // Values are {id, definition}: the generator needs both the numeric
  // cluster ID and the official attribute table for converter probing.
  const collected = new Map();
  if (!prep || typeof prep !== 'object') return collected;
  const register = (name, definition) => {
    const clusterName = String(name || definition && definition.name || '').trim();
    const id = definition && Number(definition.ID);
    if (!clusterName || !Number.isInteger(id) || id < 0 || id > 0xFFFF) return;
    collected.set(clusterName, {id, definition});
  };
  const customClusters = {};
  const dummyDevice = {
    endpoints: [{ID: 1, inputClusters: [], outputClusters: []}],
    customClusters,
    addCustomCluster(name, definition) { register(name, definition); customClusters[String(name)] = definition; },
    getEndpoint(id) { return this.endpoints.find(ep => ep.ID === id) || this.endpoints[0]; },
  };
  const invoke = callback => {
    if (typeof callback !== 'function') return;
    try {
      const result = callback(dummyDevice, dummyDevice.getEndpoint(1), prep);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {}
  };
  // prepareDefinition() collapses all modernExtend configure callbacks
  // into one async function; replaying that combined function stops at
  // the first await. Iterate the original extend entries instead so every
  // deviceAddCustomCluster() definition is recovered.
  const sourceExtends = definition && Array.isArray(definition.extend) ? definition.extend : [];
  if (sourceExtends.length > 0) {
    for (const extend of sourceExtends) {
      if (Array.isArray(extend && extend.configure)) extend.configure.forEach(invoke);
      else invoke(extend && extend.configure);
      if (Array.isArray(extend && extend.onEvent)) extend.onEvent.forEach(invoke);
      else invoke(extend && extend.onEvent);
    }
  } else {
    for (const callback of Array.isArray(prep.configure) ? prep.configure : []) invoke(callback);
    for (const callback of Array.isArray(prep.onEvent) ? prep.onEvent : []) invoke(callback);
    if (typeof prep.configure === 'function') invoke(prep.configure);
    if (typeof prep.onEvent === 'function') invoke(prep.onEvent);
  }
  return collected;
}


function cleanId(value) {
  return String(value || '').replace(/\0+$/g, '').trim();
}

// Replay official configure callbacks and capture the exact reporting
// requests. This is the only reliable source for min/max/change and the
// ZCL attribute type: declarative fromZigbee rules do not carry them.
async function extractOfficialReporting(prep, definition, endpoints, customClusters) {
  extractOfficialReporting.debugCallId ||= 0;
  const debugCallId = ++extractOfficialReporting.debugCallId;
  const requests = [];
  const binds = [];
  const endpointIds = sortedEndpointIds(endpoints);
  const ids = endpointIds.length > 0 ? endpointIds : [1];
  const dataTypeName = value => {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number' && zh && zh.Zcl && zh.Zcl.DataType) {
      return zh.Zcl.DataType[value] || String(value);
    }
    return String(value);
  };
  const clusterDefinition = cluster => {
    if (!cluster) return undefined;
    if (customClusters && customClusters.has(String(cluster))) {
      return customClusters.get(String(cluster)).definition;
    }
    if (zh && zh.Zcl && zh.Zcl.Utils && typeof zh.Zcl.Utils.getCluster === 'function') {
      try { return zh.Zcl.Utils.getCluster(cluster); } catch {}
    }
    return zh && zh.Zcl && zh.Zcl.Clusters && zh.Zcl.Clusters[cluster];
  };
  const attributeDefinition = (cluster, attribute) => {
    const clusterDef = clusterDefinition(cluster);
    if (!clusterDef) return undefined;
    if (zh && zh.Zcl && zh.Zcl.Utils && typeof zh.Zcl.Utils.getClusterAttribute === 'function') {
      try { return zh.Zcl.Utils.getClusterAttribute(clusterDef, attribute); } catch {}
    }
    const attributes = clusterDef.attributes || {};
    if (attributes[attribute]) return attributes[attribute];
    for (const value of Object.values(attributes)) {
      if (value && (value.ID === attribute || value.name === attribute)) return value;
    }
    return undefined;
  };
  const resolveAttribute = (cluster, attribute) => {
    const def = attributeDefinition(cluster, attribute);
    const id = Number(def && def.ID !== undefined ? def.ID : attribute);
    const validId = Number.isFinite(id) && id >= 0 && id <= 0xFFFF;
    // Attribute ID 0 is valid (measuredValue on temperature/humidity and
    // onOff on genOnOff). Only reject a symbolic attribute that the
    // cluster definition does not know at all.
    const valid = validId && (def !== undefined || typeof attribute === 'number');
    const rawType = def && (def.type || def.dataType || def.data_type);
    return {id: valid ? id : 0, type: dataTypeName(rawType), valid};
  };
  const eps = ids.map(ID => ({
    ID,
    inputClusters: [
      0x0000, 0x0001, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008,
      0x0101, 0x0102, 0x0201, 0x0300, 0x0400, 0x0402, 0x0405,
      0x0406, 0x0500, 0x0702, 0x0B04, 0xEF00,
    ],
    outputClusters: [],
    deviceID: 5,
    profileID: 260,
  }));
  const device = {
    ieeeAddr: '0x00124b0000000000',
    endpoints: eps,
    customClusters: {},
    getEndpoint(id) { return this.endpoints.find(ep => ep.ID === id) || this.endpoints[0]; },
  };
  if (customClusters && customClusters instanceof Map) {
    for (const [name, entry] of customClusters) device.customClusters[name] = entry.definition;
  }
  const coordinator = {ID: 1, deviceIeeeAddress: '0x00124b0000000000'};
  for (const ep of eps) {
    ep.getClusterAttributeValue = () => undefined;
    // zigbee-herdsman-converters uses isEndpoint() to decide whether a
    // configure callback received an Endpoint or a Device. Keep the
    // replay object on the endpoint path or setupAttributes() tries to
    // read entity.endpoints and silently rejects the callback.
    Object.defineProperty(ep, 'constructor', {value: {name: 'Endpoint'}});
    ep.getCluster = (clusterKey, targetDevice = undefined, manufacturerCode = undefined) => {
      const resolvedDevice = targetDevice || device;
      return zh.Zcl.Utils.getCluster(clusterKey, manufacturerCode ?? resolvedDevice.manufacturerID, resolvedDevice.customClusters);
    };
    ep.supportsInputCluster = (clusterKey) => {
      const cluster = ep.getCluster(clusterKey);
      return ep.inputClusters.includes(cluster.ID);
    };
    ep.getInputClusters = () => ep.inputClusters.map(cluster => ep.getCluster(cluster));
    ep.getOutputClusters = () => ep.outputClusters.map(cluster => ep.getCluster(cluster));
    ep.bind = async (cluster) => { binds.push({endpoint: ep.ID, cluster: resolveClusterIdForDefinition(cluster, customClusters)}); };
    ep.configureReporting = async (cluster, items) => {
      const clusterId = resolveClusterIdForDefinition(cluster, customClusters);
      if (debugModels.size > 0) {
        console.error('[reporting-replay]', definition && definition.model || prep && prep.model,
          'endpoint=' + ep.ID, 'cluster=' + cluster, 'items=' + JSON.stringify(items));
      }
      for (const item of Array.isArray(items) ? items : [items]) {
        if (!item) continue;
        const attr = resolveAttribute(cluster, item.attribute);
        if (debugModels.size > 0) {
          console.error('[reporting-resolve]', cluster, item.attribute, JSON.stringify(attr));
        }
        if (!attr.valid) continue;
        requests.push({
          endpoint: ep.ID,
          cluster: clusterId,
          attr: attr.id,
          min: Number(item.minimumReportInterval ?? item.min ?? -1),
          max: Number(item.maximumReportInterval ?? item.max ?? -1),
          change: Number(item.reportableChange ?? item.change ?? 0),
          dataType: attr.type
        });
      }
    };
    ep.read = async () => {};
  }
  // prepareDefinition() wraps every modernExtend configure callback into a
  // single async function. Replaying the original callbacks is useful
  // because it keeps each callback's own await chain observable, but the
  // wrapper must not also be replayed or every declaration is duplicated.
  const callbacks = [];
  const sourceExtends = definition && Array.isArray(definition.extend) ? definition.extend : [];
  const addCallback = callback => {
    if (typeof callback === 'function' && !callbacks.includes(callback)) callbacks.push(callback);
  };
  if (sourceExtends.length > 0) {
    // An explicit definition.configure is executed before modernExtend
    // callbacks by processExtensions(). Preserve that order.
    addCallback(definition && definition.configure);
    for (const extend of sourceExtends) {
      if (Array.isArray(extend && extend.configure)) extend.configure.forEach(addCallback);
      else addCallback(extend && extend.configure);
    }
  } else if (Array.isArray(prep && prep.configure)) {
    prep.configure.forEach(addCallback);
  } else {
    addCallback(prep && prep.configure);
  }
  // Replay each callback once. A callback may await bind() before
  // configureReporting(), so wait until observable requests/binds stop
  // changing. Never await the callback promise itself: some official
  // callbacks wait on real device I/O that cannot settle offline.
  const drainReplay = async () => {
    for (let turn = 0; turn < 64; turn++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  for (const callback of callbacks) {
    try {
      const result = callback(device, coordinator, definition || prep);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {}
    await drainReplay();
  }
  await drainReplay();
  if (debugModels.size > 0) {
    console.error('[reporting-call]', debugCallId, definition && definition.model || prep && prep.model);
    console.error('[reporting-final]', definition && definition.model || prep && prep.model,
      'requests=' + requests.length, JSON.stringify(requests));
  }
  return {requests, binds};
}
function normalizeFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return null;
  // ZHC compares these fields with strict equality. Preserve embedded or
  // trailing NUL bytes and surrounding whitespace exactly as declared.
  const modelID = String(fp.modelID ?? '');
  const manufacturerName = String(fp.manufacturerName ?? '');
  const endpoints = Array.isArray(fp.endpoints) ? fp.endpoints.map(ep => ({
    ID: Number(ep && ep.ID),
    profileID: ep && ep.profileID !== undefined ? Number(ep.profileID) : null,
    deviceID: ep && ep.deviceID !== undefined ? Number(ep.deviceID) : null,
    inputClusters: Array.isArray(ep && ep.inputClusters)
      ? ep.inputClusters.map(resolveClusterId)
      : null,
    outputClusters: Array.isArray(ep && ep.outputClusters)
      ? ep.outputClusters.map(resolveClusterId)
      : null,
  })).filter(ep => Number.isInteger(ep.ID) && ep.ID >= 0 && ep.ID <= 255) : null;
  return {
    modelID,
    manufacturerName,
    manufacturerCode: fp.manufacturerID ?? fp.manufacturerCode ?? null,
    type: fp.type || '',
    powerSource: fp.powerSource || '',
    softwareBuildID: fp.softwareBuildID || '',
    dateCode: fp.dateCode || '',
    applicationVersion: fp.applicationVersion === undefined ? null : Number(fp.applicationVersion),
    hardwareVersion: fp.hardwareVersion === undefined ? null : Number(fp.hardwareVersion),
    stackVersion: fp.stackVersion === undefined ? null : Number(fp.stackVersion),
    zclVersion: fp.zclVersion === undefined ? null : Number(fp.zclVersion),
    priority: Number.isFinite(Number(fp.priority)) ? Number(fp.priority) : 0,
    ieeeAddr: fp.ieeeAddr instanceof RegExp ? fp.ieeeAddr.source : (fp.ieeeAddr ? String(fp.ieeeAddr) : ''),
    endpoints,
    raw: {
      manufacturerID: fp.manufacturerID ?? fp.manufacturerCode ?? null,
      type: fp.type || '',
      powerSource: fp.powerSource || '',
      softwareBuildID: fp.softwareBuildID || '',
      dateCode: fp.dateCode || '',
      applicationVersion: fp.applicationVersion === undefined ? null : Number(fp.applicationVersion),
      hardwareVersion: fp.hardwareVersion === undefined ? null : Number(fp.hardwareVersion),
      stackVersion: fp.stackVersion === undefined ? null : Number(fp.stackVersion),
      zclVersion: fp.zclVersion === undefined ? null : Number(fp.zclVersion),
      priority: Number.isFinite(Number(fp.priority)) ? Number(fp.priority) : 0,
      ieeeAddr: fp.ieeeAddr instanceof RegExp ? fp.ieeeAddr.source : (fp.ieeeAddr ? String(fp.ieeeAddr) : ''),
      endpoints,
    },
  };
}

function hex16(num) {
  return '0x' + (num & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
}

// Probe an official fromZigbee converter with a synthetic message so the
// declarative extractor can follow the fields it actually publishes. This
// is deliberately limited to synchronous converters; async converters are
// handled conservatively by the caller.

let probeSequence = 1;

function buildProbeDevice(endpoints = {}, endpointId = 1, probeId = 1) {
  const endpointIds = sortedEndpointIds(endpoints);
  const effectiveIds = endpointIds.length > 0 ? endpointIds : [1];
  const inputClusters = [
    0x0000, 0x0001, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008,
    0x0101, 0x0102, 0x0201, 0x0300, 0x0400, 0x0402, 0x0405,
    0x0406, 0x0500, 0x0702, 0x0B04, 0xEF00,
  ];
  const eps = effectiveIds.map(ID => ({
    ID,
    deviceID: 5,
    profileID: 260,
    inputClusters: inputClusters.slice(),
    outputClusters: [],
  }));
  const device = {
    ieeeAddr: `0x00124b00${(probeId & 0xFFFFFFFF).toString(16).padStart(8, '0')}`,
    networkAddress: 0,
    manufacturerID: 0,
    manufacturerName: '',
    modelID: '',
    endpoints: eps,
    getEndpoint(id) { return this.endpoints.find(ep => ep.ID === id); },
    getClusterAttributeValue() { return undefined; },
  };
  for (const ep of eps) ep.getClusterAttributeValue = () => undefined;
  const endpoint = device.getEndpoint(endpointId) || eps[0];
  return {device, endpoint};
}

function normalizeProbeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const normalized = {...data};
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) delete normalized[key];
  }
  return normalized;
}

function probeConverterFields(fz, clusterId, attributeId, definition = null,
                              endpointId = 1, endpoints = {}) {
  if (!fz || typeof fz.convert !== 'function') return null;
  if (fz.convert.constructor && fz.convert.constructor.name === 'AsyncFunction') return null;
  const probeId = probeSequence++;
  const {device, endpoint} = buildProbeDevice(endpoints, endpointId, probeId);
  const data = {};
  if (clusterId === 0x0006 && attributeId === 0x0000) data.onOff = 1;
  const msg = {
    endpoint,
    device,
    data,
    type: 'attributeReport',
    meta: {zclTransactionSequenceNumber: probeId & 0xFF, device},
  };

  // Command converters receive a msg.type such as commandOn and read
  // msg.data / msg.endpoint.ID. The synthetic endpoint already carries
  // the real endpoint id, so command probes use the same shape.
  if (typeof arguments[5] === 'string') {
    msg.type = arguments[5];
  }
  const model = definition || {};
  try {
    const result = fz.convert(model, msg, () => {}, {}, {device});
    if (!result || typeof result !== 'object') return null;
    return normalizeProbeData(result);
  } catch {
    return null;
  }
}

// Find a synchronous official genOnOff attribute converter that publishes a
// state-like field for onOff. Action-only command converters must not be
// turned into a fake relay state.

function officialOnOffInspection(prep, endpoints = {}) {
  const targets = new Map();
  const unsupported = [];
  const converters = Array.isArray(prep && prep.fromZigbee) ? prep.fromZigbee : [];
  // Official command converters receive the endpoint that sent the
  // command. Use 0 so runtime endpoint matching accepts any physical
  // endpoint while still retaining the final property mapping.
  const probeEndpointIds = [0];

  for (const fz of converters) {
    const clusters = Array.isArray(fz && fz.cluster) ? fz.cluster : [fz && fz.cluster];
    if (!clusters.some(cluster => resolveClusterId(cluster) === 0x0006)) continue;

    // This inspection is for attribute state converters. CommandOn/Off
    // converters (including command_on_state) belong to the command path
    // and must not create an attributeReport rule.
    const types = Array.isArray(fz.type) ? fz.type : [fz.type];
    const handlesAttribute = types.some(type =>
      type === 'attributeReport' || type === 'readResponse');
    if (!handlesAttribute) continue;

    // ignore_onoff_report intentionally consumes the report. It is
    // serialized as an IGNORE rule elsewhere and must not be audited as a
    // failed state converter.
    const source = String(fz && fz.convert || '').replace(/\s+/g, '');
    if (/^(?:async)?\([^)]*\)=>\{\}$/.test(source)) continue;

    let sawResult = false;
    for (const endpointId of probeEndpointIds) {
      const result = probeConverterFields(fz, 0x0006, 0x0000, prep, endpointId, endpoints);
      if (!result) continue;
      sawResult = true;
      for (const [key, value] of Object.entries(result)) {
        if (!/^(?:state|switch)(?:_|$)/.test(key)) continue;
        const normalized = canonicalStateProperty(key, endpoints);
        if (normalized.property !== 'state' &&
            !/^state_l[1-9][0-9]*$/.test(normalized.property)) continue;
        const stateValue = String(value ?? '').toUpperCase();
        if (stateValue !== 'ON' && stateValue !== 'OFF') continue;
        const endpoint = normalized.property === 'state'
          ? 0
          : (normalized.endpoint || endpointId || 0);
        if (!targets.has(normalized.property)) {
          targets.set(normalized.property, endpoint);
        } else if (normalized.property !== 'state' && endpoint &&
                   !targets.get(normalized.property)) {
          targets.set(normalized.property, endpoint);
        }
      }
    }
    if (!sawResult) {
      unsupported.push({
        cluster: '0x0006',
        property: 'state',
        reason: 'unprobeable_from',
        source: String(fz && fz.convert || '').slice(0, 200),
      });
    }
  }
  return {targets, unsupported};
}

function hasOfficialOnOffStateConverter(prep, endpoints = {}) {
  return officialOnOffInspection(prep, endpoints).targets.size > 0;
}


// A state expose may use state_l1/l2/l3/l4, state_left/center/right, or a
// named endpoint such as button_1. Normalize all of them to state_lN and
// attach the real endpoint, so runtime dispatch never has to guess.
function sortedEndpointIds(endpoints) {
  return [...new Set(Object.values(endpoints || {}).filter(v => typeof v === 'number' && v > 0))]
    .sort((a, b) => a - b);
}

function sortedEndpointEntries(endpoints) {
  return Object.entries(endpoints || {})
    .filter(([, id]) => typeof id === 'number' && id > 0)
    .sort(([aName, aId], [bName, bId]) => (aId - bId) || aName.localeCompare(bName));
}

// A bare numeric suffix on a logical property (momentary_2, week_program_3)
// is not a physical endpoint. Only explicit endpoint-map entries count.
function resolveExplicitEndpoint(endpointName, endpoints) {
  if (endpointName === undefined || endpointName === null || endpointName === '') return 0;
  const key = String(endpointName);
  return endpoints && typeof endpoints[key] === 'number' ? endpoints[key] : 0;
}

function resolveEndpoint(endpointName, endpoints) {
  if (endpointName === undefined || endpointName === null || endpointName === '') return 0;
  const key = String(endpointName);
  if (endpoints && typeof endpoints[key] === 'number') return endpoints[key];
  if (/^[0-9]+$/.test(key)) return Number(key);
  return 0;
}

function canonicalStateProperty(prop, endpoints) {
  const raw = String(prop || '');
  const match = raw.match(/^(state|switch)(?:_?(.+))?$/i);
  if (!match) return { property: raw, endpoint: 0 };
  const suffix = match[2] || '';
  let endpoint = resolveEndpoint(suffix, endpoints);
  let gang = 0;
  const lMatch = suffix.match(/^l([1-9][0-9]*)$/i);
  const nMatch = suffix.match(/^([1-9][0-9]*)$/);
  if (lMatch) {
    gang = Number(lMatch[1]);
    if (!endpoint) endpoint = gang;
  } else if (nMatch) {
    gang = Number(nMatch[1]);
    if (!endpoint) endpoint = gang;
  } else if (endpoint) {
    const index = sortedEndpointIds(endpoints).indexOf(endpoint);
    if (index >= 0) gang = index + 1;
  }
  if (!endpoint && !suffix) {
    const ids = sortedEndpointIds(endpoints);
    if (ids.length === 1) endpoint = ids[0];
  }
  const explicitGang = gang > 0;
  const multiEndpoint = sortedEndpointIds(endpoints).length > 1;
  return {
    property: (explicitGang || multiEndpoint) && gang > 0 ? `state_l${gang}` : raw,
    endpoint: endpoint || 0
  };
}
function canonicalStateExpose(exp, endpoints) {
  const raw = String(exp && exp.property || 'state');
  const endpointName = exp && exp.endpoint !== undefined ? String(exp.endpoint) : '';
  const normalized = canonicalStateProperty(raw, endpoints);
  let endpoint = resolveEndpoint(endpointName, endpoints) || normalized.endpoint;
  let gang = 0;
  const suffix = (raw.match(/^(?:state|switch)_?(.*)$/i) || [])[1] || '';
  const lMatch = suffix.match(/^l([1-9][0-9]*)$/i);
  const nMatch = suffix.match(/^([1-9][0-9]*)$/);
  if (lMatch) gang = Number(lMatch[1]);
  else if (nMatch) gang = Number(nMatch[1]);
  // Numeric suffixes are already 1-based gang numbers. Named suffixes
  // (left/right/center, lights/high/low) must use the endpoint map order.
  if (gang <= 0 && endpoint) {
    const index = sortedEndpointIds(endpoints).indexOf(endpoint);
    if (index >= 0) gang = index + 1;
  }
  if (gang <= 0 && !suffix && endpoint) gang = 1;
  return {
    property: (suffix || sortedEndpointIds(endpoints).length > 1) && gang > 0 ? `state_l${gang}` : normalized.property,
    endpoint: endpoint || normalized.endpoint || 0
  };
}

function statePropertyForEndpoint(endpoints, endpointId) {
  const ids = sortedEndpointIds(endpoints);
  const index = ids.indexOf(endpointId);
  return index >= 0 ? `state_l${index + 1}` : 'state';
}

// Official endpoint naming helper. ZHC only appends an endpoint suffix when
// meta.multiEndpoint is enabled and the property is not in multiEndpointSkip.
// An expose may already carry the final endpoint-specific property, so do
// not append the same suffix twice.
function endpointProperty(prop, endpointName, meta) {
  const raw = String(prop || '');
  const skip = Array.isArray(meta && meta.multiEndpointSkip)
    ? meta.multiEndpointSkip.map(String)
    : [];
  if (!meta || meta.multiEndpoint !== true || !endpointName || skip.includes(raw)) {
    return raw;
  }
  const suffix = String(endpointName);
  if (!suffix || raw === suffix || raw.endsWith(`_${suffix}`)) return raw;
  return `${raw}_${suffix}`;
}

function endpointNameForId(endpoints, endpointId) {
  if (!endpoints || endpointId === undefined || endpointId === null || endpointId === 0) return '';
  for (const [name, id] of Object.entries(endpoints)) {
    if (Number(id) === Number(endpointId)) return String(name);
  }
  return String(endpointId);
}

function routePropertyForExpose(exp, endpoints, meta) {
  const raw = String(exp && exp.property || '');
  const endpointName = exp && exp.endpoint !== undefined && exp.endpoint !== null ? String(exp.endpoint) : '';
  const endpointId = resolveEndpoint(endpointName, endpoints);
  return { property: endpointProperty(raw, endpointName, meta), endpoint: endpointId };
}

function propertyMatchesExpose(exposeProperty, baseProperty) {
  const actual = String(exposeProperty || '');
  const base = String(baseProperty || '');
  // Color and color-temperature are separate capabilities even though
  // color_temp starts with the color prefix. Treat both families as exact
  // namespaces so a CCT expose never receives a moveToColor command.
  if (base === 'color' || base === 'color_xy' || base === 'color_hs') {
    return colorExposeMatches(actual);
  }
  if (base === 'color_temp') {
    return actual === base || actual.startsWith(`${base}_`);
  }
  return actual === base || actual.startsWith(`${base}_`);
}

// Color is a special case: the generic prefix matcher would make
// color_temp_l2 look like a color/XY property because it starts with
// "color_". Keep the two capabilities disjoint so a CCT endpoint is
// never given a moveToColor command or a HomeKit Hue/Saturation pair.
function colorExposeMatches(exposeProperty) {
  const actual = String(exposeProperty || '');
  return actual === 'color' ||
    actual === 'color_xy' ||
    actual === 'color_hs' ||
    /^color_(?:xy|hs)(?:_|$)/.test(actual) ||
    /^color_l[1-9][0-9]*$/.test(actual);
}

function colorHSExposeMatches(exposeProperty) {
  const actual = String(exposeProperty || '');
  return actual === 'color_hs' || /^color_hs(?:_|$)/.test(actual);
}


function officialToZigbeeKey(tz) {
  if (!tz || typeof tz.convertSet !== 'function') return '';
  const tables = [zhc.toZigbee || {}, legacyTuya?.tz || {}];
  for (const table of tables) {
    for (const [key, candidate] of Object.entries(table)) {
      if (candidate === tz || candidate.convertSet === tz.convertSet) return key;
    }
  }
  return '';
}

function isOfficialZclLightKey(key) {
  return [
    'light_color',
    'light_colortemp',
    'light_color_colortemp',
    'light_color_and_colortemp_via_color',
    'light_onoff_brightness',
  ].includes(String(key || ''));
}
function isOfficialZclLightConverter(tz) {
  return isOfficialZclLightKey(officialToZigbeeKey(tz));
}

function usesHueAndSaturation(meta) {
  return !!(meta && meta.supportsHueAndSaturation === true);
}
function usesEnhancedHue(meta) {
  return !!(meta && meta.supportsEnhancedHue === true);
}

// Key names are not unique: private legacy converters such as Tuya WZ5 and
// Silvercrest publish color/brightness keys but use vendor data points, not
// lightingColorCtrl. Identify those converters by function identity first.
function privateDpLightConverterKind(tz) {
  const candidates = [
    ['wz5', legacyTuya && legacyTuya.tz && legacyTuya.tz.tuya_light_wz5],
    ['silvercrest', legacyTuya && legacyTuya.tz && legacyTuya.tz.silvercrest_smart_led_string],
  ];
  for (const [kind, candidate] of candidates) {
    if (!candidate || !tz) continue;
    if (candidate === tz ||
        (candidate.convertSet && tz.convertSet && candidate.convertSet === tz.convertSet)) {
      return kind;
    }
  }
  return '';
}

function isPrivateDpLightConverter(tz) {
  return privateDpLightConverterKind(tz) !== '';
}

function definitionUsesPrivateDpLight(prep) {
  return Array.isArray(prep && prep.toZigbee) && prep.toZigbee.some(isPrivateDpLightConverter);
}
function propertySetHasColorXY(properties) {
  return [...properties].some(prop =>
    colorExposeMatches(prop) ||
    prop === 'hue' || prop === 'saturation' || prop === 'x' || prop === 'y');
}

// Resolve the public property and physical endpoint for standard ZCL rules.
// ZHC exposes are already expanded by modernExtend: exposeEndpoints()
// attaches the endpoint name, while postfixWithEndpointName() changes the
// published property. Some custom definitions carry both forms, so avoid
// appending the same endpoint suffix twice.
function standardExposeRoutes(exposes, endpoints, meta, baseProperties) {
  const bases = Array.isArray(baseProperties) ? baseProperties : [baseProperties];
  const routes = [];
  const seen = new Set();
  for (const exp of exposes) {
    const raw = String(exp && exp.property || '');
    if (!bases.some(base => propertyMatchesExpose(raw, base))) continue;
    const route = routePropertyForExpose(exp, endpoints, meta);
    if (!route.property) continue;
    const key = `${route.property}:${route.endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(route);
  }
  return routes;
}

function defaultRouteForProperty(property, endpoints, meta) {
  const prop = String(property || '');
  const endpointIds = sortedEndpointIds(endpoints);
  const endpoint = endpointIds.length === 1 ? endpointIds[0] : 0;
  return { property: endpointProperty(prop, endpointNameForId(endpoints, endpoint), meta), endpoint };
}

// legacy.fz.tuya_switch predates meta.tuyaDatapoints. Its wire format is
// nevertheless Tuya DP: DP1..DP6 are relay states and multiEndpoint maps
// them to state_l1..state_l6 on one physical endpoint. Recover that table
// from the exposes so these devices do not get a bogus genOnOff rule.
function isLegacyTuyaSwitch(prep) {
  return Array.isArray(prep && prep.fromZigbee) && prep.fromZigbee.some(fz =>
    String(fz && fz.convert || '').includes('firstDpValue(msg, meta, "tuya_switch")')
  );
}

function extractLegacyTuyaSwitchDatapoints(prep) {
  if (!isLegacyTuyaSwitch(prep)) return [];
  const stateItems = stateExposes(parseExposes(prep.exposes));
  const dps = [];
  const seen = new Set();
  for (const exp of stateItems) {
    const raw = String(exp.property || 'state');
    const match = raw.match(/^(?:state|switch)_?(?:l)?([1-9][0-9]*)$/i);
    const dp = match ? Number(match[1]) : 1;
    if (dp < 1 || dp > 6 || seen.has(dp)) continue;
    seen.add(dp);
    dps.push({
      dp,
      target: match ? `state_l${dp}` : 'state',
      datatype: 'bool',
      scale: 1.0,
      offset: 0.0,
      map: null
    });
  }
  // A malformed/empty expose list must still preserve the one-gang DP1
  // behavior of legacy.fz.tuya_switch.
  if (dps.length === 0) {
    dps.push({ dp: 1, target: 'state', datatype: 'bool', scale: 1.0, offset: 0.0, map: null });
  }
  return dps;
}

function normalizeEnumValue(value) {
  return String(value ?? '').trim().toUpperCase();
}

// Door-lock detection must not treat child_lock, keypad_lockout or other
// configuration properties as proof that the device itself is a lock.
// ZHC encodes standard locks as an explicit Lock expose (type="lock"),
// while a few devices expose only state/lock_state with LOCK/UNLOCK values.
function hasLockExposeSemantics(exposes) {
  const list = Array.isArray(exposes) ? exposes : [];
  if (list.some(e => String(e && e.type || '').toLowerCase() === 'lock')) return true;
  const props = new Set(list.map(e => String(e && e.property || '').toLowerCase()));
  if (props.has('lock_state') || props.has('lock') || props.has('unlock')) return true;
  return list.some(e => {
    const prop = String(e && e.property || '').toLowerCase();
    if (prop !== 'state' && prop !== 'lock_state') return false;
    const on = normalizeEnumValue(e && e.value_on);
    const off = normalizeEnumValue(e && e.value_off);
    const lockish = value => value === 'LOCK' || value === 'LOCKED' || value === 'UNLOCK' || value === 'UNLOCKED';
    return lockish(on) || lockish(off);
  });
}

function hasStandardDoorLockConverter(prep) {
  return Array.isArray(prep && prep.fromZigbee) && prep.fromZigbee.some(fz => {
    const clusters = Array.isArray(fz && fz.cluster) ? fz.cluster : [fz && fz.cluster];
    return clusters.some(cluster => resolveClusterId(cluster) === 0x0101);
  });
}

// A converter that merely references closuresDoorLock may only decode a
// vendor-specific payload (Aqara ZNMS11/12/13). Standard lock reporting is
// only safe when the converter actually reads msg.data.lockState.
function hasStandardDoorLockStateConverter(prep) {
  return Array.isArray(prep && prep.fromZigbee) && prep.fromZigbee.some(fz => {
    const clusters = Array.isArray(fz && fz.cluster) ? fz.cluster : [fz && fz.cluster];
    if (!clusters.some(cluster => resolveClusterId(cluster) === 0x0101)) return false;
    return /(?:msg|data)\.data(?:\.lockState|\[['\"]lockState['\"]\])/.test(String(fz && fz.convert || ''));
  });
}

// Category classification
function classifyCategory(exposesList, descStr = '', clusterIds = new Set()) {
  const exposes = Array.isArray(exposesList) ? exposesList : [];
  const props = new Set(exposes.map(e => String(e && e.property || '').toLowerCase()).filter(Boolean));
  const types = new Set(exposes.map(e => String(e && e.type || '').toLowerCase()).filter(Boolean));
  const hasLightComposite = exposes.some(e => String(e && e.composite_type || '').toLowerCase() === 'light');
  const desc = String(descStr || '').toLowerCase();
  const hasProp = (...names) => names.some(name => props.has(name));
  const hasPropFamily = (...names) => names.some(name =>
    [...props].some(prop => prop === name || prop.startsWith(`${name}_`)));
  const descHas = (...terms) => terms.some(term => desc.includes(term));

  // Action-only remotes and scene switches are not lights or relays.
  // Some of them bind/use genOnOff and genLevelControl only to emit
  // command events (action), so cluster presence alone must not decide
  // the category or expose a synthetic state.
  const hasAction = props.has('action');
  const hasStateSemantic = hasPropFamily(
    'state', 'switch', 'brightness', 'color_temp', 'color_xy',
    'position', 'cover', 'lock_state',
    'occupied_heating_setpoint', 'current_heating_setpoint', 'system_mode'
  );
  if (hasAction && !hasStateSemantic) return 'remote_control';
  // Garage-door openers expose a door contact plus a trigger command, not
  // a WindowCovering position. Keep this identity semantic (not model
  // specific) and check it before generic contact handling.
  if (hasPropFamily('garage_door_contact') ||
      (descHas('garage door') && hasPropFamily('trigger'))) {
    return 'garage_door';
  }
  if (hasLockExposeSemantics(exposes)) return 'door_lock';
  if (clusterIds.has(0x0102) || types.has('cover')) return 'window_covering';
  if (clusterIds.has(0x0201) || types.has('climate') ||
      hasProp('occupied_heating_setpoint', 'current_heating_setpoint', 'local_temperature', 'system_mode') ||
      descHas('thermostat', 'radiator valve', 'trv', 'climate')) {
    return 'thermostat';
  }

  // A real lock must expose lock state/action semantics. Do not classify a
  // thermostat or switch merely because it has a child_lock expose.

  // Modern ZHC light exposes are composite. Their concrete child
  // properties are already flattened by parseExposes(), so classify
  // from those capabilities rather than the composite's empty property.
  if (hasLightComposite) {
    if (hasPropFamily('color_xy', 'color_temp', 'hue', 'saturation', 'x', 'y')) return 'color_light';
    if (hasPropFamily('brightness')) return 'dimmable_light';
    return 'on_off_light';
  }
  if (clusterIds.has(0x0300) || hasPropFamily('color_xy', 'color_temp', 'hue', 'saturation', 'x', 'y')) return 'color_light';
  if (clusterIds.has(0x0008) || hasPropFamily('brightness')) return 'dimmable_light';
  if (hasProp('water_leak', 'waterleak') || descHas('water leak', 'waterleak')) return 'water_leak_sensor';
  if (hasProp('smoke') || descHas('smoke detector', 'smoke alarm')) return 'smoke_sensor';
  if (clusterIds.has(0x0406) || hasProp('occupancy', 'presence', 'motion')) return 'occupancy_sensor';
  // IAS Alarm 2 (or a CO-specific converter) proves carbon-monoxide
  // semantics. Check it before generic gas because dual CO/gas alarms
  // expose both properties from the same zone-status word.
  if (hasProp('carbon_monoxide') || descHas('carbon monoxide', 'co alarm', 'co detector')) return 'carbon_monoxide_sensor';
  if (hasProp('gas', 'gas_leak') || descHas('gas detector', 'combustible gas')) return 'gas_sensor';
  if (hasProp('vibration') || descHas('vibration sensor', 'vibration alarm')) return 'vibration_sensor';
  if (hasProp('contact', 'door_state', 'window_state') || descHas('contact sensor', 'door sensor', 'window sensor')) return 'contact_sensor';
  if (clusterIds.has(0x0405) || hasProp('humidity')) return 'humidity_sensor';
  if (clusterIds.has(0x0400) || hasProp('illuminance', 'illuminance_lux')) return 'light_sensor';
  if (clusterIds.has(0x0402) || hasProp('temperature')) return 'temp_sensor';
  if (hasProp('outlet', 'plug', 'socket') || descHas('plug', 'outlet', 'socket')) return 'on_off_plugin_unit';
  if (clusterIds.has(0x0006) || hasPropFamily('state', 'switch') || descHas('switch', 'relay')) return 'on_off_switch';
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
  function walk(item, inheritedEndpoint, inheritedCompositeType) {
    if (!item) return;
    const endpointName = item.endpoint !== undefined ? item.endpoint : inheritedEndpoint;
    if (Array.isArray(item.features)) {
      item.features.forEach(feature => walk(feature, endpointName, item.type));
    }
    // Composite color_xy exposes carry the feature set that tells us an
    // endpoint really supports XY. Keep a synthetic parent entry because
    // the child x/y entries alone lose that capability marker.
    if (item.type === 'composite' && item.name === 'color_xy') {
      result.push({
        name: 'color_xy',
        property: String(item.property || 'color_xy'),
        type: 'composite',
        access: typeof item.access === 'number' ? item.access : 3,
        unit: '',
        endpoint: endpointName !== undefined && endpointName !== null ? String(endpointName) : '',
        values: undefined,
        value_on: undefined,
        value_off: undefined
        ,value_min: undefined
        ,value_max: undefined
        ,value_step: undefined
        ,category: ''
      });
    }
    // color_hs has the same composite shape. Without a synthetic parent,
    // only the hue/saturation children survive and the official HS
    // command identity is lost.
    if (item.type === 'composite' && item.name === 'color_hs') {
      result.push({
        name: 'color_hs',
        property: String(item.property || 'color_hs'),
        type: 'composite',
        access: typeof item.access === 'number' ? item.access : 3,
        unit: '',
        endpoint: endpointName !== undefined && endpointName !== null ? String(endpointName) : '',
        values: undefined,
        value_on: undefined,
        value_off: undefined
        ,value_min: undefined
        ,value_max: undefined
        ,value_step: undefined
        ,category: ''
      });
    }
    const prop = item.property || item.name;
    if (prop) {
      result.push({
        name: String(item.name || prop),
        property: String(prop),
        type: String(item.type || 'numeric'),
        access: typeof item.access === 'number' ? item.access : 3,
        unit: item.unit ? String(item.unit) : '',
        endpoint: endpointName !== undefined && endpointName !== null ? String(endpointName) : '',
        values: Array.isArray(item.values) ? item.values.map(String) : undefined,
        value_on: item.value_on !== undefined ? String(item.value_on) : undefined,
        value_off: item.value_off !== undefined ? String(item.value_off) : undefined
        ,value_min: typeof item.value_min === 'number' ? item.value_min : undefined
        ,value_max: typeof item.value_max === 'number' ? item.value_max : undefined
        ,value_step: typeof item.value_step === 'number' ? item.value_step : undefined
        ,category: String(item.category || (item.homeassistant && item.homeassistant.entityCategory) || '')
        ,enabled_by_default: !(item.homeassistant && item.homeassistant.enabledByDefault === false)
        ,composite_type: inheritedCompositeType === 'light' ? 'light' : undefined
      });
    }
  }
  list.forEach(item => walk(item, undefined));
  return result;
}

function stateExposes(exposes) {
  const seen = new Set();
  const result = [];
  for (const exp of exposes) {
    const prop = String(exp.property || '');
    if (exp.type !== 'binary' || !/^(state|switch)(_|$)/.test(prop)) continue;
    const key = `${prop}|${exp.endpoint !== undefined ? exp.endpoint : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(exp);
  }
  return result;
}

// Extract Tuya DP definitions
function extractTuyaDatapoints(prep) {
  const dps = [];


  const TUYA_DATATYPE_NAMES = ['raw', 'bool', 'value', 'string', 'enum', 'bitmap'];
  const tupleDpFactory = (item, fallbackName = '') => {
    const dp = Number(item && item.dp);
    if (!Number.isInteger(dp) || dp < 0 || dp > 255) return null;
    const type = Number(item && item.type);
    return {
      dp,
      name: String(item && item.name || fallbackName || ''),
      datatype: TUYA_DATATYPE_NAMES[type] || 'value',
      valueOn: Array.isArray(item && item.valueOn) ? item.valueOn : null,
      valueOff: Array.isArray(item && item.valueOff) ? item.valueOff : null,
      lookup: item && item.lookup && typeof item.lookup === 'object'
        ? Object.fromEntries(Object.entries(item.lookup).map(([label, code]) => [
            String(label),
            Number(code && typeof code === 'object' && 'value' in code ? code.value : code),
          ]).filter(([, code]) => Number.isFinite(code)))
        : null,
      scale: item && item.scale,
      endpoint: item && item.endpoint !== undefined ? item.endpoint : '',
      skip: !!(item && item.skip),
    };
  };

  // Modern Tuya definitions build fromZigbee closures with
  // tuya.modernExtend.dpBinary/dpNumeric/dpLight/etc. The official
  // closures do not expose meta.tuyaDatapoints, so recover the exact
  // factory arguments tagged by the build-time wrapper. This is a
  // generic, model-independent representation of the official mapping.
  const modernDps = [];
  for (const fz of (Array.isArray(prep && prep.fromZigbee) ? prep.fromZigbee : [])) {
    const meta = fz && fz.__z2mTuyaDpFactory;
    if (!meta || !meta.args) continue;
    const args = meta.args;
    const factory = String(meta.factory || '');
    if (factory === 'dpTHZBSettings') {
      const dp = Number(args.dp);
      if (Number.isInteger(dp) && dp >= 0 && dp <= 255) {
        modernDps.push({dp, name: 'auto_settings', datatype: 'string', composite: true, endpoint: ''});
      }
      continue;
    }
    const entries = [];
    if (factory === 'dpLight') {
      for (const key of ['state', 'brightness', 'min', 'max', 'colorTemp']) {
        const entry = tupleDpFactory(args[key], key === 'colorTemp' ? 'color_temp' : key);
        if (entry) {
          entry.name = key === 'colorTemp' ? 'color_temp' : (args[key] && args[key].name ? args[key].name : key);
          entry.endpoint = args.endpoint !== undefined ? args.endpoint : entry.endpoint;
          entries.push(entry);
        }
      }
    } else if (factory === 'dpTemperature' || factory === 'dpHumidity' || factory === 'dpBattery') {
      const entry = tupleDpFactory(args, factory.slice(2).toLowerCase());
      if (entry) entries.push(entry);
    } else if (factory === 'dpContact') {
      const entry = tupleDpFactory(args, 'contact');
      if (entry) entries.push(entry);
    } else if (factory === 'dpGas') {
      const entry = tupleDpFactory(args, 'gas');
      if (entry) entries.push(entry);
    } else if (factory === 'dpOnOff') {
      const entry = tupleDpFactory(args, 'state');
      if (entry) entries.push(entry);
    } else {
      const entry = tupleDpFactory(args, args.name || '');
      if (entry) entries.push(entry);
    }
    modernDps.push(...entries);
  }

  const exposes = parseExposes(prep.exposes);
  const endpoints = extractEndpoints(prep, exposes);
  const endpointForTarget = target => {
    const wanted = String(target || '');
    for (const exp of exposes) {
      if (String(exp.property || '') !== wanted) continue;
      const endpoint = resolveExplicitEndpoint(exp.endpoint, endpoints);
      if (endpoint > 0) return endpoint;
    }
    // A target suffix is only a physical endpoint when the official
    // endpoint map contains that exact name. Numeric logical suffixes
    // such as momentary_2 or week_program_3 must stay on the device's
    // default endpoint.
    const targetName = wanted.match(/_([^_]+)$/);
    if (targetName) {
      const named = resolveExplicitEndpoint(targetName[1], endpoints);
      if (named > 0) return named;
    }
    const ids = sortedEndpointIds(endpoints);
    return ids.length > 0 ? ids[0] : 1;
  };

  // A binary expose is authoritative for the wire encoding. Some upstream
  // definitions use a raw 0/1 converter for binary fields (for example
  // TRV26 window_detection), which would otherwise be sent as a 4-byte
  // Tuya value DP instead of the required 1-byte bool DP.
  const binaryProperties = new Set(
    parseExposes(prep.exposes)
      .filter(exp => String(exp.type || '').toLowerCase() === 'binary')
      .map(exp => String(exp.property || ''))
      .filter(Boolean)
  );

  // Official inbound path: tuya.datapoints.convert uses
  //   datapoints.find(d => d[0] === dpId)
  // so only the FIRST table row for a DP id ever decodes a report. A row
  // whose converter is composite (returns an object), async, or cannot be
  // probed at all cannot be reproduced by the declarative rule set. Those
  // rows must consume the report and publish nothing instead of guessing.
  const isAsyncConverter = fn =>
    !!fn && fn.constructor && fn.constructor.name === 'AsyncFunction';
  const classifyInboundConverter = conv => {
    if (!conv || typeof conv !== 'object') return 'no_converter';
    if (typeof conv.from !== 'function') return 'no_from';
    if (isAsyncConverter(conv.from)) return 'async_from';
    let sawAny = false;
    for (const probe of [true, 0, 1, 10, 100]) {
      let converted;
      try {
        converted = conv.from(probe, { device: {} }, {}, () => {}, {});
      } catch {
        continue;
      }
      if (converted === undefined || converted === null) continue;
      sawAny = true;
      if (typeof converted === 'object') return 'composite_from';
    }
    return sawAny ? null : 'unprobeable_from';
  };

  const safeProbeFrom = (conv, probe) => {
    if (!conv || typeof conv.from !== 'function') return undefined;
    try {
      return conv.from(probe, { device: {} }, {}, () => {}, {});
    } catch {
      return undefined;
    }
  };
  const isInvertedBoolConverter = conv => {
    if (!conv || typeof conv.from !== 'function') return false;
    return safeProbeFrom(conv, true) === false && safeProbeFrom(conv, false) === true;
  };
  const inferDatatypeFromConverter = conv => {
    if (!conv || typeof conv !== 'object') return { datatype: 'value', scale: 1.0, offset: 0.0, map: null };
    const fromStr = String(conv.from || '');
    const toStr = String(conv.to || '');

    // Async converters can reject after the synchronous try/catch returns,
    // which would crash the whole extraction. Their payloads are also
    // device-specific, so skip them rather than guessing.
    const isAsync = fn => !!fn && fn.constructor && fn.constructor.name === 'AsyncFunction';
    if (isAsync(conv.from) || isAsync(conv.to)) {
      return { datatype: 'value', scale: 1.0, offset: 0.0, map: null };
    }

    const tryFrom = code => {
      try {
        return conv.from(code, { device: {} }, {}, () => {});
      } catch {
        return undefined;
      }
    };

    const fromTrue = tryFrom(true);
    const fromFalse = tryFrom(false);
    const invertedBool = fromTrue === false && fromFalse === true;
    if (invertedBool) {
      return { datatype: 'bool', scale: -1.0, offset: 1.0, map: null };
    }
    if (typeof tryFrom(1) === 'boolean') return { datatype: 'bool', scale: 1.0, offset: 0.0, map: null };

    // Modern DP converters are fresh closures, so reference equality with
    // tuya.valueConverter.* never matches. Probe the pure converter to
    // recover numeric scaling and enum lookup tables.
    for (const probe of [10, 100, 2, 1000]) {
      const converted = tryFrom(probe);
      if (typeof converted === 'number' && Number.isFinite(converted) && converted !== probe) {
        return { datatype: 'value', scale: converted / probe, offset: 0.0, map: null };
      }
    }

    // to() is the reliable way to recover the wire datatype. A boolean
    // result means the DP is a Tuya bool (for example lockUnlock/onOff),
    // while an object carrying .value means it is an enum.
    const valueMap = {};
    let sawBooleanTo = false;
    if (typeof conv.to === 'function') {
      const candidates = new Set(['ON', 'OFF', 'LOCK', 'UNLOCK', 'off', 'heat', 'auto', 'cool']);
      for (let code = 0; code <= 32; code++) {
        const converted = tryFrom(code);
        if (typeof converted === 'string' && converted.length > 0) candidates.add(converted);
        else if (converted && typeof converted === 'object' && !Array.isArray(converted)) {
          for (const value of Object.values(converted)) {
            if (typeof value === 'string' && value.length > 0 && value !== 'none') candidates.add(value);
          }
        }
      }
      for (const label of candidates) {
        try {
          const converted = conv.to(label, { device: {} }, {});
          if (typeof converted === 'boolean') { sawBooleanTo = true; continue; }
          const numeric = Number(converted && typeof converted === 'object' && 'value' in converted ? converted.value : converted);
          if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 255) valueMap[label] = numeric;
        } catch {}
      }
    }

    if (sawBooleanTo) return { datatype: 'bool', scale: 1.0, offset: 0.0, map: null };

    // Some converters (notably thermostatSystemModeAndPresetMap) return an
    // object from from() and expose their reverse mapping only through to().
    // Collect labels from both directions so those DPs keep enum semantics.
    for (let code = 0; code <= 32; code++) {
      const converted = tryFrom(code);
      if (typeof converted === 'string' && converted.length > 0) valueMap[converted] = code;
      else if (converted && typeof converted === 'object' && !Array.isArray(converted)) {
        for (const value of Object.values(converted)) {
          if (typeof value === 'string' && value.length > 0 && value !== 'none') valueMap[value] = code;
        }
      }
    }
    if (Object.keys(valueMap).length > 0) return { datatype: 'enum', scale: 1.0, offset: 0.0, map: valueMap };

    if (fromStr.includes('return !v') && toStr.includes('return !v')) {
      return { datatype: 'bool', scale: -1.0, offset: 1.0, map: null };
    }
    if (fromStr.includes('=== valueTrue') || fromStr.includes('=== valueTrue.valueOf()')) {
      return { datatype: 'bool', scale: 1.0, offset: 0.0, map: null };
    }

    let scale = 1.0;
    let m = fromStr.match(/v\s*\/\s*([0-9.]+)/) || toStr.match(/v\s*\*\s*([0-9.]+)/);
    if (m) {
      const divisor = Number(m[1]);
      if (divisor > 0) scale = 1.0 / divisor;
    } else {
      m = fromStr.match(/v\s*\*\s*([0-9.]+)/) || toStr.match(/v\s*\/\s*([0-9.]+)/);
      if (m && Number(m[1]) > 0) scale = Number(m[1]);
    }
    return { datatype: 'value', scale, offset: 0.0, map: null };
  };

  const legacyThermostatDps = [
    [legacyTuya?.dataPoints?.windowOpen ?? 115, 'window_open', 'bool', 1.0],
    [legacyTuya?.dataPoints?.childLock ?? 7, 'child_lock', 'bool', 1.0],
    [legacyTuya?.dataPoints?.heatingSetpoint ?? 2, 'current_heating_setpoint', 'value', 0.1],
    [legacyTuya?.dataPoints?.localTemp ?? 3, 'local_temperature', 'value', 0.1],
    [legacyTuya?.dataPoints?.battery ?? 21, 'battery', 'value', 1.0],
    [legacyTuya?.dataPoints?.mode ?? 4, 'system_mode', 'enum', 1.0]
  ];

  const append = item => {
    if (!item || !Number.isInteger(Number(item.dp))) return;
    dps.push(item);
  };

  const applyStateSuffix = rawTarget => {
    const target = String(rawTarget || '');
    const match = target.match(/^(?:state|switch)_?(?:l)?([1-9][0-9]*)$/i);
    return match ? `state_l${match[1]}` : target;
  };

  const applyLogicalEndpoint = (rawTarget, endpointName = '') => {
    const target = String(rawTarget || '');
    const suffix = String(endpointName || '');
    const suffixed = suffix && !target.endsWith(`_${suffix}`) &&
      !/^(?:state|switch)_l[1-9][0-9]*$/.test(target)
      ? `${target}_${suffix}` : target;
    const match = suffixed.match(/^(?:state|switch)_?(?:l)?([1-9][0-9]*)$/i);
    return match ? `state_l${match[1]}` : suffixed;
  };

  const staticRows = prep.meta && Array.isArray(prep.meta.tuyaDatapoints)
    ? prep.meta.tuyaDatapoints : [];
  const firstDpRow = new Set();
  const tuyaSendCommand = prep.meta && prep.meta.tuyaSendCommand === 'sendData' ? 0x04 : 0x00;

  for (const item of staticRows) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const dpId = Number(item[0]);
    const prop = item[1];
    const alreadySeenDp = firstDpRow.has(dpId);
    firstDpRow.add(dpId);
    const inboundReason = alreadySeenDp
      ? 'duplicate_dp_row_not_first'
      : (!prop ? 'composite_property_merge' : classifyInboundConverter(item[2]));
    if (!prop) {
      inboundAudit.push({
        model: String(prep.model || ''),
        vendor: String(prep.vendor || ''),
        dp: dpId,
        property: '',
        reason: inboundReason,
        source: String(item[2] && item[2].from || '').slice(0, 200)
      });
      continue;
    }
    let { datatype, scale, offset, map } = inferDatatypeFromConverter(item[2]);
    if (prop === 'system_mode' && prep.meta.tuyaThermostatSystemMode) {
      datatype = 'enum';
      map = {};
      for (const [code, label] of Object.entries(prep.meta.tuyaThermostatSystemMode)) map[String(label)] = Number(code);
    } else if (prop === 'preset' && prep.meta.tuyaThermostatPreset) {
      datatype = 'enum';
      map = {};
      for (const [code, label] of Object.entries(prep.meta.tuyaThermostatPreset)) map[String(label)] = Number(code);
    }
    if (binaryProperties.has(String(prop)) && datatype === 'value' &&
        !isInvertedBoolConverter(item[2])) {
      datatype = 'bool';
      scale = 1.0;
      offset = 0.0;
      map = null;
    }
    const target = applyStateSuffix(prop);
    const row = {dp: dpId, target, datatype, scale, offset, map, sendCommand: tuyaSendCommand};
    row.endpoint = endpointForTarget(target);
    if (inboundReason) {
      row.inboundUnsupported = true;
      row.inboundReason = inboundReason;
      inboundAudit.push({
        model: String(prep.model || ''),
        vendor: String(prep.vendor || ''),
        dp: dpId,
        property: String(prop),
        reason: inboundReason,
        source: String(item[2] && item[2].from || '').slice(0, 200)
      });
    }
    append(row);
  }

  for (const item of modernDps) {
    const dpId = Number(item.dp);
    const prop = String(item.name || '');
    const alreadySeenDp = firstDpRow.has(dpId);
    firstDpRow.add(dpId);
    let datatype = String(item.datatype || 'value');
    let scale = 1.0;
    let offset = 0.0;
    let map = null;

    if (datatype === 'enum' && item.lookup && Object.keys(item.lookup).length > 0) {
      map = {...item.lookup};
    }

    if (datatype === 'value' && Array.isArray(item.scale) && item.scale.length >= 4) {
      const [fromLow, fromHigh, toLow, toHigh] = item.scale.map(Number);
      if (Number.isFinite(fromLow) && Number.isFinite(fromHigh) &&
          Number.isFinite(toLow) && Number.isFinite(toHigh) && fromHigh !== fromLow) {
        scale = (toHigh - toLow) / (fromHigh - fromLow);
        offset = toLow - scale * fromLow;
      }
    } else if (datatype === 'value' && item.scale !== undefined && item.scale !== null && item.scale !== '') {
      const divisor = Number(item.scale);
      if (Number.isFinite(divisor) && divisor !== 0) scale = 1.0 / divisor;
    }

    if (item.valueOn && item.valueOff) {
      const onLabel = item.valueOn[0];
      const offLabel = item.valueOff[0];
      const onCode = Number(item.valueOn[1]);
      const offCode = Number(item.valueOff[1]);
      if (Number.isFinite(onCode) && Number.isFinite(offCode)) {
        if (datatype === 'bool') {
          if (onCode === 0 && offCode === 1) {
            scale = -1.0;
            offset = 1.0;
          }
        } else if (datatype === 'enum') {
          map = {[String(onLabel)]: onCode, [String(offLabel)]: offCode};
        }
      }
    }

    const target = applyLogicalEndpoint(prop, item.endpoint);
    const row = {dp: dpId, target, datatype, scale, offset, map, sendCommand: tuyaSendCommand};
    row.endpoint = endpointForTarget(target);
    if (alreadySeenDp || item.composite) {
      row.inboundUnsupported = true;
      row.inboundReason = alreadySeenDp ? 'duplicate_dp_row_not_first' : 'composite_property_merge';
      inboundAudit.push({
        model: String(prep.model || ''),
        vendor: String(prep.vendor || ''),
        dp: dpId,
        property: prop,
        reason: row.inboundReason,
        source: 'modernExtend:' + String(item.factory || ''),
      });
    }
    append(row);
  }

  const hasLegacyTuyaThermostat = Array.isArray(prep.fromZigbee) &&
    prep.fromZigbee.some(fz => String(fz && fz.convert || '').includes('firstDpValue(msg, meta, "tuya_thermostat")'));
  if (hasLegacyTuyaThermostat && staticRows.length === 0 && modernDps.length === 0) {
    const legacyModeMap = {};
    if (prep.meta && prep.meta.tuyaThermostatSystemMode) {
      for (const [code, label] of Object.entries(prep.meta.tuyaThermostatSystemMode)) legacyModeMap[String(label)] = Number(code);
    }
    for (const [dp, target, datatype, scale] of legacyThermostatDps) {
      const row = {dp: Number(dp), target, datatype, scale, offset: 0.0,
        map: target === 'system_mode' ? legacyModeMap : null, sendCommand: tuyaSendCommand};
      row.endpoint = endpointForTarget(row.target);
      append(row);
    }
    return dps;
  }

  const legacySwitchDps = extractLegacyTuyaSwitchDatapoints(prep);
  // Some official legacy Tuya converters predate meta.tuyaDatapoints and
  // encode their DPs in closure switches. Recover only semantics that are
  // explicitly visible in the official converter body: matsee garage-door
  // uses DP1 as trigger and DP3 as an inverted contact.
  const hasLegacyMatseeGarageDoor = Array.isArray(prep.fromZigbee) &&
    prep.fromZigbee.some(fz => String(fz && fz.convert || '').includes('dataPoints.garageDoorTrigger') &&
      String(fz && fz.convert || '').includes('dataPoints.garageDoorContact'));
  if (hasLegacyMatseeGarageDoor && dps.length === 0) {
    append({dp: 1, target: 'trigger', datatype: 'bool', scale: 1.0, offset: 0.0, map: null, sendCommand: tuyaSendCommand, endpoint: 1});
    append({dp: 3, target: 'garage_door_contact', datatype: 'bool', scale: -1.0, offset: 1.0, map: null, sendCommand: tuyaSendCommand, endpoint: 1});
  }

  if (legacySwitchDps.length > 0 && dps.length === 0) {
    const hasMoesSwitch = Array.isArray(prep.fromZigbee) && prep.fromZigbee.some(fz =>
      String(fz && fz.convert || '').includes('firstDpValue(msg, meta, "moes_switch")')
    );
    if (hasMoesSwitch) {
      const powerOnMap = {};
      for (const [code, label] of Object.entries(legacyTuya?.moesSwitch?.powerOnBehavior || {})) powerOnMap[String(label)] = Number(code);
      const indicateMap = {};
      for (const [code, label] of Object.entries(legacyTuya?.moesSwitch?.indicateLight || {})) indicateMap[String(label)] = Number(code);
      legacySwitchDps.push({ dp: Number(legacyTuya?.dataPoints?.moesSwitchPowerOnBehavior ?? 14), target: 'power_on_behavior', datatype: 'enum', scale: 1.0, offset: 0.0, map: powerOnMap, sendCommand: tuyaSendCommand });
      legacySwitchDps.push({ dp: Number(legacyTuya?.dataPoints?.moesSwitchIndicateLight ?? 15), target: 'indicate_light', datatype: 'enum', scale: 1.0, offset: 0.0, map: indicateMap, sendCommand: tuyaSendCommand });
    }
    for (const item of legacySwitchDps) {
      item.endpoint = endpointForTarget(item.target);
      item.sendCommand = tuyaSendCommand;
      append(item);
    }
  }

  return dps;
}

// Extract the named endpoint map without collapsing multi-endpoint devices.
// deviceEndpoints() already owns an explicit map; exposes carry the same
// endpoint names for custom definitions. The dummy-device probe is kept
// only as a last-resort fallback because it cannot know real endpoint IDs.
function extractEndpoints(prep, exposes) {
  const epMap = {};
  const addNumeric = source => {
    if (!source || typeof source !== 'object') return;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'number' && value > 0) epMap[String(key)] = value;
    }
  };

  addNumeric(prep.endpoint);
  if (typeof prep.endpoint === 'function') {
    try {
      const probeIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      const dummyDevice = {
        endpoints: probeIds.map(ID => ({ ID, inputClusters: [6, 8, 0x0300], outputClusters: [] })),
        getEndpoint: id => ({ ID: id, inputClusters: [6, 8, 0x0300], outputClusters: [] })
      };
      addNumeric(prep.endpoint(dummyDevice));
    } catch {}
  }

  // exposeEndpoints() names the physical endpoint used by each expose.
  // It is the most reliable source for devices whose endpoint() callback
  // depends on a fully interviewed device object.
  const namedIds = new Set(Object.keys(epMap));
  for (const exp of Array.isArray(exposes) ? exposes : []) {
    const name = exp && exp.endpoint !== undefined && exp.endpoint !== null ? String(exp.endpoint) : '';
    if (!name || namedIds.has(name)) continue;
    const numeric = /^[0-9]+$/.test(name) ? Number(name) : NaN;
    if (Number.isFinite(numeric) && numeric > 0) {
      epMap[name] = numeric;
      namedIds.add(name);
      continue;
    }
    // Named endpoints are conventionally numbered in declaration order.
    // This also gives a stable route when the upstream callback needs a
    // fully interviewed device to recover its real IDs.
    const nextId = Math.max(0, ...Object.values(epMap)) + 1;
    epMap[name] = nextId;
    namedIds.add(name);
  }

  if (Object.keys(epMap).length === 0) epMap.default = 1;

  // Runtime gang numbering follows this serialized order. Keep endpoint
  // IDs ascending so declaration order cannot redirect state_lN.
  const ordered = {};
  for (const [name, id] of sortedEndpointEntries(epMap)) ordered[name] = id;
  for (const key of Object.keys(epMap)) delete epMap[key];
  Object.assign(epMap, ordered);
  return epMap;
}


// Convert fromZigbee list to IR v5 rules
// Endpoint capability bits are serialized in EndpointDesc.pad8. They let
// HomeKit expose only the functions the official definition gives to that
// physical endpoint. This matters for RGBW controllers whose endpoints are
// not contiguous (for example GL-C-008-2ID uses endpoints 11 and 15).
const ENDPOINT_CAP_STATE = 0x01;
const ENDPOINT_CAP_BRIGHTNESS = 0x02;
const ENDPOINT_CAP_COLOR_TEMP = 0x04;
const ENDPOINT_CAP_COLOR_XY = 0x08;
const ENDPOINT_CAP_COVER = 0x10;
const ENDPOINT_CAP_THERMOSTAT = 0x20;
const ENDPOINT_CAP_SENSOR = 0x40;

// Device-level capabilities are derived only from official exposes and
// executable rules. The firmware uses this stable, semantic mask to create
// safe HomeKit services for compound devices without guessing by model name.
const DEVICE_CAP_STATE = 0x00000001;
const DEVICE_CAP_BRIGHTNESS = 0x00000002;
const DEVICE_CAP_COLOR_TEMP = 0x00000004;
const DEVICE_CAP_COLOR_XY = 0x00000008;
const DEVICE_CAP_TEMPERATURE = 0x00000010;
const DEVICE_CAP_HUMIDITY = 0x00000020;
const DEVICE_CAP_ILLUMINANCE = 0x00000040;
const DEVICE_CAP_CONTACT = 0x00000080;
const DEVICE_CAP_OCCUPANCY = 0x00000100;
const DEVICE_CAP_WATER_LEAK = 0x00000200;
const DEVICE_CAP_SMOKE = 0x00000400;
const DEVICE_CAP_GAS = 0x00000800;
const DEVICE_CAP_CO = 0x00001000;
const DEVICE_CAP_VIBRATION = 0x00002000;
const DEVICE_CAP_COVER = 0x00004000;
const DEVICE_CAP_LOCK = 0x00008000;
const DEVICE_CAP_THERMOSTAT = 0x00010000;
const DEVICE_CAP_BATTERY = 0x00020000;
const DEVICE_CAP_CO2 = 0x00040000;
const DEVICE_CAP_AIR_QUALITY = 0x00080000;
const DEVICE_CAP_VOC = 0x00100000;
const DEVICE_CAP_PM25 = 0x00200000;
const DEVICE_CAP_PM10 = 0x00400000;
const DEVICE_CAP_VOC_INDEX = 0x00800000;
const DEVICE_CAP_PRESSURE = 0x01000000;
const DEVICE_CAP_REMOTE = 0x02000000;

function deriveDeviceCapabilities(exposes, fromRules, toRules, tuyaDps, category) {
  let mask = 0;
  const properties = new Set();
  const add = bit => { mask |= bit; };
  for (const exp of Array.isArray(exposes) ? exposes : []) {
    const prop = String(exp && exp.property || '').toLowerCase();
    if (prop) properties.add(prop);
  }
  for (const rule of [...(fromRules || []), ...(toRules || [])]) {
    const prop = String(rule && (rule.target || rule.exposeField || rule.field) || '').toLowerCase();
    if (prop) properties.add(prop);
  }
  for (const dp of Array.isArray(tuyaDps) ? tuyaDps : []) {
    const prop = String(dp && dp.target || '').toLowerCase();
    if (prop) properties.add(prop);
  }
  const has = (...names) => names.some(name => properties.has(name));
  const hasPrefix = (...prefixes) => [...properties].some(prop => prefixes.some(prefix => prop === prefix || prop.startsWith(`${prefix}_`)));
  if (hasPrefix('state', 'switch')) add(DEVICE_CAP_STATE);
  if (hasPrefix('brightness')) add(DEVICE_CAP_BRIGHTNESS);
  if (hasPrefix('color_temp')) add(DEVICE_CAP_COLOR_TEMP);
  if (propertySetHasColorXY(properties)) add(DEVICE_CAP_COLOR_XY);
  if (hasPrefix('temperature')) add(DEVICE_CAP_TEMPERATURE);
  if (hasPrefix('humidity')) add(DEVICE_CAP_HUMIDITY);
  if (hasPrefix('illuminance')) add(DEVICE_CAP_ILLUMINANCE);
  if (hasPrefix('contact', 'door_state', 'window_state')) add(DEVICE_CAP_CONTACT);
  if (hasPrefix('garage_door_contact')) add(DEVICE_CAP_CONTACT);
  if (hasPrefix('occupancy', 'presence', 'motion')) add(DEVICE_CAP_OCCUPANCY);
  if (hasPrefix('water_leak', 'waterleak')) add(DEVICE_CAP_WATER_LEAK);
  if (hasPrefix('smoke')) add(DEVICE_CAP_SMOKE);
  if (hasPrefix('gas', 'gas_leak')) add(DEVICE_CAP_GAS);
  if (hasPrefix('carbon_monoxide')) add(DEVICE_CAP_CO);
  if (hasPrefix('vibration')) add(DEVICE_CAP_VIBRATION);
  if (hasPrefix('position', 'tilt')) add(DEVICE_CAP_COVER);
  if (hasPrefix('lock_state', 'lock')) add(DEVICE_CAP_LOCK);
  if (hasPrefix('system_mode', 'local_temperature', 'occupied_heating_setpoint', 'current_heating_setpoint')) add(DEVICE_CAP_THERMOSTAT);
  if (hasPrefix('battery', 'voltage')) add(DEVICE_CAP_BATTERY);
  if (has('co2', 'eco2')) add(DEVICE_CAP_CO2);
  if (has('air_quality', 'aqi')) add(DEVICE_CAP_AIR_QUALITY);
  if (has('voc')) add(DEVICE_CAP_VOC);
  if (has('pm25')) add(DEVICE_CAP_PM25);
  if (has('pm10')) add(DEVICE_CAP_PM10);
  if (has('voc_index')) add(DEVICE_CAP_VOC_INDEX);
  if (has('pressure')) add(DEVICE_CAP_PRESSURE);
  if (category === 'remote_control') add(DEVICE_CAP_REMOTE);
  return mask >>> 0;
}

function deriveLogicalGangMetadata(exposes, endpoints) {
  const states = stateExposes(Array.isArray(exposes) ? exposes : []);
  const props = new Set();
  for (const exp of Array.isArray(exposes) ? exposes : []) {
    const prop = String(exp && exp.property || '').toLowerCase();
    if (prop) props.add(prop);
  }
  let count = 0;
  let hasBrightness = false;
  let hasColorTemp = false;
  let hasColorXY = false;
  for (const exp of states) {
    const route = canonicalStateExpose(exp, endpoints);
    const match = String(route.property || '').match(/^state_l([1-9][0-9]*)$/);
    if (match) count = Math.max(count, Number(match[1]));
  }
  for (const prop of props) {
    const gangMatch = prop.match(/_l([1-9][0-9]*)$/);
    if (gangMatch) count = Math.max(count, Number(gangMatch[1]));
    if (propertyMatchesExpose(prop, 'brightness')) hasBrightness = true;
    if (propertyMatchesExpose(prop, 'color_temp')) hasColorTemp = true;
    if (colorExposeMatches(prop)) hasColorXY = true;
  }
  // A device may expose both color_hs and color_xy aliases. They are
  // alternate representations of the same color capability; the flag is
  // intentionally a capability bit, not a wire-command selector.
  if (count <= 0 && states.length > 0) count = states.length;
  let flags = 0;
  if (count > 0) flags |= 0x01;
  if (hasBrightness) flags |= 0x02;
  if (hasColorTemp) flags |= 0x04;
  if (hasColorXY) flags |= 0x08;
  return { count: Math.min(count, 255), flags };
}


function deriveEndpointCapabilities(prep, endpoints, exposes, fromRules, toRules, tuyaDps) {
  const result = {};
  const mark = (endpoint, flags) => {
    const id = Number(endpoint || 0);
    if (!id) return;
    result[id] = (result[id] || 0) | flags;
  };
  const markRule = rule => {
    const endpoint = Number(rule && rule.endpoint || 0);
    if (!endpoint) return;
    const cluster = parseInt(String(rule.cluster || '0'), 16);
    const target = String(rule.target || rule.exposeField || '');
    const command = Number(rule.cmd !== undefined ? rule.cmd : 0);
    const attribute = Number(rule.attr !== undefined ? rule.attr : 0);
    const isColorTemp = target === 'color_temp' || target.startsWith('color_temp_') ||
      target.startsWith('color_temp_startup');
    const isColorXY = colorExposeMatches(target) ||
      /(?:^|_)(?:x|y|hue|saturation)(?:_|$)/.test(target);
    if (cluster === 0x0006 || /^state(?:_l[1-9][0-9]*)?$/.test(target)) mark(endpoint, ENDPOINT_CAP_STATE);
    if (cluster === 0x0008 || target.startsWith('brightness')) mark(endpoint, ENDPOINT_CAP_BRIGHTNESS);
    // Command opcodes and attribute IDs can have the same numeric value
    // (0x0007 is color temperature, while 0x07 is moveToColor). Classify
    // by the official target first, then by the operation-specific number.
    if (cluster === 0x0300) {
      if (isColorTemp) mark(endpoint, ENDPOINT_CAP_COLOR_TEMP);
      else if (isColorXY) mark(endpoint, ENDPOINT_CAP_COLOR_XY);
      else if (rule.op === 'WRITE_ATTR' && attribute === 0x0007) mark(endpoint, ENDPOINT_CAP_COLOR_TEMP);
      else if (rule.op === 'COMMAND' && [0x06, 0x07].includes(command)) mark(endpoint, ENDPOINT_CAP_COLOR_XY);
      else if (rule.op === 'COMMAND' && command === 0x0A) mark(endpoint, ENDPOINT_CAP_COLOR_TEMP);
    }
    if (cluster === 0x0102 || target.startsWith('position') || target.startsWith('tilt')) mark(endpoint, ENDPOINT_CAP_COVER);
    if (cluster === 0x0201 || /^(?:local_temperature|occupied_heating_setpoint|current_heating_setpoint|system_mode)/.test(target)) mark(endpoint, ENDPOINT_CAP_THERMOSTAT);
    if ([0x0001, 0x0400, 0x0402, 0x0405, 0x0406, 0x040D, 0x0500, 0x0702, 0x0B04].includes(cluster)) mark(endpoint, ENDPOINT_CAP_SENSOR);
  };

  for (const rule of [...fromRules, ...toRules]) markRule(rule);
  for (const dp of tuyaDps) markRule({cluster: 0xEF00, target: dp.target, endpoint: dp.endpoint});

  for (const exp of exposes) {
    const route = routePropertyForExpose(exp, endpoints, prep.meta);
    const endpoint = route.endpoint || (sortedEndpointIds(endpoints).length === 1 ? sortedEndpointIds(endpoints)[0] : 0);
    if (!endpoint) continue;
    const property = String(route.property || '');
    if (/^(?:state|switch)(?:_|$)/.test(property)) mark(endpoint, ENDPOINT_CAP_STATE);
    if (property.startsWith('brightness')) mark(endpoint, ENDPOINT_CAP_BRIGHTNESS);
    if (property.startsWith('color_temp')) mark(endpoint, ENDPOINT_CAP_COLOR_TEMP);
    if (colorExposeMatches(property) || property === 'hue' ||
        property === 'saturation' || property === 'x' || property === 'y') {
      mark(endpoint, ENDPOINT_CAP_COLOR_XY);
    }
    if (/^(?:position|tilt)(?:_|$)/.test(property)) mark(endpoint, ENDPOINT_CAP_COVER);
    if (/^(?:local_temperature|occupied_heating_setpoint|current_heating_setpoint|system_mode)(?:_|$)/.test(property)) mark(endpoint, ENDPOINT_CAP_THERMOSTAT);
    if (/^(?:temperature|humidity|battery|voltage|illuminance|occupancy|contact|water_leak|smoke|gas|carbon_monoxide|vibration)(?:_|$)/.test(property)) mark(endpoint, ENDPOINT_CAP_SENSOR);
  }

  const named = {};
  for (const [name, id] of Object.entries(endpoints)) {
    const endpoint = Number(id);
    if (endpoint > 0) named[String(name)] = result[endpoint] || 0;
  }
  return { byEndpoint: result, named };
}
// Official command converters are event sources, not attribute reporters.
// Emit only semantics that can be reproduced without timers/globalStore.
function generateCommandEventIR(prep, clusterIds, endpoints) {
  const customClusters = prep && prep.__customClusters instanceof Map ? prep.__customClusters : null;
  // These are the only command converters the IR VM can execute with
  // official-equivalent semantics. Everything else is surfaced through
  // the coverage audit instead of silently pretending to be supported.
  const rules = [];
  const added = new Set();
  // 0 means "any physical endpoint". ZHC applies postfixWithEndpointName
  // to the actual message endpoint; a fixed probe endpoint would make
  // multi-endpoint remotes miss every event outside that one endpoint.
  const probeEndpointIds = [0];

  const commandSpecs = new Map([
    [zhc.fromZigbee.command_store, {kind: 'literal', value: 'store', field: 'sceneid', action: true}],
    [zhc.fromZigbee.command_recall, {kind: 'literal', value: 'recall', field: 'sceneid', action: true}],
    [zhc.fromZigbee.command_panic, {kind: 'literal', value: 'panic', action: true}],
    [zhc.fromZigbee.command_emergency, {kind: 'literal', value: 'emergency', action: true}],
    [zhc.fromZigbee.command_arm, {kind: 'arm', action: true}],
    [zhc.fromZigbee.command_arm_with_transaction, {kind: 'arm', action: true, limited: true}],
    [zhc.fromZigbee.command_cover_stop, {kind: 'literal', value: 'stop', action: true}],
    [zhc.fromZigbee.command_cover_open, {kind: 'literal', value: 'open', action: true}],
    [zhc.fromZigbee.command_cover_close, {kind: 'literal', value: 'close', action: true}],
    [zhc.fromZigbee.command_on, {kind: 'literal', value: 'on', action: true}],
    [zhc.fromZigbee.command_off, {kind: 'literal', value: 'off', action: true}],
    [zhc.fromZigbee.command_off_with_effect, {kind: 'literal', value: 'off', action: true}],
    [zhc.fromZigbee.command_toggle, {kind: 'literal', value: 'toggle', action: true}],
    [zhc.fromZigbee.command_move_to_level, {kind: 'move_to_level', action: true}],
    [zhc.fromZigbee.command_move, {kind: 'move', action: true}],
    [zhc.fromZigbee.command_step, {kind: 'step', action: true}],
    [zhc.fromZigbee.command_stop, {kind: 'literal', value: 'brightness_stop', action: true}],
    [zhc.fromZigbee.command_move_color_temperature, {kind: 'color_temp_move', action: true}],
    [zhc.fromZigbee.command_stop_move_step, {kind: 'literal', value: 'stop_move_step', action: true}],
    [zhc.fromZigbee.command_step_color_temperature, {kind: 'color_temp_step', action: true}],
    [zhc.fromZigbee.command_enhanced_move_to_hue_and_saturation, {kind: 'enhanced_hue_sat', action: true}],
    [zhc.fromZigbee.command_move_to_hue_and_saturation, {kind: 'hue_sat', action: true}],
    [zhc.fromZigbee.command_step_hue, {kind: 'hue_step', action: true}],
    [zhc.fromZigbee.command_step_saturation, {kind: 'saturation_step', action: true}],
    [zhc.fromZigbee.command_color_loop_set, {kind: 'color_loop', action: true}],
    [zhc.fromZigbee.command_move_to_color_temp, {kind: 'color_temp', action: true}],
    [zhc.fromZigbee.command_move_to_color, {kind: 'color_xy', action: true}],
    [zhc.fromZigbee.command_move_hue, {kind: 'hue_move', action: true}],
    [zhc.fromZigbee.command_move_to_saturation, {kind: 'saturation', action: true}],
    [zhc.fromZigbee.command_move_to_hue, {kind: 'hue', action: true}],
    [zhc.fromZigbee.command_on_state, {kind: 'state_on'}],
    [zhc.fromZigbee.command_off_state, {kind: 'state_off'}],
    [zhc.fromZigbee.ewelink_action, {kind: 'ewelink'}],
    [zhc.fromZigbee.command_status_change_notification_action, {kind: 'ias_action'}],
    [zhc.fromZigbee.ignore_command_on, {kind: 'ignore'}],
    [zhc.fromZigbee.ignore_command_off, {kind: 'ignore'}],
    [zhc.fromZigbee.ignore_command_off_with_effect, {kind: 'ignore'}],
    [zhc.fromZigbee.ignore_command_step, {kind: 'ignore'}],
    [zhc.fromZigbee.ignore_command_stop, {kind: 'ignore'}],
    [zhc.fromZigbee.ignore_iaszone_statuschange, {kind: 'ignore'}],
  ]);

  const converters = Array.isArray(prep.fromZigbee) ? prep.fromZigbee : [];
  for (const fz of converters) {
    let spec = commandSpecs.get(fz);
    if (!spec) {
      for (const [reference, candidate] of commandSpecs) {
        if (reference && fz && reference.convert === fz.convert) { spec = candidate; break; }
      }
    }
    if (!spec) continue;
    const types = Array.isArray(fz.type) ? fz.type : [fz.type];
    const clusters = Array.isArray(fz.cluster) ? fz.cluster : [fz.cluster];
    for (const clusterName of clusters) {
      const cluster = resolveClusterIdForDefinition(clusterName, customClusters);
      if (!cluster) continue;
      clusterIds.add(cluster);
      for (const type of types) {
        if (!String(type).startsWith('command')) continue;
        const command = officialCommandId(clusterName, type);
        if (command === undefined) continue;
        for (const endpointId of probeEndpointIds) {
          const target = spec.action ? 'action' : 'state';
          const key = `${cluster}:${command}:${endpointId}:${spec.kind}:${target}`;
          if (added.has(key)) continue;
          added.add(key);
          rules.push({
            op: 'COMMAND_EVENT',
            kind: spec.kind,
            value: spec.value || '',
            // Payload field name for composite events. The runtime maps
            // it to the official published property itself.
            field: spec.field || '',
            cluster: hex16(cluster),
            cmd: hex16(command),
            endpoint: endpointId,
            target,
            limited: spec.limited === true,
            scale: 1.0,
            offset: 0.0,
          });
        }
      }
    }
  }
  return rules;
}

function generateFromZigbeeIR(prep, clusterIds, endpoints, exposes) {
function probeSamplesForAttribute(attribute) {
  const type = Number(attribute && attribute.type);
  if (type === 0x10) return [0, 1];
  return [0, 1, 10, 25, 100, 259200, 65535];
}

function attributeDataType(attribute) {
  switch (Number(attribute && attribute.type)) {
    case 0x10: return 'bool';
    case 0x18: case 0x20: case 0x28: case 0x30: return 'uint8';
    case 0x19: case 0x21: case 0x29: case 0x31: return 'uint16';
    case 0x22: return 'uint24';
    case 0x23: return 'uint32';
    case 0x38: return 'single_prec';
    default: return 'uint16';
  }
}

function linearTransformMatches(values, transform) {
  return values.every(v => {
    if (!Number.isFinite(v.sample) || typeof v.value !== 'number') return false;
    const predicted = v.sample * transform.scale + transform.offset;
    return Math.abs(predicted - v.value) <= Math.max(0.001, Math.abs(v.value) * 1e-6);
  });
}

function inferLinearTransform(values) {
  const usable = values.filter(v => Number.isFinite(v.sample) && Number.isFinite(v.value));
  if (usable.length < 2) return {scale: 1.0, offset: 0.0};
  const first = usable[0];
  const second = usable.find(v => v.sample !== first.sample);
  if (!second) return {scale: 1.0, offset: 0.0};
  const scale = (second.value - first.value) / (second.sample - first.sample);
  const offset = first.value - scale * first.sample;
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) return {scale: 1.0, offset: 0.0};
  return {scale, offset};
}

// Named exact transforms for official converters whose piecewise formulas
// cannot be inferred safely from synthetic samples. The profile is data in
// the Manifest bundle, not a model-ID branch in firmware.
const CONVERTER_PROFILES = [
  {
    name: 'ikea_air_purifier_pm25',
    matches: (definition, attribute) =>
      String(definition && definition.model || '').toLowerCase() === 'e2007' &&
      String(attribute && attribute.name || '') === 'particulateMatter25Measurement',
    outputs: [
      {target: 'pm25', datatype: 'uint16', scale: 1.0, offset: 0.0, pm25Sentinel: true},
      {target: 'air_quality', datatype: 'uint16', scale: 1.0, offset: 0.0,
        compositeFollow: true, airQualityProfile: 2, pm25Sentinel: true},
    ],
  },
];

function findConverterProfile(definition, attribute) {
  return CONVERTER_PROFILES.find(profile => profile.matches(definition, attribute)) || null;
}

function probeCustomClusterConverter(fz, clusterDefinition, clusterId, definition, endpoints) {
  if (!fz || typeof fz.convert !== 'function') return null;
  const converterTypes = Array.isArray(fz.type) ? fz.type : [fz.type];
  // A converter with type "read" consumes the list of attributes sent in
  // a read request (often an array/Buffer), not an attribute report.
  // Replaying it with report-shaped data is both invalid and can abort
  // generation. Only report/read-response converters are probeable here.
  if (!converterTypes.some(type => type === 'attributeReport' || type === 'readResponse')) return null;
  const attributes = Object.values(clusterDefinition && clusterDefinition.attributes || {});
  if (attributes.length === 0) return null;
  const outputs = [];
  const {device, endpoint} = buildProbeDevice(endpoints, 1, probeSequence++);
  for (const attribute of attributes) {
    const observations = [];
    for (const sample of probeSamplesForAttribute(attribute)) {
      const msg = {type: 'attributeReport', data: {[attribute.name]: sample}, endpoint, device, meta: {device}};
      let published = null;
      try { published = fz.convert(definition, msg, value => { published = value; }, {}, {device}); } catch { continue; }
      if (published && typeof published === 'object' && !Array.isArray(published)) observations.push({sample, published});
    }
    if (observations.length === 0) continue;
    const exactProfile = findConverterProfile(definition, attribute);
    if (exactProfile) {
      for (const output of exactProfile.outputs) {
        outputs.push({...output, attributeId: Number(attribute.ID)});
      }
      continue;
    }
    const fields = new Map();
    for (const observation of observations) {
      for (const [field, value] of Object.entries(observation.published)) {
        if (value === undefined) continue;
        if (!fields.has(field)) fields.set(field, []);
        fields.get(field).push({sample: observation.sample, value});
      }
    }
    const derived = [];
    for (const [field, values] of fields) {
      const numeric = values.every(v => typeof v.value === 'number');
      const booleanOutput = values.every(v => typeof v.value === 'boolean');
      const stringOutput = values.every(v => typeof v.value === 'string');
      if (numeric) {
        const transform = inferLinearTransform(values);
        // Only accept an exact affine mapping. A piecewise vendor formula
        // (IKEA fanMode/fanSpeed) must not be flattened into a wrong line.
        if (!linearTransformMatches(values, transform)) continue;
        derived.push({target: field, scale: transform.scale, offset: transform.offset, datatype: attributeDataType(attribute)});
      } else if (booleanOutput) {
        // Only identity booleans are safe without a dedicated transform
        // profile. Inverted booleans stay unsupported instead of inverted.
        const identity = values.every(v => Boolean(v.value) === Boolean(v.sample));
        if (!identity) continue;
        derived.push({target: field, scale: 1.0, offset: 0.0, datatype: 'bool'});
      } else if (stringOutput) {
        // Air quality is the one string output with a named, exact profile.
        if (field === 'air_quality') {
          derived.push({target: field, scale: 1.0, offset: 0.0, datatype: 'string'});
        }
      }
    }
    if (derived.length === 0) continue;
    const hasPm25 = derived.some(item => item.target === 'pm25');
    for (const item of derived) {
      if (item.target === 'air_quality') item.airQualityProfile = hasPm25 ? 2 : 1;
      item.attributeId = Number(attribute.ID);
      outputs.push(item);
    }
  }
  return outputs.length > 0 ? {outputs} : null;
}

  const rules = [];
  const addedKeys = new Set();

  const customClusters = prep && prep.__customClusters instanceof Map ? prep.__customClusters : null;

  function addRule(rule) {
    const key = `${rule.cluster}:${rule.attr}:${rule.target}:${rule.endpoint || 0}`;
    if (!addedKeys.has(key)) {
      addedKeys.add(key);
      rules.push(rule);
    }
  }

  // Official ignore_* converters consume a matching report and publish
  // nothing. Serialize that semantic explicitly so the runtime fallback
  // cannot invent state which ZHC intentionally suppresses.
  const ignoredClusters = new Set();
  for (const fz of (Array.isArray(prep.fromZigbee) ? prep.fromZigbee : [])) {
    const source = String(fz && fz.convert || '').replace(/\s+/g, '');
    if (!/^(?:async)?\([^)]*\)=>\{\}$/.test(source)) continue;
    const clusters = Array.isArray(fz.cluster) ? fz.cluster : [fz.cluster];
    for (const clName of clusters) {
      const clId = resolveClusterIdForDefinition(clName, customClusters);
      if (clId) ignoredClusters.add(clId);
    }
  }
  for (const clId of ignoredClusters) {
    clusterIds.add(clId);
    addRule({
      op: 'IGNORE',
      cluster: hex16(clId),
      attr: '0xFFFF',
      datatype: 'uint8',
      endpoint: 0,
      scale: 1.0,
      offset: 0.0,
      target: ''
    });
  }

  // On/Off exposes are the source of truth for gang count and endpoint.
  // Tuya virtual gangs reuse one physical endpoint through DPs, so the DP
  // rule below wins and a duplicate ZCL rule must not be emitted.
  const stateItems = stateExposes(exposes);
  // Follow the official genOnOff converter output instead of assuming that
  // every definition referencing genOnOff is a relay. Many remotes use the
  // same cluster for commandOn/commandOff and publish action, not state.
  const onOffInspection = officialOnOffInspection(prep, endpoints);
  for (const unsupported of onOffInspection.unsupported) {
    inboundAudit.push({
      model: String(prep.model || ''),
      vendor: String(prep.vendor || ''),
      dp: 0,
      property: String(unsupported.property || ''),
      reason: unsupported.reason,
      source: unsupported.source,
    });
  }
  // Definitions whose on/off semantics are owned by a private DP light
  // converter must not synthesize a standard genOnOff state rule. WZ5
  // uses tuya_light_wz5 for both state and level; Silvercrest uses a
  // standard fz.on_off and therefore remains unaffected.
  const onOffInspectionIsPrivateDpLight = Array.isArray(prep.fromZigbee) &&
    prep.fromZigbee.some(fz => isPrivateDpLightConverter(fz));
  const semanticLimited = onOffInspection.unsupported.length > 0;
  const tuyaStateDps = extractTuyaDatapoints(prep).filter(
    dp => /^state_l[1-9][0-9]*$/.test(String(dp.target || ''))
  );
  // Include plain state for legacy one-gang Tuya switches. Their wire
  // encoding is still 0xEF00 even though the expose is named state.
  const tuyaSwitchDps = extractTuyaDatapoints(prep).filter(dp => {
    const target = String(dp.target || '');
    return /^state_l[1-9][0-9]*$/.test(target) || target === 'state';
  });
  const tuyaStateTargets = new Set(tuyaSwitchDps.map(dp => String(dp.target)));
  // Every Tuya DP target is already represented in the unpacked
  // tuyaDps table with its wire type and enum map. Generating a second
  // generic "value" rule here can shadow the richer rule at runtime.
  const tuyaAllTargets = new Set(extractTuyaDatapoints(prep).map(dp => String(dp.target || '')));
  // Every DP target is represented in the richer tuyaDatapoints table.
  // A second generic READ_ATTRIBUTE entry would be emitted first and shadow
  // its wire type / enum map (for example Tuya cover OPEN/STOP/CLOSE).
  const isDoorLock = hasLockExposeSemantics(exposes);
  const hasStandardLockState = isDoorLock && hasStandardDoorLockStateConverter(prep);
  const iasPropertySet = new Set(
    exposes.map(exp => String(exp && exp.property || '').toLowerCase()).filter(Boolean)
  );
  const iasHas = (...names) => names.some(name => iasPropertySet.has(name));

  // IAS status conversion is defined by the converter function, not by
  // the exposed property name. In particular ias_no_alarm only publishes
  // tamper/battery_low and must never synthesize a contact state.
  const iasRuleTargets = new Map();
  const addIasRule = (target, bit, invert = false) => {
    if (!iasRuleTargets.has(target)) iasRuleTargets.set(target, {bit, invert});
  };
  const iasConverters = Array.isArray(prep.fromZigbee) ? prep.fromZigbee : [];
  const sameConverter = (candidate, reference) => candidate === reference ||
    (candidate && reference && candidate.convert === reference.convert);
  const iasHasConverter = reference => iasConverters.some(fz => sameConverter(fz, reference));
  const isIasZoneConverter = fz => {
    const clusters = Array.isArray(fz && fz.cluster) ? fz.cluster : [fz && fz.cluster];
    return clusters.some(cluster => resolveClusterId(cluster) === 0x0500);
  };
  const observeIasConverter = fz => {
    if (!fz || typeof fz.convert !== 'function' || !isIasZoneConverter(fz)) return null;
    const observed = {};
    const probe = (zoneStatus, bit = null) => {
      const msg = {
        type: 'attributeReport',
        data: {zoneStatus, zonestatus: zoneStatus},
        endpoint: {},
      };
      let published = null;
      try {
        published = fz.convert({meta: {}}, msg, value => { published = value; }, {}, {});
      } catch (err) {
        // Some vendor converters claim ssIasZone but require the full
        // Tuya message envelope. A failed synthetic probe must never
        // abort extraction of the remaining definitions.
        if (err) return;
        return;
      }
      if (published && typeof published === 'object') {
        for (const [key, value] of Object.entries(published)) {
          if (typeof value !== 'boolean') continue;
          const target = String(key);
          if (!observed[target]) observed[target] = {};
          observed[target][bit === null ? 'baseline' : `bit${bit}`] = value;
        }
      }
    };
    probe(0);
    for (let bit = 0; bit <= 3; bit++) probe(1 << bit, bit);
    return observed;
  };
  const iasSemantics = {};
  for (const fz of iasConverters) {
    const observed = observeIasConverter(fz);
    if (!observed) continue;
    for (const [target, values] of Object.entries(observed)) {
      const baseline = values.baseline;
      if (typeof baseline !== 'boolean') continue;
      const samples = Object.entries(values)
        .filter(([key, value]) => /^bit[0-3]$/.test(key) && typeof value === 'boolean')
        .map(([key, value]) => ({bit: Number(key.slice(3)), value}))
        .filter(sample => sample.value !== baseline);
      if (samples.length !== 1) continue;
      const control = samples[0];
      iasSemantics[target] = {bit: control.bit, invert: control.value === false};
    }
  }
  const iasOnlyNoAlarm = iasHasConverter(zhc.fromZigbee.ias_no_alarm) &&
    !iasConverters.some(fz => !sameConverter(fz, zhc.fromZigbee.ias_no_alarm) &&
      resolveClusterId(Array.isArray(fz && fz.cluster) ? fz.cluster[0] : fz && fz.cluster) === 0x0500);

  for (const [target, semantics] of Object.entries(iasSemantics)) {
    addIasRule(target, semantics.bit, semantics.invert);
  }

  if (iasRuleTargets.size === 0 && !iasOnlyNoAlarm) {
    if (iasHas('water_leak', 'waterleak', 'water_leak_alarm_1')) addIasRule('water_leak', 0);
    else if (iasHas('smoke', 'smoke_alarm_1')) addIasRule('smoke', 0);
    else if (iasHas('gas_leak', 'gas', 'gas_alarm_1')) addIasRule('gas', 0);
    else if (iasHas('gas_alarm_2')) addIasRule('gas', 1);
    else if (iasHas('carbon_monoxide', 'carbon_monoxide_alarm_1')) addIasRule('carbon_monoxide', 0);
    else if (iasHas('occupancy', 'presence', 'motion', 'occupancy_alarm_1')) addIasRule('occupancy', 0);
    else if (iasHas('occupancy_alarm_2')) addIasRule('occupancy', 1);
    else if (iasHas('vibration', 'vibration_alarm_1')) addIasRule('vibration', 0);
    else if (iasHas('sos', 'sos_alarm_2')) addIasRule('alarm', 1);
    else if (iasHas('contact')) addIasRule('contact', 0);
    else if (iasHas('alarm', 'alarm_1')) addIasRule('alarm', 0);
  }
  const iasRuleList = Array.from(iasRuleTargets, ([target, semantics]) => ({
    target,
    bit: semantics.bit,
    invert: semantics.invert === true,
  }));
  if (!isDoorLock) {
    const onOffTargets = onOffInspectionIsPrivateDpLight
      ? new Map()
      : onOffInspection.targets;
    // The official converter result is authoritative. A genOnOff
    // attribute converter that returns only action, cover state, or no
    // state must never be materialized as a synthetic relay.
    for (const [target, inspectedEndpoint] of onOffTargets) {
      if (tuyaStateTargets.has(target)) continue;
      if (tuyaAllTargets.has(target)) continue;
      const matchingExpose = stateItems.find(exp =>
        canonicalStateExpose(exp, endpoints).property === target);
      const normalized = matchingExpose
        ? canonicalStateExpose(matchingExpose, endpoints)
        : canonicalStateProperty(target, endpoints);
      const endpoint = normalized.property === 'state'
        ? 0
        : (normalized.endpoint || inspectedEndpoint || 0);
      addRule({
        op: 'READ_ATTRIBUTE',
        cluster: hex16(0x0006),
        attr: hex16(0x0000),
        datatype: 'bool',
        endpoint,
        scale: 1.0,
        offset: 0.0,
        target: normalized.property
      });
      clusterIds.add(0x0006);
    }
    // The converter probe uses one synthetic endpoint. For multi-endpoint
    // devices, official exposes already contain one route per gang, so
    // materialize any route the probe could not synthesize. This keeps
    // the official expose order and endpoint binding for all brands.
    if (onOffTargets.size > 0) {
      for (const exp of stateItems) {
        const route = canonicalStateExpose(exp, endpoints);
        if (!route.property || (route.property !== 'state' &&
            !/^state_l[1-9][0-9]*$/.test(route.property))) continue;
        if (tuyaStateTargets.has(route.property) || tuyaAllTargets.has(route.property)) continue;
        addRule({
          op: 'READ_ATTRIBUTE',
          cluster: hex16(0x0006),
          attr: hex16(0x0000),
          datatype: 'bool',
          endpoint: route.property === 'state' ? 0 : route.endpoint,
          scale: 1.0,
          offset: 0.0,
          target: route.property
        });
        clusterIds.add(0x0006);
      }
    }
  } else if (hasStandardLockState) {
    // Standard locks report lockState (0x0000) on the Door Lock cluster.
    // Do not synthesize a genOnOff report: it is a different cluster and
    // would overwrite the real lock state on devices that also expose one.
    const endpoint = stateItems.length > 0 ? canonicalStateExpose(stateItems[0], endpoints).endpoint : 0;
    addRule({
      op: 'READ_ATTRIBUTE',
      cluster: hex16(0x0101),
      attr: hex16(0x0000),
      datatype: 'uint8',
      endpoint,
      scale: 1.0,
      offset: 0.0,
      target: 'lock_state'
    });
    clusterIds.add(0x0101);
  }

  // One Tuya DP rule per virtual gang. The DP id is the physical control
  // address; state_lN is only the logical UI/HomeKit name.
  for (const dp of tuyaStateDps) {
    const match = String(dp.target).match(/^state_l([1-9][0-9]*)$/);
    if (!match) continue;
    if (tuyaAllTargets.has(String(dp.target))) continue;
    addRule({
      op: 'READ_ATTRIBUTE',
      cluster: hex16(0xEF00),
      attr: hex16(Number(dp.dp)),
      datatype: dp.datatype === 'bool' ? 'bool' : 'value',
      endpoint: 1,
      scale: dp.scale,
      offset: dp.offset,
      target: `state_l${match[1]}`
    });
    clusterIds.add(0xEF00);
  }
  for (const dp of tuyaSwitchDps) {
    if (String(dp.target) !== 'state') continue;
    if (tuyaAllTargets.has('state')) continue;
    addRule({
      op: 'READ_ATTRIBUTE',
      cluster: hex16(0xEF00),
      attr: hex16(Number(dp.dp)),
      datatype: dp.datatype === 'bool' ? 'bool' : 'value',
      endpoint: 1,
      scale: dp.scale,
      offset: dp.offset,
      target: 'state'
    });
    clusterIds.add(0xEF00);
  }
  // Iterate over prep.fromZigbee for non-state clusters.
  if (Array.isArray(prep.fromZigbee)) {
    for (const fz of prep.fromZigbee) {
      if (!fz) continue;
      const clusters = Array.isArray(fz.cluster) ? fz.cluster : [fz.cluster];
      for (const clName of clusters) {
      const clId = resolveClusterIdForDefinition(clName, customClusters);
        if (!clId) continue;
        clusterIds.add(clId);

        // Standard ZCL Cluster Mapping
        if (clId === 0x0006) { // OnOff
          // The official onOff inspection above is the only source of
          // attribute state rules. Command-only and action-only
          // definitions intentionally leave this block empty.
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
        } else if (clId === 0x040D) { // msCO2
          // Official fz.co2: measuredValue is a SINGLE_PREC fraction of 1,000,000.
          // Floor after scaling to match ZHC exactly.
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x040D), attr: hex16(0x0000), datatype: 'single_prec', scale: 1000000.0, offset: 0.0, target: 'co2', round: 'floor' });
        } else if (clId === 0x042A) { // pm25Measurement
          // Official fz.pm25 publishes measuredValue directly in ug/m3.
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x042A), attr: hex16(0x0000), datatype: 'single_prec', scale: 1.0, offset: 0.0, target: 'pm25' });
        } else if (clId === 0xFC03) { // Develco air quality / VOC
          // fz.develcoAirQuality publishes both properties from the same raw
          // ppb value: voc = ppb * 4.5 and air_quality = threshold bucket.
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0xFC03), attr: hex16(0x0000), datatype: 'uint16', scale: 4.5, offset: 0.0, target: 'voc' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0xFC03), attr: hex16(0x0000), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'air_quality', airQualityProfile: 1, compositeFollow: true });
        } else if (clId === 0x0500) { // IAS Zone
          // One ZHC converter can publish several bits from the same
          // zoneStatus word (for example CO Alarm 1 + Gas Alarm 2).
          // Emit one rule per semantic property and decode each bit
          // independently at runtime.
          for (const iasRule of iasRuleList) {
            addRule({
              op: 'READ_ATTRIBUTE',
              cluster: hex16(0x0500),
              attr: hex16(0x0002),
              datatype: 'uint16',
              scale: 1.0,
              offset: 0.0,
              target: iasRule.target,
              iasBit: iasRule.bit,
              iasInvert: iasRule.invert,
            });
          }
        } else if (clId === 0x0001) { // PowerCfg
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0001), attr: hex16(0x0021), datatype: 'uint8', scale: 0.5, offset: 0.0, target: 'battery' });
          // genPowerCfg.batteryVoltage is uint16 in 100 mV units. The
          // legacy fz.battery publishes mV, so keep the official scale
          // on the correct 16-bit wire type.
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0001), attr: hex16(0x0020), datatype: 'uint16', scale: 100.0, offset: 0.0, target: 'voltage' });
        } else if (clId === 0x0B04) { // Electrical Measurement
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0B04), attr: hex16(0x050B), datatype: 'int16', scale: 1.0, offset: 0.0, target: 'power' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0B04), attr: hex16(0x0505), datatype: 'uint16', scale: 1.0, offset: 0.0, target: 'voltage' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0B04), attr: hex16(0x0508), datatype: 'uint16', scale: 0.001, offset: 0.0, target: 'current' });
        } else if (clId === 0x0702) { // Metering
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0702), attr: hex16(0x0000), datatype: 'uint48', scale: 0.001, offset: 0.0, target: 'energy' });
        } else if (clId === 0x0101) { // Door Lock
          // Only a converter that decodes the standard lockState attribute
          // can use the standard Door Lock path. Aqara converters use this
          // cluster as a container for proprietary keys.
          if (hasStandardLockState) {
            addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0101), attr: hex16(0x0000), datatype: 'uint8', scale: 1.0, offset: 0.0, target: 'lock_state' });
          }
        } else if (clId === 0x0102) { // Window Covering
          addRule({
            op: 'READ_ATTRIBUTE',
            cluster: hex16(0x0102),
            attr: hex16(0x0008),
            datatype: 'uint8',
            scale: 1.0,
            offset: 0.0,
            target: 'position',
            coverInverted: prep.meta && prep.meta.coverInverted === true,
          });
        } else if (clId === 0x0201) { // Thermostat
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0201), attr: hex16(0x0000), datatype: 'int16', scale: 0.01, offset: 0.0, target: 'local_temperature' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0201), attr: hex16(0x0012), datatype: 'int16', scale: 0.01, offset: 0.0, target: 'occupied_heating_setpoint' });
          addRule({ op: 'READ_ATTRIBUTE', cluster: hex16(0x0201), attr: hex16(0x001C), datatype: 'enum8', scale: 1.0, offset: 0.0, target: 'system_mode' });
        }

        // Vendor-defined clusters. The official converter is the source
        // of truth: probe each declared attribute with representative
        // values and materialize every field it actually publishes.
        // This covers IKEA, Develco, Lumi, Bosch, Philips and any other
        // deviceAddCustomCluster() definition without model checks.
        const customClusterEntry = customClusters && customClusters.get(String(clName));
        const customCluster = customClusterEntry && customClusterEntry.definition;
        if (customCluster && clId > 0) {
          const probeResult = probeCustomClusterConverter(fz, customCluster, clId, prep, endpoints);
          if (probeResult) {
            const seenAttributes = new Set();
            for (const output of probeResult.outputs) {
              const attributeKey = String(output.attributeId);
              const follow = seenAttributes.has(attributeKey);
              seenAttributes.add(attributeKey);
              addRule({
                op: 'READ_ATTRIBUTE',
                cluster: hex16(clId),
                attr: hex16(output.attributeId),
                datatype: output.datatype,
                scale: output.scale,
                offset: output.offset,
                target: output.target,
                compositeFollow: follow,
                airQualityProfile: output.airQualityProfile || 0,
                round: output.round || undefined,
                pm25Sentinel: output.pm25Sentinel === true,
              });
            }
          }
        }
      }
    }
  }

  return rules;
}

// Convert the official toZigbee table to IR rules. Each official converter
// entry owns its endpoints; flattening keys first loses which endpoint a
// state/brightness/color command belongs to.
function generateToZigbeeIR(prep, clusterIds, endpoints, exposes) {
  const rules = [];
  const addedKeys = new Set();

  const customClusters = prep && prep.__customClusters instanceof Map ? prep.__customClusters : null;
  const stateItems = stateExposes(exposes);
  const isDoorLock = hasLockExposeSemantics(exposes);
  // A definition that controls its light through private Tuya DPs must not
  // leak a standard ZCL command from a sibling tz.on_off converter.
  const privateDpLightDefinition = definitionUsesPrivateDpLight(prep);
  const privateDpLightKeys = new Set();
  if (privateDpLightDefinition) {
    for (const tz of (Array.isArray(prep.toZigbee) ? prep.toZigbee : [])) {
      if (!isPrivateDpLightConverter(tz)) continue;
      for (const key of (Array.isArray(tz.key) ? tz.key : [])) {
        const property = String(key || '');
        if (property) privateDpLightKeys.add(property);
      }
    }
  }
  const tuyaStateTargets = new Set(
    extractTuyaDatapoints(prep)
      .map(dp => String(dp.target || ''))
      .filter(target => /^state_l[1-9][0-9]*$/.test(target) || target === 'state')
  );

  function addRule(rule) {
    const key = `${rule.cluster}:${rule.target}:${rule.endpoint || 0}:${rule.op}:${rule.cmd || rule.attr || 0}`;
    if (addedKeys.has(key)) return;
    addedKeys.add(key);
    rules.push(rule);
  }

  function exposeRoutesForBase(base, stateOnly = false) {
    const routes = [];
    const seen = new Set();
    const candidates = stateOnly ? stateItems : exposes;
    for (const exp of candidates) {
      const raw = String(exp && exp.property || '');
      const matches = stateOnly
        ? /^(?:state|switch)(?:_|$)/i.test(raw)
        : propertyMatchesExpose(raw, base, endpoints);
      if (!matches) continue;
      const route = stateOnly
        ? canonicalStateExpose(exp, endpoints)
        : routePropertyForExpose(exp, endpoints, prep.meta);
      if (!route.property) continue;
      if (stateOnly && route.endpoint === 0 && stateItems.some(other =>
          other !== exp && canonicalStateExpose(other, endpoints).endpoint > 0)) continue;
      const key = `${route.property}:${route.endpoint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(route);
    }
    return routes;
  }

  // Official expose names such as brightness_rgb, brightness_white or
  // color_temp_cct already identify the physical endpoint. HomeKit and the
  // generic action API address those outputs by gang, so add a canonical
  // brightness_lN / color_temp_lN alias. Keep the official field as well:
  // Z2M semantics and the original property must remain available.
  function addGangAliases(officialRules, exposes, endpoints, meta) {
    const aliases = new Map();
    const addAlias = (base, officialRule) => {
      const endpoint = Number(officialRule.endpoint || 0);
      if (!endpoint) return;
      const gang = statePropertyForEndpoint(endpoints, endpoint);
      const match = gang.match(/^state_l([1-9][0-9]*)$/);
      if (!match) return;
      const caps = deriveEndpointCapabilities(prep, endpoints, exposes, [], officialRules, []).byEndpoint;
      const requiredCap = base === 'brightness' ? ENDPOINT_CAP_BRIGHTNESS
        : base === 'color_temp' ? ENDPOINT_CAP_COLOR_TEMP
        : base === 'color_xy' ? ENDPOINT_CAP_COLOR_XY : 0;
      if (requiredCap && ((caps[endpoint] || 0) & requiredCap) === 0) return;
      const target = `${base}_l${match[1]}`;
      if (target === officialRule.target) return;
      const key = `${officialRule.cluster}:${target}:${endpoint}:${officialRule.op}:${officialRule.cmd || officialRule.attr || 0}`;
      if (aliases.has(key)) return;
      aliases.set(key, {
        ...officialRule,
        target,
        aliasOf: String(officialRule.target || ''),
      });
    };

    for (const exp of exposes) {
      const raw = String(exp && exp.property || '');
      const route = routePropertyForExpose(exp, endpoints, meta);
      if (!route.endpoint) continue;
      if (propertyMatchesExpose(raw, 'brightness', endpoints)) {
        const official = officialRules.find(rule => rule.cluster === hex16(0x0008) && rule.target === route.property && rule.endpoint === route.endpoint);
        if (official) addAlias('brightness', official);
      }
      if (propertyMatchesExpose(raw, 'color_temp', endpoints)) {
        const official = officialRules.find(rule => rule.cluster === hex16(0x0300) && rule.target === route.property && rule.endpoint === route.endpoint);
        if (official) addAlias('color_temp', official);
      }
      if (colorExposeMatches(raw)) {
        const official = officialRules.find(rule => rule.cluster === hex16(0x0300) &&
          (rule.target === route.property || rule.target === 'color_xy') &&
          rule.endpoint === route.endpoint);
        if (official) addAlias('color_xy', official);
      }
      // color_xy is commonly endpoint-less in upstream exposes. Bind the
      // alias to every endpoint that actually declares XY capability.
      if (raw === 'color' || raw === 'color_xy' || raw.startsWith('color_xy_') ||
          raw === 'color_hs' || raw.startsWith('color_hs_')) {
        const caps = deriveEndpointCapabilities(prep, endpoints, exposes, [], officialRules, []).byEndpoint;
        for (const [epName, epId] of Object.entries(endpoints)) {
          if (!(caps[epId] & ENDPOINT_CAP_COLOR_XY)) continue;
          const official = officialRules.find(rule => rule.cluster === hex16(0x0300) &&
            rule.endpoint === epId &&
            (rule.target === 'color_xy' || String(rule.target).startsWith('color_xy_')));
          if (official) addAlias('color_xy', official);
          void epName;
        }
      }
      if (propertyMatchesExpose(raw, 'position', endpoints)) {
        const official = officialRules.find(rule => rule.cluster === hex16(0x0102) && rule.target === route.property && rule.endpoint === route.endpoint);
        if (official) addAlias('position', official);
      }
      if (propertyMatchesExpose(raw, 'occupied_heating_setpoint', endpoints) ||
          propertyMatchesExpose(raw, 'current_heating_setpoint', endpoints)) {
        const official = officialRules.find(rule => rule.cluster === hex16(0x0201) &&
          rule.target === route.property && rule.endpoint === route.endpoint &&
          rule.op === 'WRITE_ATTRIBUTE');
        if (official) addAlias('target_temperature', official);
      }
      if (propertyMatchesExpose(raw, 'system_mode', endpoints)) {
        const official = officialRules.find(rule => rule.cluster === hex16(0x0201) && rule.target === route.property && rule.endpoint === route.endpoint);
        if (official) addAlias('system_mode', official);
      }
    }
    for (const alias of aliases.values()) rules.push(alias);
  }

  function routeForRule(key, tz) {
    const explicitEndpoints = Array.isArray(tz.endpoints) ? tz.endpoints : [];
    const enforce = prep.meta && prep.meta.multiEndpointEnforce && typeof prep.meta.multiEndpointEnforce === 'object'
      ? prep.meta.multiEndpointEnforce[key]
      : undefined;
    const enforceEndpoint = resolveEndpoint(enforce, endpoints);
    if (explicitEndpoints.length > 0) {
      const routes = [];
      for (const endpointName of explicitEndpoints) {
        const endpoint = resolveEndpoint(endpointName, endpoints);
        const property = stateExposedRouteForKey(key)
          ? canonicalStateExpose(stateItems.find(exp => String(exp.property) === key) || {property: key, endpoint: endpointName}, endpoints).property
          : endpointProperty(key, String(endpointName), prep.meta);
        routes.push({ property, endpoint: endpoint || 0 });
      }
      return routes;
    }
    if (enforceEndpoint > 0) {
      return [{ property: endpointProperty(key, endpointNameForId(endpoints, enforceEndpoint), prep.meta), endpoint: enforceEndpoint }];
    }
    const exposedRoutes = stateExposedRouteForKey(key)
      ? exposeRoutesForBase(key, true)
      : exposeRoutesForBase(key, false);
    if (exposedRoutes.length > 0) return exposedRoutes;
    return [{ property: key, endpoint: 0 }];
  }

  const stateExposedRouteForKey = key => {
    if (key !== 'state' && key !== 'switch') return false;
    return stateItems.length > 0;
  };

  const officialToZigbee = Array.isArray(prep.toZigbee) ? prep.toZigbee : [];
  for (const tz of officialToZigbee) {
    const keys = Array.isArray(tz && tz.key) ? tz.key : [];
    if (keys.length === 0) continue;

    const officialKey = officialToZigbeeKey(tz);
    const zclLightConverter = isOfficialZclLightConverter(tz);
    // A modern Tuya DP converter never owns a standard ZCL command.
    // Its complete wire semantics are serialized in tuyaDatapoints.
    // This is metadata-based and applies to every vendor/model.
    if (tz && tz.__z2mTuyaDpFactory) continue;
    // Private legacy converters such as Tuya WZ5 and Silvercrest use
    // vendor data points, not lightingColorCtrl. Function identity is
    // authoritative because several ZCL converters reuse the same keys.
    const isPrivateDpLight = isPrivateDpLightConverter(tz);


    for (const key of keys) {
      // legacy.tuya_light_wz5 owns these keys and emits Tuya DPs, not
      // standard ZCL commands. tuya_dimmer_state is a separate converter
      // with the same public state key; both are represented by toVm.
      if (privateDpLightDefinition &&
          (isPrivateDpLight || officialKey === 'tuya_dimmer_state')) continue;
      // The combined converter delegates color and color_temp to their
      // canonical converters. Keep only the delegated converter for each
      // key so the same public property cannot emit two wire commands.
      if (officialKey === 'light_color_colortemp' &&
          ((String(key) === 'color' && officialToZigbee.some(other =>
             officialToZigbeeKey(other) === 'light_color')) ||
           (String(key) !== 'color' && officialToZigbee.some(other =>
             officialToZigbeeKey(other) === 'light_colortemp')))) {
        continue;
      }
      // light_color_colortemp delegates color to light_color and temperature
      // to light_colortemp. Preserve that delegation instead of flattening it.
      const colorConverterKey = officialKey === 'light_color_colortemp'
        ? (String(key) === 'color' ? 'light_color' : 'light_colortemp')
        : officialKey;
      const hueAndSaturation = usesHueAndSaturation(prep.meta);
      const enhancedHue = usesEnhancedHue(prep.meta);
      // A definition may carry both light_color_colortemp and the two
      // delegated converters. They own the same public keys, but only
      // converter may own each key: color -> light_color, color_temp ->
      // light_colortemp. Otherwise Aqara emits conflicting 0x07/0x0A rules.
      const routes = routeForRule(String(key), tz);
      for (const route of routes) {
        const target = String(route.property || key);
        const endpoint = Number(route.endpoint) || 0;

        // Private DP lights have no standard ZCL control path.
        if (isPrivateDpLight) continue;
        if (!zclLightConverter && ['brightness', 'brightness_percent', 'color_temp',
            'color_temp_percent', 'color', 'color_xy', 'color_hs'].includes(String(key))) {
          continue;
        }

        if (key === 'state' || key === 'switch') {
          if (isDoorLock) {
            addRule({ op: 'COMMAND', target, endpoint, cluster: hex16(0x0101), cmd: hex16(0x00), cmd_on: hex16(0x00), cmd_off: hex16(0x01), scale: 1.0 });
          } else if (!tuyaStateTargets.has(target)) {
            addRule({ op: 'COMMAND', target, endpoint, cluster: hex16(0x0006), cmd: hex16(0x02), cmd_on: hex16(0x01), cmd_off: hex16(0x00), scale: 1.0 });
          }
        } else if (key === 'brightness' || key === 'brightness_percent') {
          addRule({ op: 'COMMAND', target, endpoint, cluster: hex16(0x0008), cmd: hex16(0x04), scale: 1.0 });
        } else if (key === 'color_temp' || key === 'color_temp_percent') {
          const colorTempCmd = colorConverterKey === 'light_color_and_colortemp_via_color' ? 0x07 : 0x0A;
          addRule({ op: 'COMMAND', target, endpoint, cluster: hex16(0x0300), cmd: hex16(colorTempCmd), scale: 1.0 });
        } else if (key === 'color' || key === 'color_xy' || key === 'color_hs') {
          const colorTarget = target === key ? 'color_xy' : target;
          const colorCmd = colorConverterKey === 'light_color' && hueAndSaturation
            ? (enhancedHue ? 0x04 : 0x06)
            : 0x07;
          if (endpoint > 0) {
            addRule({ op: 'COMMAND', target: colorTarget, endpoint, cluster: hex16(0x0300), cmd: hex16(colorCmd), scale: 1.0 });
          } else {
            // In multiEndpoint mode ZHC may expose color_xy once while
            // the physical color control lives on one or more endpoints.
            // Expand it across every endpoint with XY capability; the
            // canonical color_xy field remains for Z2M compatibility.
            const xyEndpoints = [...new Set(Object.values(endpoints).filter(id =>
              typeof id === 'number' && id > 0 &&
              ((deriveEndpointCapabilities(prep, endpoints, exposes, [], rules, []).byEndpoint[id] || 0) & ENDPOINT_CAP_COLOR_XY) !== 0))];
            if (xyEndpoints.length === 0) {
              addRule({ op: 'COMMAND', target: colorTarget, endpoint: 0, cluster: hex16(0x0300), cmd: hex16(colorCmd), scale: 1.0 });
            } else {
              for (const xyEndpoint of xyEndpoints) {
                addRule({ op: 'COMMAND', target: colorTarget, endpoint: xyEndpoint, cluster: hex16(0x0300), cmd: hex16(colorCmd), scale: 1.0 });
              }
            }
          }
        } else if (key === 'position' || key === 'cover') {
          addRule({ op: 'COMMAND', target, endpoint, cluster: hex16(0x0102), cmd: hex16(0x05), scale: 1.0, coverInverted: prep.meta && prep.meta.coverInverted === true });
        } else if (key === 'occupied_heating_setpoint' || key === 'current_heating_setpoint') {
          addRule({ op: 'WRITE_ATTRIBUTE', target, endpoint, cluster: hex16(0x0201), attr: hex16(0x0012), datatype: 'int16', scale: 100.0 });
        } else if (key === 'system_mode') {
          addRule({ op: 'WRITE_ATTRIBUTE', target, endpoint, cluster: hex16(0x0201), attr: hex16(0x001C), datatype: 'enum8', scale: 1.0 });
        }
      }
    }
  }

  if (isDoorLock) {
    addRule({ op: 'COMMAND', target: 'lock', endpoint: 0, cluster: hex16(0x0101), cmd: hex16(0x00), cmd_on: hex16(0x00), cmd_off: hex16(0x01), scale: 1.0 });
    addRule({ op: 'COMMAND', target: 'unlock', endpoint: 0, cluster: hex16(0x0101), cmd: hex16(0x01), cmd_on: hex16(0x00), cmd_off: hex16(0x01), scale: 1.0 });
  }

  addGangAliases(rules, exposes, endpoints, prep.meta);

  // A private DP light owns its state and level keys end-to-end. Keep
  // unrelated standard properties (for example a sibling relay), but do
  // not leave a synthetic genOnOff fallback for the private light state.
  const privateDpLightOwnsState = (Array.isArray(prep.toZigbee) ? prep.toZigbee : [])
    .some(tz =>
      (isPrivateDpLightConverter(tz) &&
        (Array.isArray(tz.key) ? tz.key : []).some(key =>
          String(key) === 'state' || String(key) === 'switch')) ||
      officialToZigbeeKey(tz) === 'tuya_dimmer_state');
  if (privateDpLightOwnsState) {
    return rules.filter(rule =>
      !((String(rule.target) === 'state' || String(rule.target) === 'switch') &&
        rule.cluster === hex16(0x0006)));
  }

  return rules;
}

const VM_OP = {
  HALT: 0x0000,
  PUSH_CONST: 0x0001,
  LOAD_PROPERTY: 0x0007,
  LOAD_ENDPOINT: 0x0009,
  MUL: 0x0012,
  DIV: 0x0013,
  TUYA_WRITE: 0x0081,
};

function vmInstruction(opcode, a = 0, b = 0) {
  return {opcode, flags: 0, a, b};
}

// Compile the statically provable private-DP light commands. The official
// converter remains the source of truth: this function is selected by
// converter identity, never by model name. Commands that need runtime HSB
// string formatting stay unsupported until the VM can express them.
function generatePrivateDpLightToVm(prep, tz, key, endpoint = 1) {
  const kind = privateDpLightConverterKind(tz);
  if (!kind || !key) return null;
  const pushEndpoint = () => vmInstruction(VM_OP.LOAD_ENDPOINT);
  const pushDp = dp => vmInstruction(VM_OP.PUSH_CONST, dp);
  const pushType = type => vmInstruction(VM_OP.PUSH_CONST, type);
  const pushSendCommand = () => vmInstruction(VM_OP.PUSH_CONST, 0);
  const pushValue = value => vmInstruction(VM_OP.PUSH_CONST, value);
  const write = (dp, type, valueInstructions) => [
    pushEndpoint(),
    pushDp(dp),
    pushType(type),
    pushSendCommand(),
    ...valueInstructions,
    vmInstruction(VM_OP.TUYA_WRITE),
  ];

  const scaleProperty = (fromLow, fromHigh, toLow, toHigh) => [
    vmInstruction(VM_OP.LOAD_PROPERTY),
    vmInstruction(VM_OP.PUSH_CONST, toHigh - toLow),
    vmInstruction(VM_OP.MUL),
    vmInstruction(VM_OP.PUSH_CONST, fromHigh - fromLow),
    vmInstruction(VM_OP.DIV),
    vmInstruction(VM_OP.PUSH_CONST, toLow),
    {opcode: 0x0010, flags: 0, a: 0, b: 0}, // ADD
  ];

  const stateKey = key === 'state' || key === 'switch';
  if (stateKey) {
    return [
      ...write(1, 0x01, [vmInstruction(VM_OP.LOAD_PROPERTY)]),
      vmInstruction(VM_OP.HALT),
    ];
  }
  if (key === 'brightness' || key === 'white_brightness') {
    const separateWhite = prep.meta && prep.meta.separateWhite === true;
    // WZ5 RGBW/RGBCCT route brightness through the HSB DP when white
    // is separate; that path needs runtime string packing and remains
    // explicitly unsupported rather than writing the white DP by mistake.
    if (kind === 'wz5' && separateWhite && key === 'brightness') return null;
    return [
      ...write(2, 0x04, [pushValue(0)]),
      ...write(kind === 'silvercrest' ? 3 : 2, 0x02,
        scaleProperty(0, 255, 0, 1000)),
      vmInstruction(VM_OP.HALT),
    ];
  }
  if (key === 'color_temp') {
    return [
      ...write(2, 0x04, [pushValue(0)]),
      ...write(4, 0x02, scaleProperty(454, 250, 0, 1000)),
      vmInstruction(VM_OP.HALT),
    ];
  }
  // Color HSB requires hexadecimal string packing and current-state
  // fallback. Do not emit a command that the VM cannot represent.
  return null;
}
function buildPrivateDpLightVm(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const program = [];
  const patch = [];
  for (const entry of entries) {
    program.push(vmInstruction(VM_OP.LOAD_PROPERTY_NAME));
    program.push(vmInstruction(VM_OP.PUSH_STRING, String(entry.property)));
    program.push(vmInstruction(VM_OP.EQ));
    const branch = program.length;
    program.push(vmInstruction(VM_OP.JMP_IF_FALSE, 0));
    program.push(...entry.program.slice(0, -1));
    const endJump = program.length;
    program.push(vmInstruction(VM_OP.JMP, 0));
    patch.push([branch, program.length]);
    patch.push([endJump, null]);
  }
  const haltIndex = program.length;
  program.push(vmInstruction(VM_OP.HALT));
  for (const [index, target] of patch) {
    program[index].a = target === null ? haltIndex : target;
  }
  return program;
}

// Process all definitions
const records = [];
const modelIndex = {};
const fingerprintIndex = {};

const debugModels = new Set((process.env.Z2M_DEBUG_MODELS || '')
  .split(',').map(value => value.trim()).filter(Boolean));

let processedCount = 0;
let modernExtendCount = 0;
let tuyaDpCount = 0;
let fingerprintCount = 0;

for (let i = 0; i < defs.length; i++) {
  const d = defs[i];
  if (debugModels.size > 0 && !debugModels.has(String(d && d.model || ''))) continue;
  let prep = null;
  try {
    prep = await zhc.prepareDefinition(d);
  } catch (err) {
    prep = d;
  }

  const model = String(prep.model || d.model || '').trim();
  if (!model) continue;
  const cleanId = value => String(value || '').replace(/\0+$/g, '').trim();

  const vendor = String(prep.vendor || d.vendor || '').trim();
  const description = String(prep.description || d.description || '').trim();

  // Models list
  // ZHC's model fallback only considers definitions that declare
  // zigbeeModel. Fingerprint-only definitions must not become model
  // fallback candidates, otherwise shared IDs such as TS0002 resolve to
  // an unrelated vendor-specific definition.
  // ZHC indexes every definition that can be reached by a modelID key,
  // including fingerprint-only candidates. Keep all of them in the
  // candidate index; only definitions whose zigbeeModel explicitly
  // declares the key are eligible for the official model fallback.
  const declaredModels = declaredModelKeys(prep, d);
  const indexedModelKeys = definitionModelRanks.has(d)
    ? Array.from(definitionModelRanks.get(d).keys())
    : Array.from(declaredModels);
  const modelPriority = buildModelPriorityMap(indexedModelKeys, d);
  const exactModelKeys = definitionExactModelKeys.get(d) || new Set();
  const normalizedModelKeys = definitionNormalizedModelKeys.get(d) || new Set();
  const models = new Set(indexedModelKeys);
  for (const key of normalizedModelKeys) models.add(key);
  const fallbackModelKeys = new Set();
  for (const modelKey of declaredModels) {
    const normalized = normalizeModelKey(modelKey);
    for (const indexed of indexedModelKeys) {
      if (normalizeModelKey(indexed) === normalized) fallbackModelKeys.add(indexed);
    }
  }
  const fallbackModels = Array.from(fallbackModelKeys);
  const exactModels = Array.from(exactModelKeys);
  const normalizedModels = Array.from(normalizedModelKeys);
  const hasZigbeeModel = declaredModels.size > 0;

    // Fingerprints list
  const fingerprints = [];
  // prepareDefinition() can omit metadata-only fingerprint fields (notably
  // endpoint/IEEE constraints) that are present on the original definition.
  // Merge both arrays in official order without duplicating entries.
  const rawFps = [];
  const appendFingerprints = source => {
    if (!Array.isArray(source)) return;
    for (const fp of source) rawFps.push(fp);
  };
  appendFingerprints(d.fingerprint);
  appendFingerprints(prep.fingerprint);
  for (const rawFp of rawFps) {
    const fp = normalizeFingerprint(rawFp);
    // Metadata-only fingerprints (for example KAJPLATS endpoint-only) are
    // valid ZHC definitions and must not be dropped.
    if (fp) {
      fingerprints.push(fp);
    }
  }

  // Remove exact duplicate constraints while retaining the first official
  // occurrence. This is required because prepareDefinition() may reuse or
  // clone the original fingerprint objects.
  const uniqueFingerprints = [];
  const seenFingerprintJson = new Set();
  for (const fp of fingerprints) {
    const key = JSON.stringify(fp);
    if (seenFingerprintJson.has(key)) continue;
    seenFingerprintJson.add(key);
    uniqueFingerprints.push(fp);
  }
  fingerprints.splice(0, fingerprints.length, ...uniqueFingerprints);

  for (const fp of fingerprints) {
    fp.modelPriority = buildFingerprintCandidateRanks(fp.modelID, declaredModels, d);
  }

  // Exposes
  const exposes = parseExposes(prep.exposes || d.exposes);

  // Clusters, Endpoints & IR Rules
  const clusterIds = new Set();
  const endpoints = extractEndpoints(prep, exposes);
  prep.__customClusters = collectCustomClusters(prep, d);
  const commandEventIR = generateCommandEventIR(prep, clusterIds, endpoints);
  const fromZigbeeIR = [
    ...generateFromZigbeeIR(prep, clusterIds, endpoints, exposes),
    ...commandEventIR,
  ];
  const toZigbeeIR = generateToZigbeeIR(prep, clusterIds, endpoints, exposes);
  const tuyaDatapoints = extractTuyaDatapoints(prep);
  const endpointCapabilities = deriveEndpointCapabilities(
    prep, endpoints, exposes, fromZigbeeIR, toZigbeeIR, tuyaDatapoints
  );
  const batterySemantics = extractBatterySemantics(prep, exposes, clusterIds);
  const semanticRules = await extractLumiSemanticRules(prep, exposes, batterySemantics);

  // Private Tuya DP lights use ordered mode/value writes. Build a
  // property-dispatched VM program from the official converter keys.
  const privateDpLightEntries = [];
  if (definitionUsesPrivateDpLight(prep)) {
    const seenVmProperties = new Set();
    for (const tz of (Array.isArray(prep.toZigbee) ? prep.toZigbee : [])) {
      if (!isPrivateDpLightConverter(tz)) continue;
      for (const key of (Array.isArray(tz.key) ? tz.key : [])) {
        const property = String(key || '');
        if (!property || seenVmProperties.has(property)) continue;
        const program = generatePrivateDpLightToVm(prep, tz, property, 1);
        if (!program) continue;
        seenVmProperties.add(property);
        privateDpLightEntries.push({ property, program });
      }
    }
    // WZ5's state converter is a separate official tz entry
    // (tuya_dimmer_state). Compile it from that entry, never from the
    // private light converter. Silvercrest uses tz.on_off, so its state
    // remains a standard ZCL rule and must not be rewritten to DP1.
    for (const tz of (Array.isArray(prep.toZigbee) ? prep.toZigbee : [])) {
      if (officialToZigbeeKey(tz) !== 'tuya_dimmer_state') continue;
      for (const key of (Array.isArray(tz.key) ? tz.key : [])) {
        const property = String(key || '');
        if (!property || seenVmProperties.has(property)) continue;
        const program = generatePrivateDpLightToVm(prep, tz, property, 1);
        if (!program) continue;
        seenVmProperties.add(property);
        privateDpLightEntries.push({ property, program });
      }
    }
  }
  const privateDpLightToVm = buildPrivateDpLightVm(privateDpLightEntries);


  // Audit every official fromZigbee converter against the declarative
  // runtime. Unsupported converters do not prevent identification, but
  // they must mark the definition as limited instead of being reported as
  // fully supported.
  const category = classifyCategory(exposes, description, clusterIds);
  const deviceCapabilities = deriveDeviceCapabilities(
    exposes, fromZigbeeIR, toZigbeeIR, tuyaDatapoints, category
  );
  const logicalGangs = deriveLogicalGangMetadata(exposes, endpoints);
  const coverageMissing = auditFromZigbeeCoverage(prep, category);

  if (d.extend) modernExtendCount++;
  if (tuyaDatapoints.length > 0) tuyaDpCount++;
  if (fingerprints.length > 0) fingerprintCount += fingerprints.length;

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
  const hasInbound = fromZigbeeIR.some(rule => !rule.ignore) ||
    tuyaDatapoints.some(dp => !dp.inboundUnsupported);
  const hasOutbound = toZigbeeIR.length > 0 || tuyaDatapoints.length > 0 ||
    privateDpLightToVm.length > 0;
  // bits 5..7 are a three-state support descriptor consumed by the
  // firmware. Keep these bits stable; older firmware masks them out.
  if (hasInbound) flags |= 0x0020;
  if (hasOutbound) flags |= 0x0040;
  // A read-only sensor has no outbound converter by design. It is only
  // "limited" when an official converter or command path could not be
  // represented declaratively. coverageMissing is the real signal.
  const missingSemantics = coverageMissing.length > 0 ||
    commandEventIR.some(rule => rule.limited);
  if (!hasInbound || missingSemantics) {
    flags |= 0x0080;
  }

  // Configure reporting & binds
  const binds = Array.from(clusterIds).map(hex16);
  const officialConfigure = await extractOfficialReporting(
    prep, d, endpoints, prep.__customClusters instanceof Map ? prep.__customClusters : null);
  const officialReporting = officialConfigure.requests.filter(r =>
    Number(r.cluster) > 0 && Number(r.attr) >= 0 && r.dataType);
  const reporting = officialReporting.length > 0
    ? officialReporting.map(r => ({
        cluster: hex16(r.cluster),
        attr: hex16(r.attr),
        min: Number.isFinite(r.min) && r.min >= 0 ? r.min : 10,
        max: Number.isFinite(r.max) && r.max >= 0 ? r.max : 3600,
        change: Number.isFinite(r.change) ? r.change : 0,
        dataType: r.dataType || '',
        endpoint: Number(r.endpoint) & 0xFF
      }))
    : fromZigbeeIR
        .filter(f => f.op === 'READ_ATTRIBUTE' && f.attr && f.attr !== '0xFFFF')
        .map(f => ({
          cluster: f.cluster,
          attr: f.attr,
          min: f.cluster === hex16(0x0006) ? 0 : 10,
          max: 3600,
          change: 1,
          dataType: String(f.datatype || '').toLowerCase(),
          endpoint: Number(f.endpoint || 0) & 0xFF
        }));
  for (const entry of reporting) {
    if (entry.endpoint !== undefined) entry.endpoint = Number(entry.endpoint) & 0xFF;
  }
  if (officialConfigure.binds.length > 0) {
    for (const bind of officialConfigure.binds) {
      const id = hex16(bind.cluster);
      if (!binds.includes(id)) binds.push(id);
    }
  }

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
    declaredModels: Array.from(declaredModels),
    fallbackModels,
    fingerprints,
    modelPriority,
    exactModels,
    normalizedModels,
    hasZigbeeModel,
    flags,
    endpoints,
    endpointCapabilities: endpointCapabilities.named,
    endpointCapabilityBits: endpointCapabilities.byEndpoint,
    deviceCapabilities,
    logicalGangCount: logicalGangs.count,
    logicalGangFlags: logicalGangs.flags,
    fromZigbee: fromZigbeeIR,
    toZigbee: toZigbeeIR,
    toVm: privateDpLightToVm,
    tuyaDatapoints,
   batterySemantics,
  configure: { binds, reporting },
    semanticRules,
    exposes
  };
  // White-label entries override model/vendor/description only after the
  // base definition has already been selected, matching ZHC findByDevice().
  const rawWhiteLabels = [];
  for (const source of [d.whiteLabel, prep.whiteLabel]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) rawWhiteLabels.push(item);
  }
  const uniqueWhiteLabels = [];
  const seenWhiteLabelJson = new Set();
  for (const item of rawWhiteLabels) {
    let key = '';
    try { key = JSON.stringify(item, (_k, value) => value instanceof RegExp ? value.source : value); } catch {}
    if (seenWhiteLabelJson.has(key)) continue;
    seenWhiteLabelJson.add(key);
    uniqueWhiteLabels.push(item);
  }
  const whiteLabels = uniqueWhiteLabels
    .map(w => ({ model: cleanId(w && w.model), vendor: cleanId(w && w.vendor), description: cleanId(w && w.description), fingerprint: (Array.isArray(w && w.fingerprint) ? w.fingerprint : []).map(normalizeFingerprint).filter(Boolean) }))
    .filter(w => w.model || w.vendor || w.description);

  // Runtime routing data. state_lN is a logical UI property; these tables
  // retain the physical ZCL endpoint or Tuya DP selected by ZHC.
  const endpointRoutes = Object.entries(endpoints).map(([name, id]) => ({ name: String(name), endpoint: Number(id) }));

  const stateRoutes = [];
  const addStateRoute = route => {
    const property = String(route && route.property || '');
    if (!/^state(?:_l[1-9][0-9]*)?$/.test(property)) return;
    const cluster = Number(route.cluster || 0);
    const endpoint = Number(route.endpoint || 0);
    const dp = Number(route.dp || 0);
    if (stateRoutes.some(r => r.property === property && r.cluster === cluster &&
        r.endpoint === endpoint && r.dp === dp)) return;
    stateRoutes.push({ property, cluster, endpoint, dp });
  };
  // Official exposes are the authoritative source for logical relay
  // numbering. Preserve their real endpoint even when no ZCL/DP rule
  // happens to be emitted for that path (for example a bind-only gang).
  for (const exp of stateExposes(exposes)) {
    const route = canonicalStateExpose(exp, endpoints);
    if (route.property === 'state' && route.endpoint === 0 && Object.keys(endpoints).length === 1) {
      route.endpoint = Number(Object.values(endpoints)[0]) || 0;
    }
    addStateRoute({ property: route.property, endpoint: route.endpoint, cluster: 0, dp: 0 });
  }
  for (const rule of [...fromZigbeeIR, ...toZigbeeIR]) {
    const target = String(rule.target || '');
    const cluster = Number.parseInt(String(rule.cluster || '0'), 16) || 0;
    const dp = cluster === 0xEF00 ? Number(rule.attr) : 0;
    addStateRoute({ property: target, cluster, endpoint: rule.endpoint || 0, dp });
  }
  for (const dp of tuyaDatapoints) {
    addStateRoute({ property: dp.target, cluster: 0xEF00, endpoint: dp.endpoint || 1, dp: dp.dp });
  }

  record.whiteLabels = whiteLabels;
  record.multiEndpoint = prep.meta && prep.meta.multiEndpoint === true;
  record.multiEndpointSkip = Array.isArray(prep.meta && prep.meta.multiEndpointSkip) ? prep.meta.multiEndpointSkip.map(String) : [];
  record.multiEndpointEnforce = prep.meta && prep.meta.multiEndpointEnforce && typeof prep.meta.multiEndpointEnforce === 'object' ? prep.meta.multiEndpointEnforce : {};
  record.endpointRoutes = endpointRoutes;
  record.stateRoutes = stateRoutes;
  record.deviceCapabilities = deviceCapabilities;
  record.logicalGangCount = logicalGangs.count;
  record.logicalGangFlags = logicalGangs.flags;

  records.push(record);

  // Update indexes
  for (const m of models) {
    modelIndex[m] = filename;
  }
  const seenFingerprintKeys = new Set();
  for (const fp of fingerprints) {
    const key = `${fp.manufacturerName}|${fp.modelID}`;
    if (seenFingerprintKeys.has(key)) continue;
    seenFingerprintKeys.add(key);
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

// Audit trail: every DP whose inbound semantics the declarative rule set
// cannot reproduce. The runtime consumes these reports without publishing.
// extractTuyaDatapoints() is called several times per device (rules, toZigbee
// aliases, endpoint capabilities), so the same DP is visited repeatedly.
// Deduplicate on the full audit identity before writing.
const auditSeen = new Set();
const auditLines = [];
for (const entry of inboundAudit) {
  const key = `${entry.model}|${entry.vendor}|${entry.dp}|${entry.property}|${entry.reason}`;
  if (auditSeen.has(key)) continue;
  auditSeen.add(key);
  auditLines.push(JSON.stringify(entry));
}
for (const entry of converterCoverageAudit) {
  const key = `${entry.model}|${entry.vendor}|converter|${entry.reason}|${entry.source}`;
  if (auditSeen.has(key)) continue;
  auditSeen.add(key);
  auditLines.push(JSON.stringify(entry));
}
const auditBody = auditLines.join('\n') + (auditLines.length ? '\n' : '');
fs.writeFileSync(path.join(outDir, 'z2m_vm_unsupported.ndjson'), auditBody);
console.log(`  - Unsupported inbound semantics (consumed, audited): ${auditLines.length}`);

const b = Buffer.from(ndjson);
const ib = Buffer.from(idxBody);

const manifest = {
  format: 'z2m-esp32-manifest-v6',
  version: '6.0.0',
  ir_version: 6,
  generated_at: new Date().toISOString(),
  source: 'zigbee-herdsman-converters',
  source_version: process.env.ZHC_VERSION || zhcPackageVersion,
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

// Some upstream converters schedule timers while probing definitions. The IR
// is fully written at this point, so terminate cleanly instead of waiting for
// unrelated device-side timers that may throw after generation.
process.exit(0);
