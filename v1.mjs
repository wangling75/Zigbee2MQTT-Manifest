const zhc = await import('zigbee-herdsman-converters');
zhc.setLogger({debug(){},info(){},warn(){},error(){},log(){}});
for (const [modelID, mfg] of [['ts0505b',''],['ts0505b','_TZ3210_bfwvfyx1'],['cct light',''],['ts0201',''],['zbt-dimmablelight','']]) {
  const r = await zhc.findByDevice({ieeeAddr:'0x0000000000000001',modelID,manufacturerName:mfg,endpoints:[]});
  console.log(JSON.stringify(modelID), JSON.stringify(mfg), '->', r?r.model:null);
}
