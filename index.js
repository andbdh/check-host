export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // Server-side APIs
    if (url.pathname === '/api/validate') {
      try {
        const { token, email } = await request.json();
        const headers = email ? { 'X-Auth-Email': email, 'X-Auth-Key': token } : { 'Authorization': 'Bearer ' + token };
        const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers });
        const d = await r.json();
        if (d.success) {
          const accR = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers });
          const accD = await accR.json();
          const acc = accD.result?.[0];
          return Response.json({ success: true, accountId: acc?.id, accountName: acc?.name }, { headers: cors });
        }
        return Response.json({ success: false, error: d.errors?.[0]?.message || 'Invalid' }, { headers: cors });
      } catch (e) { return Response.json({ success: false, error: e.message }, { headers: cors }); }
    }

    if (url.pathname === '/api/deploy') {
      const logs = [];
      const addLog = (msg) => logs.push(msg);
      try {
        const { token, accountId, panelType, workerName, email } = await request.json();
        const authH = (ct) => {
          const h = ct ? { 'Content-Type': ct } : {};
          if (email) { h['X-Auth-Email'] = email; h['X-Auth-Key'] = token; }
          else h['Authorization'] = 'Bearer ' + token;
          return h;
        };

        addLog('🔄 Starting deployment...');

        // Step 1: Create KV namespace (if needed)
        let kvId = null;
        if (panelType === 'cfnew' || panelType === 'nova') {
          addLog('📦 Creating KV namespace...');
          const kvR = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/kv/namespaces`, {
            method: 'POST', headers: authH('application/json'),
            body: JSON.stringify({ name: workerName + '-kv' })
          });
          const kvD = await kvR.json();
          if (kvD.success) { kvId = kvD.result.id; addLog('✅ KV created: ' + kvId); }
          else { addLog('⚠️ KV: ' + (kvD.errors?.[0]?.message || 'Failed')); }
        }

        // Step 2: Create D1 database (if needed)
        let d1Id = null;
        if (panelType === 'nahan' || panelType === 'nova') {
          addLog('📦 Creating D1 database...');
          const d1R = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
            method: 'POST', headers: authH('application/json'),
            body: JSON.stringify({ name: workerName + '-db' })
          });
          const d1D = await d1R.json();
          if (d1D.success) { d1Id = d1D.result.uuid; addLog('✅ D1 created: ' + d1Id); }
          else { addLog('⚠️ D1: ' + (d1D.errors?.[0]?.message || 'Failed')); }
        }

        // Step 3: Download source
        addLog('⬇️ Downloading source...');
        let workerSource = '';
        if (panelType === 'edtunnel') {
          const r = await fetch('https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js');
          workerSource = await r.text();
          addLog('✅ EdgeTunnel source: ' + workerSource.length + ' bytes');
        } else if (panelType === 'nahan') {
          const r = await fetch('https://raw.githubusercontent.com/itsyebekhe/nahan/refs/heads/main/_worker.js');
          workerSource = await r.text();
          addLog('✅ Nahan source: ' + workerSource.length + ' bytes');
        } else if (panelType === 'cfnew') {
          const r = await fetch('https://raw.githubusercontent.com/byJoey/cfnew/main/%E6%98%8E%E6%96%87%E6%BA%90%E5%90%97');
          workerSource = await r.text();
          addLog('✅ Cfnew source: ' + workerSource.length + ' bytes');
        } else if (panelType === 'nova') {
          const r = await fetch('https://raw.githubusercontent.com/IRNova/Nova-Proxy/main/worker.js');
          workerSource = await r.text();
          addLog('✅ Nova Proxy source: ' + workerSource.length + ' bytes');
        }

        // Step 4: Build metadata
        let bindings = [];
        if (kvId) bindings.push({ type: 'kv_namespace', name: panelType === 'nova' ? 'KV' : 'KV', namespace_id: kvId });
        if (d1Id) bindings.push({ type: 'd1', name: panelType === 'nova' ? 'DB' : 'IOT_DB', database_id: d1Id });

        let adminPass = '';
        if (panelType === 'edtunnel') {
          adminPass = Array.from({length:16}, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*62)]).join('');
        }

        const metadata = {
          main_module: 'index.js',
          bindings: bindings,
          vars: panelType === 'edtunnel' ? { ADMIN: adminPass } : panelType === 'nova' ? { PAGES_URL: 'https://nova-panel.github.io' } : {},
          compatibility_date: '2024-01-01',
          compatibility_flags: ['nodejs_compat']
        };

        // Step 5: Deploy
        addLog('📤 Deploying worker...');
        const boundary = '----FB' + Math.random().toString(36).substr(2);
        const bodyParts = [];
        bodyParts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(metadata));
        bodyParts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n' + workerSource);
        bodyParts.push('--' + boundary + '--');
        const body = bodyParts.join('\r\n');

        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, {
          method: 'PUT', headers: authH('multipart/form-data; boundary=' + boundary), body
        });
        const d = await r.json();
        if (!d.success) { addLog('❌ Deploy error: ' + (d.errors?.[0]?.message || 'Unknown')); return Response.json({ success: false, logs }, { headers: cors }); }
        addLog('✅ Worker deployed!');

        // Step 6: Enable subdomain
        addLog('🌐 Enabling subdomain...');
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
          method: 'POST', headers: authH('application/json'), body: JSON.stringify({ enabled: true })
        });
        const rSub = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers: authH() });
        const dSub = await rSub.json();
        const subdomain = dSub.result?.subdomain || accountId.substr(0, 8);

        // Cfnew UUID
        if (panelType === 'cfnew' && kvId) {
          addLog('🔑 Generating Cfnew UUID...');
          const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); });
          await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/kv/namespaces/${kvId}/values/u`, {
            method: 'PUT', headers: authH('text/plain'), body: btoa(uuid)
          });
          addLog('✅ KV variable "u" set with UUID');
        }

        const panelURL = `https://${workerName}.${subdomain}.workers.dev` + (panelType === 'nahan' ? '/sync/dash' : '');
        addLog('✅ Panel is live!');
        if (panelType === 'edtunnel' && adminPass) addLog('🔑 Admin password: ' + adminPass);
        addLog('🔗 ' + panelURL);

        return Response.json({ success: true, logs, panelURL, workerName, panelType, adminPass }, { headers: cors });
      } catch (e) { addLog('❌ Error: ' + e.message); return Response.json({ success: false, logs, error: e.message }, { headers: cors }); }
    }

    // Serve HTML
    return new Response(UI, { headers: { 'Content-Type': 'text/html;charset=utf-8', ...cors } });
  }
};

const UI = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WizardCF</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0f17;--card:#161622;--card2:#1e1e2e;--accent:#00d4aa;--accent2:#00f5c8;--text:#e0e0e0;--dim:#6b7280;--border:#2a2a3a;--success:#00d4aa;--danger:#ff4757;--gradient:linear-gradient(135deg,#00d4aa,#00f5c8)}
body{font-family:'Inter','Segoe UI',Tahoma,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:16px}
.header{text-align:center;padding:20px 0}
.logo{font-size:24px;font-weight:800;color:var(--accent)}
.logo span{color:var(--text)}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px;transition:all .3s}
.card:hover{border-color:rgba(0,212,170,.3)}
.card-header{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.card-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--gradient);font-size:22px}
.card-title{font-size:18px;font-weight:700;color:var(--text)}
.card-subtitle{font-size:12px;color:var(--dim);margin-top:2px}
.section-title{font-size:13px;font-weight:600;color:var(--dim);margin-bottom:8px;margin-top:16px}
.input{background:var(--card2);border:1px solid var(--border);color:var(--text);width:100%;padding:14px 16px;border-radius:12px;font-size:14px;outline:none;transition:all .2s}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,212,170,.15)}
.input::placeholder{color:var(--dim)}
.btn{background:var(--gradient);color:#000;border:none;padding:14px 24px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;width:100%;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 15px rgba(0,212,170,.3)}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn-sm{padding:10px 16px;font-size:12px;width:auto}
.panel-list{display:grid;gap:10px;margin:12px 0}
.cf-item{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:14px;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:space-between}
.cf-item:hover{border-color:var(--accent)}
.cf-item.active{border-color:var(--accent);box-shadow:0 0 15px rgba(0,212,170,.15)}
.panel-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px}
.cf-status{font-size:10px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.05);color:var(--dim)}
.deploy-log{background:#0a0a0f;border:1px solid var(--border);border-radius:12px;padding:16px;font-family:'Courier New',monospace;font-size:12px;max-height:250px;overflow-y:auto;line-height:1.8;color:var(--dim);margin-top:12px}
.result-box{background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:16px;margin-top:12px}
.result-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}
.result-row:last-child{border:none}
.result-label{color:var(--dim)}
.result-value{color:var(--accent);font-weight:600;direction:ltr;text-align:left}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 20px;font-size:13px;color:var(--text);z-index:100;opacity:0;transition:all .3s}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.guide{background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.1);border-radius:12px;padding:14px;font-size:12px;line-height:2.2;margin-bottom:16px}
.guide b{color:var(--accent)}
.help-link{display:inline-block;margin-top:8px;color:var(--accent);font-size:12px;cursor:pointer;text-decoration:underline}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Wizard<span>CF</span> ⚡</div>
  <div style="font-size:12px;color:var(--dim);margin-top:4px">نصب خودکار پنل‌های VPN روی Cloudflare</div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-icon">📖</div>
    <div><div class="card-title">راهنمای نصب</div><div class="card-subtitle">قدم به قدم پنل بسازید</div></div>
  </div>
  <div class="guide">
    <div><b>۱.</b> روی «🔑 ساخت توکن» بزنید</div>
    <div><b>۲.</b> در Cloudflare توکن جدید بسازید</div>
    <div><b>۳.</b> <b>مجوزها:</b> Workers Scripts, KV, D1, Pages, DNS</div>
    <div><b>۴.</b> توکن را کپی کنید و در کادر زیر بزنید</div>
    <div><b>۵.</b> پنل مورد نظر را انتخاب کنید</div>
    <div><b>۶.</b> اسم دلخواه برای ورکر بنویسید</div>
    <div><b>۷.</b> روی «نصب و فعال‌سازی» بزنید 🚀</div>
  </div>
  <a class="help-link" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">🔑 ساخت توکن</a>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-icon">🔑</div>
    <div><div class="card-title">توکن Cloudflare API</div></div>
  </div>
  <input type="password" id="cfToken" class="input" placeholder="API Token را وارد کنید" style="margin-bottom:8px;direction:ltr;text-align:left">
  <input type="email" id="cfEmail" class="input" placeholder="ایمیل (فقط برای Global API Key)" style="direction:ltr;text-align:left">
  <div style="font-size:10px;color:var(--dim);margin-top:8px">🔒 توکن ذخیره نمیشود و فقط برای نصب استفاده میشود</div>
  <button class="btn" id="validateBtn" style="margin-top:12px">🔍 بررسی توکن</button>
</div>

<div class="card" id="accountCard" style="display:none">
  <div style="text-align:center;font-size:13px">
    <div style="color:var(--dim)">اکانت</div>
    <div style="color:var(--accent);font-weight:700;margin-top:4px" id="accountName">-</div>
    <div style="font-size:11px;color:var(--dim);direction:ltr" id="accountId">-</div>
  </div>
</div>

<div class="card" id="panelCard" style="display:none">
  <div class="card-header">
    <div class="card-icon">🎯</div>
    <div><div class="card-title">نوع پنل را انتخاب کنید</div></div>
  </div>
  <div class="panel-list" id="panelList">
    <div class="cf-item" data-panel="edtunnel">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="panel-icon" style="background:linear-gradient(135deg,#ff6b6b,#ee5a24)">🔴</div>
        <div><div style="font-weight:700">EdgeTunnel</div><div style="font-size:11px;color:var(--dim)">⭐ 41.4k - VLESS/Trojan/SS</div></div>
      </div>
      <div class="cf-status" style="background:rgba(0,212,170,.15);color:var(--success)">پیشنهادی</div>
    </div>
    <div class="cf-item" data-panel="nahan">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="panel-icon" style="background:linear-gradient(135deg,#00b894,#00cec9)">🟢</div>
        <div><div style="font-weight:700">Nahan Panel</div><div style="font-size:11px;color:var(--dim)">⭐ 60+ - VLESS/Reality</div></div>
      </div>
      <div class="cf-status" style="background:rgba(0,212,170,.15);color:var(--success)">سریع</div>
    </div>
    <div class="cf-item" data-panel="cfnew">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="panel-icon" style="background:linear-gradient(135deg,#6c5ce7,#a29bfe)">🟣</div>
        <div><div style="font-weight:700">Cfnew Panel</div><div style="font-size:11px;color:var(--dim)">⭐ 14.6k - GrainTCP (کم پینگ)</div></div>
      </div>
      <div class="cf-status" style="background:rgba(108,92,231,.15);color:#a29bfe">کم پینگ</div>
    </div>
    <div class="cf-item" data-panel="nova">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="panel-icon" style="background:linear-gradient(135deg,#f59e0b,#f97316)">🦊</div>
        <div><div style="font-weight:700">Nova Proxy</div><div style="font-size:11px;color:var(--dim)">⭐ 3.1k - Trojan/Warp/Proxy</div></div>
      </div>
      <div class="cf-status">تازه</div>
    </div>
  </div>
  <div class="section-title">تنظیمات پنل</div>
  <input type="text" id="workerName" class="input" placeholder="اسم ورکر (مثلاً my-panel)" style="direction:ltr;text-align:left">
  <button class="btn" id="deployBtn" style="margin-top:12px">🚀 نصب و فعال‌سازی</button>
</div>

<div class="card" id="resultCard" style="display:none">
  <div style="text-align:center;font-size:16px;font-weight:700;color:var(--success);margin-bottom:12px">✅ نصب کامل شد!</div>
  <div id="deployLog" class="deploy-log"></div>
  <div class="result-box" id="resultBox" style="display:none">
    <div class="result-row"><span class="result-label">URL</span><span class="result-value" id="res-url">-</span></div>
    <div class="result-row"><span class="result-label">نام</span><span class="result-value" id="res-name">-</span></div>
    <div class="result-row"><span class="result-label">پنل</span><span class="result-value" id="res-panel">-</span></div>
  </div>
  <button class="btn" id="copyPanelBtn" style="margin-top:12px">📋 کپی لینک پنل</button>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  var validatedToken=null, validatedAccountId=null, validatedEmail=null, selectedPanel=null;

  function $(id){return document.getElementById(id)}
  function showToast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2500)}

  // Validate token
  $('validateBtn').addEventListener('click', async function(){
    var token=$('cfToken').value.trim();
    var email=$('cfEmail').value.trim();
    if(!token){showToast('⚠️ توکن را وارد کنید');return}
    this.textContent='⏳ در حال بررسی...';this.disabled=true;
    try{
      var r=await fetch('/api/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,email})});
      var d=await r.json();
      if(d.success){
        validatedToken=token;validatedAccountId=d.accountId;validatedEmail=email||null;
        $('accountName').textContent=d.accountName;$('accountId').textContent=d.accountId;
        $('accountCard').style.display='block';$('panelCard').style.display='block';
        $('cfToken').value='';$('cfEmail').value='';
        showToast('✅ توکن معتبر است!');
      } else {showToast('❌ '+d.error)}
    }catch(e){showToast('❌ خطا: '+e.message)}
    this.textContent='🔍 بررسی توکن';this.disabled=false;
  });

  // Select panel
  document.querySelectorAll('#panelList .cf-item').forEach(function(item){
    item.addEventListener('click',function(){
      document.querySelectorAll('#panelList .cf-item').forEach(function(i){i.classList.remove('active')});
      this.classList.add('active');
      selectedPanel=this.getAttribute('data-panel');
    });
  });

  // Deploy
  $('deployBtn').addEventListener('click', async function(){
    if(!validatedToken){showToast('⚠️ اول توکن را بررسی کنید');return}
    if(!selectedPanel){showToast('⚠️ پنل را انتخاب کنید');return}
    var workerName=$('workerName').value.trim();
    if(!workerName){showToast('⚠️ اسم ورکر را وارد کنید');return}
    this.textContent='⏳ در حال نصب...';this.disabled=true;
    $('resultCard').style.display='block';
    $('deployLog').innerHTML='';
    $('resultBox').style.display='none';

    try{
      var r=await fetch('/api/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:validatedToken,accountId:validatedAccountId,panelType:selectedPanel,workerName,email:validatedEmail})});
      var d=await r.json();
      d.logs.forEach(function(log){$('deployLog').innerHTML+=log+'<br>'});
      if(d.success){
        $('res-url').textContent=d.panelURL;$('res-name').textContent=d.workerName;$('res-panel').textContent=d.panelType.toUpperCase();
        $('resultBox').style.display='block';
        showToast('✅ نصب کامل شد!');
      } else {showToast('❌ نصب ناموفق')}
    }catch(e){showToast('❌ خطا: '+e.message)}
    this.textContent='🚀 نصب و فعال‌سازی';this.disabled=false;
  });

  // Copy panel URL
  $('copyPanelBtn').addEventListener('click',function(){
    var url=$('res-url').textContent;
    if(url&&url!=='-'){navigator.clipboard.writeText(url).then(function(){showToast('✅ کپی شد!')}).catch(function(){showToast('❌ خطا در کپی')})}
  });
})();
</script>
</body>
</html>`;
