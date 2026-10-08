'use strict';
// Integer-dot QR layout. The payload is the ASCII sample identifier for scanner compatibility.
function renderUsbLabel(sample, width, height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<20||width>80||height<20||height>100) throw Error('请输入标签尺寸：宽 20–80 mm，高 20–100 mm');
  const canvas=document.createElement('canvas');canvas.width=Math.round(width*8);canvas.height=Math.round(height*8);
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  const qr=qrcode(0,'M');qr.addData(sampleQRText(sample));qr.make();
  const count=qr.getModuleCount(),margin=4,modules=count+8;
  // Reserve 2 mm on the left to compensate for the observed DL-720C label alignment.
  // Lay out within the remaining width so text never runs past the right paper edge.
  const offsetX=16,w=canvas.width-offsetX,h=canvas.height;
  ctx.translate(offsetX,0);
  // Keep four quiet-zone modules; render whole printer dots without image scaling.
  const layouts=[
    {kind:'stack',module:Math.floor(Math.min(w-2*margin,h-2*margin-52)/modules)},
    {kind:'side',module:Math.floor(Math.min(w-2*margin-72,h-2*margin)/modules)}
  ];
  layouts.sort((a,b)=>b.module-a.module);
  let layout=layouts[0];
  if(layout.module<2)layout={kind:'qr',module:Math.floor(Math.min(w-2*margin,h-2*margin)/modules)};
  if(layout.module<2)throw Error('该尺寸放不下可识别的完整二维码，请增大实际标签尺寸');
  const module=layout.module,side=modules*module;
  const left=layout.kind==='side'?margin:Math.floor((w-side)/2);
  const top=layout.kind==='stack'?margin:Math.floor((h-side)/2);
  ctx.fillStyle='#000';
  for(let r=0;r<count;r++)for(let c=0;c<count;c++)if(qr.isDark(r,c))ctx.fillRect(left+(c+4)*module,top+(r+4)*module,module,module);
  function lines(value,x,y,maxWidth,maxLines,font){
    ctx.font=font;ctx.textAlign='left';
    const chars=Array.from(String(value||''));let line='';const result=[];
    for(const ch of chars){if(line&&ctx.measureText(line+ch).width>maxWidth){result.push(line);line=ch;}else line+=ch;}
    if(line)result.push(line);
    result.slice(0,maxLines).forEach((text,i)=>{
      if(i===maxLines-1&&result.length>maxLines){while(text&&ctx.measureText(text+'…').width>maxWidth)text=Array.from(text).slice(0,-1).join('');text+='…';}
      ctx.fillText(text,x,y+i*20);
    });
  }
  if(layout.kind==='side'){
    const x=left+side+8,available=w-margin-x;
    lines(sample.name,x,Math.max(24,Math.floor(h/2)-28),available,2,'bold 16px sans-serif');
    lines(sample.code||sample.id,x,Math.max(68,Math.floor(h/2)+18),available,3,'14px sans-serif');
  }else if(layout.kind==='stack'){
    lines(sample.name,margin,top+side+22,w-margin*2,1,'bold 18px sans-serif');
    lines(sample.code||sample.id,margin,top+side+44,w-margin*2,1,'16px sans-serif');
  }
  canvas.dataset.layout=layout.kind;
  canvas.dataset.moduleDots=module;
  canvas.dataset.qrSizeMm=(side/8).toFixed(2);

  return canvas;
}
document.addEventListener('DOMContentLoaded',()=>{
  let sample=null,busy=false;
  const dialog=document.createElement('div');dialog.id='usbPrintDialog';dialog.className='modal-mask';dialog.style.zIndex='9000';
  dialog.innerHTML='<div class="modal" style="max-width:680px;width:94%"><div class="modal-head"><h3>USB 标签打印</h3><button class="btn ghost" id="usbPrintClose">关闭</button></div><div class="modal-body"><p>得力 DL-720 系列 · 装入标签纸后填写实际尺寸</p><div style="display:flex;gap:12px;flex-wrap:wrap"><label>标签宽（mm）<input class="input" id="labelWidth" type="number" min="20" max="80" step="0.1" placeholder="例如 60"></label><label>标签高（mm）<input class="input" id="labelHeight" type="number" min="20" max="100" step="0.1" placeholder="例如 50"></label><label>间隙（mm）<input class="input" id="labelGap" type="number" min="0" max="10" step="0.1" placeholder="例如 2"></label></div><p>支持间隙标签纸；连续纸间隙填 0。此入口暂不支持黑标纸。</p><div id="labelPreview" style="text-align:center;background:#e8edf2;padding:12px"></div><p id="labelLayoutStatus" role="status"></p><p id="usbPrinterStatus" role="status">先连接打印机；连接操作不会走纸。</p><button class="btn ghost" id="usbPrinterConnect">连接 USB 打印机</button><label style="display:block;margin-top:16px"><input type="checkbox" id="labelPaperReady">已装好标签纸，尺寸与上面一致</label></div><div class="modal-foot"><button class="btn ghost" id="systemPrint">系统打印 / PDF</button><button class="btn primary" id="usbPrintSend" disabled>打印 1 张</button></div></div>';
  document.body.append(dialog);
  const find=id=>dialog.querySelector('#'+id),inputs=['labelWidth','labelHeight','labelGap'].map(find);
  let preview=null;
  function settings(){return {width:Number(inputs[0].value),height:Number(inputs[1].value),gap:inputs[2].value===''?NaN:Number(inputs[2].value)};}
  function update(){
    preview=null;find('labelPreview').replaceChildren();
    try {
      const s=settings();if(!Number.isFinite(s.gap)||s.gap<0||s.gap>10)throw Error('请填写实际标签宽、高和间隙');
      preview=renderUsbLabel(sample,s.width,s.height);
      preview.style.cssText='max-width:100%;max-height:240px;object-fit:contain;image-rendering:pixelated';find('labelPreview').append(preview);
      find('labelLayoutStatus').textContent='已按 '+s.width+'×'+s.height+' mm 自动排版；二维码含留白边长 '+preview.dataset.qrSizeMm+' mm。'+(preview.dataset.layout==='qr'?'小标签二维码仅包含样本编号。':'打印二维码、名称和编号；二维码仅包含样本编号。');
    }catch(e){find('labelLayoutStatus').textContent=e.message;}
    find('usbPrintSend').disabled=busy||!preview||!find('labelPaperReady').checked;
  }
  inputs.forEach(input=>input.oninput=()=>{find('labelPaperReady').checked=false;update();});
  find('labelPaperReady').onchange=update;
  find('usbPrintClose').onclick=()=>{if(!busy)dialog.classList.remove('open');};
  find('usbPrinterConnect').onclick=()=>{
    if(!window.AndroidHost||!AndroidHost.connectLabelPrinter){find('usbPrinterStatus').textContent='请安装支持 USB 打印的安卓版本';return;}
    find('usbPrinterStatus').textContent='正在连接，请允许 USB 访问…';AndroidHost.connectLabelPrinter();
  };
  find('systemPrint').onclick=()=>{if(!busy){dialog.classList.remove('open');AndroidHost.printLabel();}};
  find('usbPrintSend').onclick=()=>{
    update();if(!preview||busy||!find('labelPaperReady').checked)return;
    if(!window.AndroidHost||!AndroidHost.printUsbLabel){find('usbPrinterStatus').textContent='当前版本不支持 USB 打印';return;}
    const s=settings();busy=true;update();find('usbPrinterStatus').textContent='正在发送 1 张标签，请勿拔出 USB…';
    find('usbPrintClose').disabled=true;find('usbPrinterConnect').disabled=true;find('systemPrint').disabled=true;
    inputs.forEach(i=>i.disabled=true);find('labelPaperReady').disabled=true;
    try {localStorage.setItem('vitals.usbLabel',JSON.stringify(s));}catch(_){}
    try {AndroidHost.printUsbLabel(JSON.stringify({...s,png:preview.toDataURL('image/png')}));}
    catch(e){window.onPrinterEvent('error','无法提交打印任务：'+e.message);}
  };
  window.onPrinterEvent=(type,text)=>{
    find('usbPrinterStatus').textContent=text;
    const deviceStatus=$('#devicePrinterStatus');
    if(deviceStatus){deviceStatus.textContent=text;deviceStatus.classList.toggle('on',type==='ready'||type==='sent');}
    if(type==='sent'||type==='error'){
      busy=false;find('usbPrintClose').disabled=false;find('usbPrinterConnect').disabled=false;find('systemPrint').disabled=false;inputs.forEach(i=>i.disabled=false);find('labelPaperReady').disabled=false;find('labelPaperReady').checked=false;update();
    }
    toast(text);
  };
  const deviceConnect=$('#devicePrinterConnect');if(deviceConnect)deviceConnect.onclick=()=>AndroidHost.connectLabelPrinter();
  window.openUsbLabelPrint=x=>{
    if(busy){toast('打印任务正在发送，请稍后');return;}
    sample=x;
    try{const s=JSON.parse(localStorage.getItem('vitals.usbLabel')||'null');if(s){inputs[0].value=s.width;inputs[1].value=s.height;inputs[2].value=s.gap;}}catch(_){}
    find('labelPaperReady').checked=false;dialog.classList.add('open');update();
  };
  const previousBack=window.androidBack;
  window.androidBack=()=>{if(dialog.classList.contains('open')){if(!busy)dialog.classList.remove('open');}else if(previousBack)previousBack();};
});
