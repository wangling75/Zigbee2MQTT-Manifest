#!/usr/bin/env node
/**
 * Build-time Z2M -> ESP32 declarative bundle generator.
 *
 * IMPORTANT:
 * zigbee-herdsman-converters contains executable JS/TS (fromZigbee,
 * toZigbee, configure, onEvent). ESP32-C3 does not execute that code.
 * This generator therefore exports safe metadata plus generic rules for
 * standard ZCL clusters. Manufacturer/private-cluster semantics still need
 * a hand-authored converter.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const out = process.argv[2] || 'z2m_bundle_out';
fs.mkdirSync(out,{recursive:true});

const mod = await import('zigbee-herdsman-converters/devices/index.js');
const defs = mod.default || mod.definitions || [];

function exposeType(x){ return x?.type || x?.name || ''; }
function exposeName(x){ return x?.name || x?.property || ''; }

function has(exposes, names) {
  const s = JSON.stringify(exposes).toLowerCase();
  return names.some(n => s.includes(n));
}

function genericRules(exposes) {
  const fz=[], tz=[];
  const addF=(cluster,attr,type,field,matter_cluster,matter_attr,multiply=1)=>{
    fz.push({cluster,attr,type,multiply,expose_to:field,matter_cluster,matter_attr});
  };

  if (has(exposes,['temperature'])) addF('0x0402','0x0000','int16','temperature','temperature_measurement','measured_value',0.01);
  if (has(exposes,['humidity'])) addF('0x0405','0x0000','uint16','humidity','relative_humidity_measurement','measured_value',0.01);
  if (has(exposes,['occupancy','presence'])) addF('0x0406','0x0000','uint8','occupancy','occupancy_sensing','occupancy_detected',1);
  if (has(exposes,['contact'])) addF('0x0500','0x0002','uint16','contact','boolean_state','state_value',1);
  if (has(exposes,['battery'])) addF('0x0001','0x0021','uint8','battery','power_source','bat_percent_remaining',0.5);
  if (has(exposes,['illuminance','illuminance_lux'])) addF('0x0400','0x0000','uint16','illuminance','illuminance_measurement','measured_value',1);
  if (has(exposes,['power'])) addF('0x0B04','0x050B','int16','power','', '',1);
  if (has(exposes,['voltage'])) addF('0x0B04','0x0505','uint16','voltage','', '',1);
  if (has(exposes,['current'])) addF('0x0B04','0x0508','uint16','current','', '',1);

  if (has(exposes,['state','switch','on_off','light'])) {
    addF('0x0006','0x0000','bool','state','on_off','on_off',1);
    tz.push({field:'state',matter_cluster:'on_off',matter_cmd:'toggle',zcl_cluster:'0x0006',zcl_cmd:'0x02',zcl_cmd_on:'0x01',zcl_cmd_off:'0x00'});
  }
  if (has(exposes,['brightness'])) {
    addF('0x0008','0x0000','uint8','brightness','level_control','current_level',1);
    tz.push({field:'brightness',matter_cluster:'level_control',matter_cmd:'move_to_level',zcl_cluster:'0x0008',zcl_cmd:'0x04'});
  }
  if (has(exposes,['dp','tuya','datapoint']) || s.includes('0xef00')) {
    addF('0xEF00','0x0000','tuya_dp','tuya_data','','',1);
  }
  return {fromZigbee:fz,toZigbee:tz};
}

const index={}, records=[];
for (const d of defs) {
  let exposes=[];
  try { exposes=typeof d.exposes==='function' ? d.exposes({isDummyDevice:true},{}) : (d.exposes||[]); } catch {}
  let models=[...(d.zigbeeModel||[])];
  if(!models.length && d.fingerprint) for(const f of d.fingerprint) if(f.modelID) models.push(f.modelID);
  models=[...new Set(models.filter(Boolean))];
  if(!models.length) continue;

  const s=JSON.stringify(exposes).toLowerCase();
  let matter_type='unknown';
  if(s.includes('cover') || s.includes('curtain') || s.includes('blind') || s.includes('shutter') || s.includes('position') || s.includes('motor_state')) matter_type='window_covering';
  else if(s.includes('climate') || s.includes('target_temperature') || s.includes('system_mode') || s.includes('thermostat')) matter_type='thermostat';
  else if(s.includes('brightness') || s.includes('color_temp') || s.includes('color_xy') || s.includes('hue')) matter_type=s.includes('color')?'color_light':'dimmable_light';
  else if(s.includes('water_leak') || s.includes('leak')) matter_type='water_leak_sensor';
  else if(s.includes('smoke') || s.includes('gas')) matter_type='smoke_sensor';
  else if(s.includes('occupancy')||s.includes('presence')) matter_type='occupancy_sensor';
  else if(s.includes('contact')) matter_type='contact_sensor';
  else if(s.includes('humidity')) matter_type='humidity_sensor';
  else if(s.includes('temperature')) matter_type='temp_sensor';
  else if(s.includes('illuminance')) matter_type='light_sensor';
  else if(s.includes('switch')||s.includes('state')) matter_type='on_off_switch';

  const safe=genericRules(exposes, s);
  const filename=`z2m_${crypto.createHash('sha1').update(String(d.model||models[0])).digest('hex').slice(0,10)}.json`;
  const binds = [...new Set(safe.fromZigbee.map(f=>f.cluster).filter(Boolean))];
  const reporting = safe.fromZigbee.map(f=>({cluster:f.cluster,attr:f.attr,min:f.cluster==='0x0006'?0:10,max:3600}));
  const rec={
    filename, model:d.model||models[0], models,
    vendor:d.vendor||'', manufacturers:d.vendor?[d.vendor]:[],
    name:d.model||models[0], description:d.description||'',
    category: matter_type, homekit_type: matter_type, matter_type, ...safe,
    configure: { binds, reporting },
    exposes:exposes.map(e=>({type:exposeType(e),name:exposeName(e)}))
  };
  records.push(rec);
  for(const m of models) index[m]=filename;
}

const ndjson=records.map(r=>JSON.stringify(r)).join('\n')+'\n';
fs.writeFileSync(path.join(out,'z2m_bundle.ndjson'),ndjson);
const idxBody=JSON.stringify(index);
fs.writeFileSync(path.join(out,'z2m_index.json'),idxBody);
const b=Buffer.from(ndjson), ib=Buffer.from(idxBody);
const manifest={
  format:'z2m-esp32-manifest-v2',
  generated_at:new Date().toISOString(),
  source:'zigbee-herdsman-converters',
  source_version:process.env.ZHC_VERSION||'unknown',
  bundle:'z2m_bundle.ndjson',
  sha256:crypto.createHash('sha256').update(b).digest('hex'),
  bytes:b.length,
  index:'z2m_index.json',
  index_sha256:crypto.createHash('sha256').update(ib).digest('hex'),
  index_bytes:ib.length,
  device_count:records.length
};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(`Generated ${records.length} device definitions, ${b.length} byte NDJSON bundle`);
