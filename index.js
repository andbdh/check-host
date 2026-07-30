// Check Host v4 - Supports Global API Key (email+key) + API Token (bearer)
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    
    if (url.pathname === '/api/generate') {
      return Response.json({ password: generatePassword() }, { headers: cors });
    }
    
    if (url.pathname === '/api/my-ip') {
      return Response.json({ ip: request.headers.get('CF-Connecting-IP') || 'Unknown' }, { headers: cors });
    }
    
    if (url.pathname === '/api/scan-cf') {
      return Response.json(await scanCloudflareIPs(), { headers: cors });
    }
    
    // Helper: build auth headers based on token type
    function authHeaders(token, email) {
      if (email) {
        // Global API Key
        return { 'X-Auth-Email': email, 'X-Auth-Key': token, 'Content-Type': 'application/json' };
      } else {
        // API Token
        return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
      }
    }
    
    // Create API Token from Global API Key
    if (url.pathname === '/api/wizard/create-token' && request.method === 'POST') {
      try {
        const { email, globalKey } = await request.json();
        if (!email || !globalKey) return Response.json({ success: false, error: 'ایمیل و کلید را وارد کنید' }, { headers: cors });
        const gkHeaders = { 'X-Auth-Email': email, 'X-Auth-Key': globalKey, 'Content-Type': 'application/json' };
        const accR = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: gkHeaders });
        const accD = await accR.json();
        if (!accD.success || !accD.result.length) return Response.json({ success: false, error: 'اکانت پیدا نشد' }, { headers: cors });
        const accountId = accD.result[0].id;
        const tokenBody = {
          name: 'checkhost-' + Date.now(),
          policies: [{ effect: 'allow', resources: { ['com.cloudflare.api.account.' + accountId]: '*' }, permission_groups: [
            { id: 'e086da7e2179491d91ee5f35b3ca210a', name: 'Workers Scripts Write' },
            { id: 'f7f0eda5697f475c90846e879bab8666', name: 'Workers KV Storage Write' },
            { id: '09b2857d1c31407795e75e3fed8617a1', name: 'D1 Write' }
          ]}]
        };
        const tokR = await fetch('https://api.cloudflare.com/client/v4/user/tokens', { method: 'POST', headers: gkHeaders, body: JSON.stringify(tokenBody) });
        const tokD = await tokR.json();
        if (!tokD.success) return Response.json({ success: false, error: tokD.errors?.[0]?.message || 'خطا' }, { headers: cors });
        return Response.json({ success: true, token: tokD.result.value }, { headers: cors });
      } catch (e) { return Response.json({ success: false, error: e.message }, { headers: cors }); }
    }
    
    // Wizard Validate - supports both Global API Key and API Token
    if (url.pathname === '/api/wizard/validate' && request.method === 'POST') {
      try {
        const { token, email } = await request.json();
        if (!token) return Response.json({ success: false, error: 'توکن را وارد کنید' }, { headers: cors });
        
        const headers = authHeaders(token, email);
        
        // Try to get account info directly (works for both auth types)
        const r = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers });
        const d = await r.json();
        
        if (!d.success || !d.result || !d.result.length) {
          const errMsg = d.errors?.[0]?.message || 'توکن نامعتبر است';
          return Response.json({ success: false, error: errMsg }, { headers: cors });
        }
        
        return Response.json({ 
          success: true, 
          accountId: d.result[0].id, 
          accountName: d.result[0].name 
        }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors });
      }
    }
    
    // Wizard Deploy
    if (url.pathname === '/api/wizard/deploy' && request.method === 'POST') {
      try {
        const { token, email, accountId, panelType, workerName } = await request.json();
        if (!token || !accountId || !panelType || !workerName) {
          return Response.json({ success: false, error: 'Missing parameters' }, { headers: cors });
        }
        
        const headers = authHeaders(token, email);
        const logs = [];
        function addLog(msg) { logs.push(msg); }
        
        addLog('🔄 شروع نصب...');
        
        // Step 1: Create KV or D1 (only for panels that need it)
        let kvId = null, d1Id = null;
        
        if (panelType === 'cfnew') {
          addLog('📦 ساخت KV namespace...');
          const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
            method: 'POST', headers,
            body: JSON.stringify({ title: workerName + '-kv-' + Date.now() })
          });
          const d = await r.json();
          if (d.success) { kvId = d.result.id; addLog('✅ KV ساخته شد: ' + kvId); }
          else { addLog('❌ خطا: ' + (d.errors?.[0]?.message || 'Unknown')); return Response.json({ success: false, logs }, { headers: cors }); }
        }
        
        if (panelType === 'nahan') {
          addLog('🗄️ ساخت D1 database...');
          const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
            method: 'POST', headers,
            body: JSON.stringify({ name: workerName + '-db' })
          });
          const d = await r.json();
          if (d.success) { d1Id = d.result.uuid; addLog('✅ D1 ساخته شد: ' + d1Id); }
          else { addLog('❌ خطا: ' + (d.errors?.[0]?.message || 'Unknown')); return Response.json({ success: false, logs }, { headers: cors }); }
        }
        
        // Step 2: Download source
        addLog('📥 دانلود سورس...');
        let workerSource = '';
        try {
          if (panelType === 'bpb') {
          } else if (panelType === 'nahan') {
            const r = await fetch('https://raw.githubusercontent.com/itsyebekhe/nahan/refs/heads/main/_worker.js');
            workerSource = await r.text();
            addLog('✅ Nahan: ' + workerSource.length + ' bytes');
          } else if (panelType === 'cfnew') {
            const r = await fetch('https://raw.githubusercontent.com/byJoey/cfnew/main/%E6%98%8E%E6%96%87%E6%BA%90%E5%90%97');
            workerSource = await r.text();
            addLog('✅ Cfnew: ' + workerSource.length + ' bytes');
          } else if (panelType === 'edtunnel') {
            const r = await fetch('https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js');
            workerSource = await r.text();
            addLog('✅ EDtunnel: ' + workerSource.length + ' bytes');
          }
        } catch (e) {
          addLog('❌ دانلود ناموفق: ' + e.message);
          return Response.json({ success: false, logs }, { headers: cors });
        }
        
        // Step 3: Write config to KV/D1
        if (panelType === 'cfnew' && kvId) {
          const cfnewUuid = crypto.randomUUID();
          addLog('🔑 UUID Cfnew: ' + cfnewUuid);
          // Cfnew uses KV variable 'u' with UUID
          const rKV = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/u`, {
            method: 'PUT', headers, body: cfnewUuid
          });
          const dKV = await rKV.json();
          if (dKV.success) addLog('✅ متغیر "u" با UUID نوشته شد');
          else addLog('⚠️ KV write: ' + (dKV.errors?.[0]?.message || 'error'));
        }
        
        // Step 4: Deploy worker
        addLog('📤 در حال deploy...');
        let bindings = [];
        if (kvId) {
          const kvName = 'KV';
          bindings.push({ type: 'kv_namespace', name: kvName, namespace_id: kvId });
        }
        if (d1Id) bindings.push({ type: 'd1', name: 'IOT_DB', database_id: d1Id });
        
        const metadata = { main_module: 'index.js', bindings, compatibility_date: '2024-01-01', compatibility_flags: ['nodejs_compat'] };
        const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
        const body = [
          '--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(metadata),
          '--' + boundary + '\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n' + workerSource,
          '--' + boundary + '--'
        ].join('\r\n');
        
        const deployHeaders = { ...headers, 'Content-Type': 'multipart/form-data; boundary=' + boundary };
        delete deployHeaders['Content-Type'];
        deployHeaders['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
        
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, {
          method: 'PUT', headers: deployHeaders, body
        });
        const d = await r.json();
        if (!d.success) { addLog('❌ خطا: ' + (d.errors?.[0]?.message || 'Unknown')); return Response.json({ success: false, logs }, { headers: cors }); }
        addLog('✅ ورکر deploy شد!');
        
        // Step 5: Enable subdomain
        addLog('🌐 فعال‌سازی ساب‌دامنه...');
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
          method: 'POST', headers, body: JSON.stringify({ enabled: true })
        });
        
        const rSub = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers });
        const dSub = await rSub.json();
        const subdomain = dSub.result?.subdomain || accountId.substr(0, 8);
        const panelURL = `https://${workerName}.${subdomain}.workers.dev`;
        
        addLog('✅ نصب کامل شد!');
        addLog('🔗 ' + panelURL);
        
        return Response.json({ success: true, logs, panelURL, workerName, panelType }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message, logs: ['❌ خطا: ' + e.message] }, { headers: cors });
      }
    }
    
    // Main page
    return new Response(getHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors } });
  }
};

function generatePassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let p = '';
  for (let i = 0; i < 32; i++) p += chars.charAt(Math.floor(Math.random() * chars.length));
  return p;
}

async function scanCloudflareIPs() {
  const ranges = [[103,21,247,0,24],[103,21,246,0,24],[104,23,0,0,19],[104,22,240,0,20],[141,101,89,0,24],[141,101,88,0,24],[172,70,0,0,19],[172,69,24,0,21],[198,41,144,0,22],[172,70,64,0,21],[198,41,243,0,24],[198,41,148,0,24],[198,41,246,0,23],[198,41,245,0,24],[198,41,249,0,24],[198,41,248,0,24],[198,41,251,0,24],[198,41,250,0,24],[198,41,255,0,24]];
  function randIP(mask) {
    const s = 32 - mask, octets = [0,0,0,0];
    for (let i = 0; i < 4; i++) { const b = Math.min(8, s - (3 - i) * 8); octets[i] = b <= 0 ? [103,21,247,0][i] : Math.floor(Math.random() * (1 << b)); }
    return octets.join('.');
  }
  const ips = new Set();
  while (ips.size < 60) ips.add(randIP(ranges[Math.floor(Math.random() * ranges.length)][4]));
  
  const results = [];
  const start = Date.now();
  const scanIPs = [...ips].slice(0, 60);
  
  await Promise.all(scanIPs.map(async (ip) => {
    try {
      const s = Date.now();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      await fetch('https://' + ip, { signal: ctrl.signal, headers: { Host: 'speed.cloudflare.com' } });
      clearTimeout(t);
      const ping = Date.now() - s;
      results.push({ ip, ping, ok: true });
    } catch (e) {
      results.push({ ip, ping: 9999, ok: false });
    }
  }));
  
  results.sort((a, b) => a.ping - b.ping);
  return { ips: results.filter(r => r.ok), total_time: Date.now() - start, scanned: scanIPs.length };
}

function getHTML() {
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Check Host</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔍</text></svg>"><style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#06090f;
  --bg2:#0b1020;
  --card:rgba(11,16,32,0.82);
  --border:rgba(255,255,255,0.05);
  --accent:#00f0c8;
  --accent2:#00b894;
  --accent-rgb:0,240,200;
  --dim:#5a6577;
  --text:#dfe6ef;
  --text-bright:#f1f5f9;
  --error:#f85149;
  --green:#00f0c8;
  --purple:#8b5cf6;
  --purple-rgb:139,92,246;
  --blue:#3b82f6;
  --orange:#f59e0b;
  --glow:rgba(0,240,200,0.12);
  --glow2:rgba(0,240,200,0.06);
}
@keyframes bgShift{
  0%{background-position:0% 50%}
  50%{background-position:100% 50%}
  100%{background-position:0% 50%}
}
body{
  font-family:'Inter','Segoe UI',Tahoma,sans-serif;
  background:var(--bg);
  background-image:
    radial-gradient(ellipse at 15% -5%,rgba(0,240,200,0.06) 0%,transparent 45%),
    radial-gradient(ellipse at 85% 105%,rgba(139,92,246,0.05) 0%,transparent 45%),
    radial-gradient(ellipse at 50% 50%,rgba(59,130,246,0.02) 0%,transparent 60%);
  background-attachment:fixed;
  color:var(--text);
  overflow-x:hidden;
  min-height:100vh;
  direction:rtl;
  -webkit-font-smoothing:antialiased;
}
::selection{background:var(--accent);color:#000}

/* ── Header ── */
.header{
  background:rgba(11,16,32,0.88);
  backdrop-filter:blur(24px) saturate(1.2);
  -webkit-backdrop-filter:blur(24px) saturate(1.2);
  border-bottom:1px solid var(--border);
  padding:14px 20px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  position:sticky;
  top:0;
  z-index:50;
}
.header::after{
  content:'';
  position:absolute;
  bottom:-1px;left:0;right:0;
  height:2px;
  background:linear-gradient(90deg,transparent 0%,var(--accent) 20%,var(--purple) 50%,var(--accent) 80%,transparent 100%);
  background-size:200% 100%;
  animation:headerGlow 4s ease-in-out infinite;
  opacity:0.6;
}
@keyframes headerGlow{
  0%,100%{background-position:0% 50%}
  50%{background-position:100% 50%}
}
.header-title{
  display:flex;
  align-items:center;
  gap:10px;
  font-size:18px;
  font-weight:800;
  letter-spacing:-0.4px;
}
.header-title span{
  background:linear-gradient(135deg,var(--accent),var(--purple));
  background-size:200% 200%;
  animation:bgShift 6s ease infinite;
  -webkit-background-clip:text;
  -webkit-text-fill-color:transparent;
  background-clip:text;
}

/* ── Hamburger ── */
.hamburger{
  background:none;border:none;color:var(--text);
  font-size:22px;cursor:pointer;padding:10px 14px;
  border-radius:14px;
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);
  -webkit-tap-highlight-color:transparent;
}
.hamburger:active{background:rgba(255,255,255,0.06);transform:scale(0.9)}

/* ── Menu Overlay ── */
.menu-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;
  background:rgba(0,0,0,0.7);
  backdrop-filter:blur(6px);
  -webkit-backdrop-filter:blur(6px);
  z-index:99;opacity:0;pointer-events:none;
  transition:opacity 0.35s;
}
.menu-overlay.active{opacity:1;pointer-events:auto}

/* ── Sidebar ── */
.sidebar{
  position:fixed;top:0;right:-300px;width:290px;height:100%;
  background:rgba(8,12,24,0.96);
  backdrop-filter:blur(40px) saturate(1.3);
  -webkit-backdrop-filter:blur(40px) saturate(1.3);
  z-index:100;
  transition:right 0.4s cubic-bezier(0.16,1,0.3,1);
  padding:28px 16px;
  overflow-y:auto;
  border-left:1px solid rgba(255,255,255,0.04);
  box-shadow:-10px 0 60px rgba(0,0,0,0.6);
}
.sidebar.active{right:0}
.menu-item{
  display:flex;align-items:center;gap:14px;
  padding:14px 18px;border-radius:14px;cursor:pointer;
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);
  color:var(--dim);font-size:14px;font-weight:500;
  margin-bottom:4px;
  -webkit-tap-highlight-color:transparent;
  border:1px solid transparent;
}
.menu-item:active{background:rgba(0,240,200,0.06);transform:scale(0.98)}
.menu-item.active{
  background:linear-gradient(135deg,rgba(0,240,200,0.1),rgba(139,92,246,0.06));
  border-color:rgba(0,240,200,0.15);
  color:var(--accent);
  font-weight:700;
  box-shadow:0 0 24px rgba(0,240,200,0.06),inset 0 0 20px rgba(0,240,200,0.03);
}

/* ── Pages ── */
.page{display:none;padding:18px 16px;animation:slideUp 0.45s cubic-bezier(0.16,1,0.3,1)}
.page.active{display:block}
@keyframes slideUp{from{opacity:0;transform:translateY(20px) scale(0.99)}to{opacity:1;transform:translateY(0) scale(1)}}

/* ── Cards – Glassmorphism ── */
.card{
  background:rgba(11,16,32,0.72);
  backdrop-filter:blur(24px) saturate(1.2);
  -webkit-backdrop-filter:blur(24px) saturate(1.2);
  border:1px solid rgba(255,255,255,0.05);
  border-radius:22px;
  padding:24px;
  margin-bottom:16px;
  box-shadow:
    0 8px 40px rgba(0,0,0,0.35),
    0 0 0 1px rgba(255,255,255,0.02) inset,
    0 1px 0 rgba(255,255,255,0.04) inset;
  position:relative;
  overflow:hidden;
  transition:all 0.3s;
}
.card::before{
  content:'';
  position:absolute;
  top:0;left:0;right:0;
  height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent);
}
.card::after{
  content:'';
  position:absolute;
  top:0;left:0;right:0;bottom:0;
  border-radius:22px;
  background:linear-gradient(135deg,rgba(0,240,200,0.02),transparent 40%,rgba(139,92,246,0.02));
  pointer-events:none;
}

.card-header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.card-icon{
  width:50px;height:50px;
  background:linear-gradient(135deg,var(--accent),var(--purple));
  border-radius:15px;
  display:flex;align-items:center;justify-content:center;
  font-size:24px;
  box-shadow:
    0 4px 20px rgba(0,240,200,0.25),
    0 0 40px rgba(0,240,200,0.08),
    inset 0 1px 0 rgba(255,255,255,0.15);
  transition:all 0.35s cubic-bezier(0.4,0,0.2,1);
  position:relative;
  z-index:1;
}
.card-icon:hover{
  transform:scale(1.08) rotate(-2deg);
  box-shadow:
    0 6px 28px rgba(0,240,200,0.35),
    0 0 50px rgba(0,240,200,0.12);
}
.card-title{font-size:18px;font-weight:800;letter-spacing:-0.3px;color:var(--text-bright);position:relative;z-index:1}
.card-subtitle{font-size:12px;color:var(--dim);margin-top:3px;font-weight:400;position:relative;z-index:1}

/* ── Section Titles ── */
.section-title{
  font-size:11px;
  font-weight:700;
  margin-bottom:12px;
  color:var(--accent);
  text-transform:uppercase;
  letter-spacing:1px;
  display:flex;
  align-items:center;
  gap:8px;
  position:relative;
  z-index:1;
}
.section-title::before{
  content:'';
  width:3px;height:14px;
  background:linear-gradient(180deg,var(--accent),var(--purple));
  border-radius:2px;
  flex-shrink:0;
}

/* ── Inputs ── */
.scan-input{display:flex;gap:8px;margin-bottom:14px}
.scan-input input{
  flex:1;
  background:rgba(0,0,0,0.35);
  border:1px solid rgba(255,255,255,0.06);
  border-radius:14px;
  padding:13px 18px;
  color:var(--text);
  font-size:14px;
  direction:ltr;
  font-family:'JetBrains Mono','Fira Code',monospace;
  width:100%;
  transition:all 0.35s cubic-bezier(0.4,0,0.2,1);
  outline:none;
  position:relative;
  z-index:1;
}
.scan-input input::placeholder{
  color:rgba(90,101,119,0.7);
  font-family:'Inter','Segoe UI',Tahoma,sans-serif;
  direction:rtl;
  font-size:13px;
}
.scan-input input:focus{
  border-color:rgba(0,240,200,0.45);
  box-shadow:
    0 0 0 4px rgba(0,240,200,0.08),
    0 0 24px rgba(0,240,200,0.06),
    inset 0 0 12px rgba(0,240,200,0.03);
  background:rgba(0,0,0,0.45);
}

/* ── Buttons ── */
.btn{
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  color:#000;border:none;border-radius:14px;
  padding:13px 22px;font-size:14px;font-weight:800;
  cursor:pointer;width:100%;
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);
  box-shadow:
    0 4px 20px rgba(0,240,200,0.2),
    0 0 0 1px rgba(0,240,200,0.1) inset;
  position:relative;
  overflow:hidden;
  z-index:1;
  letter-spacing:-0.1px;
}
.btn::before{
  content:'';
  position:absolute;
  top:0;left:-120%;width:100%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);
  transition:left 0.6s;
}
.btn:hover::before{left:120%}
.btn:hover{
  box-shadow:
    0 6px 30px rgba(0,240,200,0.3),
    0 0 50px rgba(0,240,200,0.1),
    0 0 0 1px rgba(0,240,200,0.15) inset;
  transform:translateY(-2px);
}
.btn:active{
  transform:translateY(0) scale(0.98);
  box-shadow:0 2px 10px rgba(0,240,200,0.15);
}
.btn:disabled{
  opacity:0.35;cursor:not-allowed;
  transform:none;box-shadow:none;
}
.btn:disabled::before{display:none}

/* ── Result boxes ── */
.result-box{
  background:rgba(0,0,0,0.3);
  border:1px solid rgba(255,255,255,0.05);
  border-radius:14px;padding:16px;
  font-family:'JetBrains Mono','Fira Code',monospace;
  font-size:13px;min-height:50px;
  transition:all 0.3s;
  position:relative;z-index:1;
}
.result-box:hover{
  border-color:rgba(255,255,255,0.1);
  box-shadow:0 0 20px rgba(0,0,0,0.2);
}

/* ── Scan Rows ── */
.scan-row{
  display:flex;justify-content:space-between;
  padding:9px 0;
  border-bottom:1px solid rgba(255,255,255,0.035);
  font-size:13px;
  transition:background 0.2s;
}
.scan-row:last-child{border:none}
.scan-row:hover{background:rgba(255,255,255,0.015);border-radius:8px;margin:0 -6px;padding:9px 6px}
.scan-label{color:var(--dim);font-weight:500}
.scan-value{font-family:'JetBrains Mono','Fira Code',monospace;color:var(--accent);font-weight:600}
.scan-result{
  background:rgba(0,0,0,0.25);
  border:1px solid rgba(255,255,255,0.05);
  border-radius:14px;padding:14px;
  position:relative;z-index:1;
}

/* ── Panel Cards (cf-item) ── */
.cf-item{
  display:flex;justify-content:space-between;align-items:center;
  background:rgba(0,0,0,0.2);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  border:1px solid rgba(255,255,255,0.05);
  border-radius:18px;
  padding:16px 18px;
  transition:all 0.35s cubic-bezier(0.4,0,0.2,1);
  position:relative;
  overflow:hidden;
  cursor:pointer;
  z-index:1;
}
.cf-item::before{
  content:'';
  position:absolute;
  right:0;top:14px;bottom:14px;
  width:3px;border-radius:0 3px 3px 0;
  opacity:0.8;
  transition:all 0.3s;
}
.cf-item[data-panel="edtunnel"]::before{background:linear-gradient(180deg,#ff6b6b,#ee5a24);box-shadow:0 0 10px rgba(255,107,107,0.3)}
        </div>
        <div class="cf-item" style="cursor:pointer" data-panel="nahan">
          <div style="display:flex;align-items:center;gap:14px">
            <div class="panel-icon" style="background:linear-gradient(135deg,#00b894,#00cec9)">🟢</div>
            <div><div style="font-weight:800;font-size:15px;color:var(--text-bright);margin-bottom:2px">Nahan Panel</div><div style="font-size:11px;color:var(--dim);font-weight:500">⭐ 60+ — VLESS / Reality</div></div>
          </div>
          <div class="cf-status" style="background:rgba(0,184,148,0.08);color:#00b894;border-color:rgba(0,184,148,0.15)">سریع</div>
        </div>
        <div class="cf-item" style="cursor:pointer" data-panel="cfnew">
          <div style="display:flex;align-items:center;gap:14px">
            <div class="panel-icon" style="background:linear-gradient(135deg,#6c5ce7,#a29bfe)">🟣</div>
            <div><div style="font-weight:800;font-size:15px;color:var(--text-bright);margin-bottom:2px">Cfnew Panel</div><div style="font-size:11px;color:var(--dim);font-weight:500">⭐ 14.6k — GrainTCP</div></div>
          </div>
          <div class="cf-status" style="background:rgba(108,92,231,0.08);color:#8b5cf6;border-color:rgba(108,92,231,0.15)">کم پینگ</div>
        </div>
      </div>
    </div>
    <div id="wizardConfig" style="display:none">
      <div class="section-title">تنظیمات نصب</div>
      <div class="scan-input" style="margin-bottom:12px">
        <input type="text" id="panelName" placeholder="نام ورکر (خودکار ساخته میشه)">
      </div>
      <button class="btn" id="deployBtn" onclick="deployPanel()" style="box-shadow:0 6px 30px rgba(0,240,200,0.25)">🚀 نصب و فعال‌سازی</button>
      <div id="deployProgress"></div>
      <div id="deployResult" style="display:none">
        <div style="font-size:14px;color:var(--accent);margin-bottom:10px;font-weight:700">✅ پنل با موفقیت نصب شد!</div>
        <div class="scan-result">
          <div class="scan-row"><div class="scan-label">نام ورکر</div><div class="scan-value" id="res-name">-</div></div>
          <div class="scan-row"><div class="scan-label">نوع پنل</div><div class="scan-value" id="res-panel">-</div></div>
          <div class="scan-row"><div class="scan-label">لینک</div><div class="scan-value" id="res-url" style="font-size:11px;word-break:break-all">-</div></div>
        </div>
      </div>
    </div>
  </div>
</div>

<a class="telegram-float" href="https://t.me/Arshia_Kennedy" target="_blank">✈️</a>

<script>
(function(){
  var currentPassword='',count=0,scanning=false,validatedToken='',validatedAccountId='',validatedEmail='',selectedPanel='';

  function $(id){return document.getElementById(id)}

  // Menu
  $('hamburgerBtn').addEventListener('click',function(){ $('menuOverlay').classList.add('active'); $('sidebar').classList.add('active'); });
  $('menuOverlay').addEventListener('click',function(){ $('menuOverlay').classList.remove('active'); $('sidebar').classList.remove('active'); });
  
  document.querySelectorAll('.menu-item').forEach(function(item){
    item.addEventListener('click',function(){
      var page=item.getAttribute('data-page');
      document.querySelectorAll('.menu-item').forEach(function(m){m.classList.remove('active')});
      item.classList.add('active');
      document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});
      var pageEl=document.getElementById('page-'+page);
      if(pageEl)pageEl.classList.add('active');
      $('menuOverlay').classList.remove('active');
      $('sidebar').classList.remove('active');
    });
  });

  // Panel select
  document.querySelectorAll('#panelList .cf-item').forEach(function(item){
    item.addEventListener('click',function(){
      selectedPanel=item.getAttribute('data-panel');
      document.querySelectorAll('#panelList .cf-item').forEach(function(i){i.style.borderColor='var(--border)';i.style.background=''});
      item.style.borderColor='var(--accent)';item.style.background='rgba(0,212,170,.05)';
      $('wizardConfig').style.display='block';
      $('panelName').value=selectedPanel+'-'+Math.random().toString(36).substr(2,8);
    });
  });

  // Password
  window.generate=function(){
    var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    currentPassword='';for(var i=0;i<32;i++)currentPassword+=chars.charAt(Math.floor(Math.random()*chars.length));
    count++;$('passwordBox').textContent=currentPassword;
  };
  window.copyPassword=function(){
    if(!currentPassword){showToast('⚠️ اول رمز تولید کنید');return}
    navigator.clipboard.writeText(currentPassword).then(function(){showToast('✅ رمز کپی شد!')}).catch(function(){showToast('❌ خطا در کپی')});
  };
  generate();

  // IP Scan
  window.scanIP=async function(){
    var ip=$('ipInput').value.trim();if(!ip){showToast('⚠️ IP یا Domain وارد کنید');return}
    $('ipBtn').textContent='⏳ در حال اسکن...';$('ipBtn').disabled=true;
    try{
      var r=await fetch('https://ipwho.is/'+ip);var d=await r.json();
      if(!d.success){showToast('❌ IP نامعتبر');$('ipBtn').textContent='🔍 اسکن';$('ipBtn').disabled=false;return}
      var html='<div class="scan-result"><div class="scan-row"><div class="scan-label">IP</div><div class="scan-value">'+d.ip+'</div></div>';
      if(d.city)html+='<div class="scan-row"><div class="scan-label">شهر</div><div class="scan-value">'+d.city+'</div></div>';
      if(d.country)html+='<div class="scan-row"><div class="scan-label">کشور</div><div class="scan-value">'+d.country+'</div></div>';
      if(d.org)html+='<div class="scan-row"><div class="scan-label">سازمان</div><div class="scan-value" style="font-size:10px">'+d.org+'</div></div>';
      if(d.asn)html+='<div class="scan-row"><div class="scan-label">ASN</div><div class="scan-value">'+d.asn+'</div></div>';
      html+='</div>';$('ipResults').innerHTML=html;
    }catch(e){showToast('❌ خطا: '+e.message)}
    $('ipBtn').textContent='🔍 اسکن';$('ipBtn').disabled=false;
  };

  // CF Scan
  window.scanCF=async function(){
    if(scanning)return;scanning=true;$('cfScanBtn').textContent='⏳ اسکن در حال انجام...';$('cfScanBtn').disabled=true;$('cfResults').innerHTML='';
    try{
      var r=await fetch('/api/scan-cf');var d=await r.json();
      var html='<div class="scan-result">';
      if(d.ips&&d.ips.length>0){
        d.ips.forEach(function(item,i){
          var color=item.ping<200?'var(--green)':item.ping<500?'var(--accent)':'var(--error)';
          html+='<div class="scan-row"><div class="scan-label">'+(i+1)+'. '+item.ip+'</div><div class="scan-value" style="color:'+color+'">'+item.ping+'ms</div></div>';
        });
      }else html+='<div style="text-align:center;padding:20px;color:var(--dim)">خطا در اسکن</div>';
      html+='</div>';$('cfResults').innerHTML=html;
    }catch(e){showToast('❌ خطا در اسکن')}
    $('cfScanBtn').textContent='🔄 اسکن مجدد';$('cfScanBtn').disabled=false;scanning=false;showToast('✅ اسکن کامل شد!');
  };

  // Wizard - Create API Token from Global Key
  window.createToken=function(){
    var url='https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22page%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Wizard-Token';
    window.open(url,'_blank');
    showToast('🔑 صفحه ساخت توکن باز شد!');
  };

  // Wizard - Validate Token (server-side)
  window.validateToken=async function(){
    var token=$('cfToken').value.trim();
    var email=$('cfEmail').value.trim();
    if(!token){showToast('⚠️ توکن یا کلید را وارد کنید');return}
    $('validateBtn').textContent='⏳ در حال بررسی...';$('validateBtn').disabled=true;
    try{
      var body={token:token};
      if(email)body.email=email;
      var r=await fetch('/api/wizard/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      var d=await r.json();
      if(!d.success){showToast('❌ '+d.error);$('validateBtn').textContent='🔍 بررسی اعتبار';$('validateBtn').disabled=false;return}
      validatedToken=token;validatedAccountId=d.accountId;validatedEmail=email;
      $('accName').textContent=d.accountName;$('accId').textContent=d.accountId;
      $('accountInfo').style.display='block';$('panelSelect').style.display='block';
      $('validateBtn').textContent='✅ معتبر';
      showToast('✅ توکن معتبر!');
    }catch(e){showToast('❌ خطا: '+e.message);$('validateBtn').textContent='🔍 بررسی اعتبار';$('validateBtn').disabled=false}
  };

  // Wizard - Deploy (server-side)
  window.deployPanel=async function(){
    if(!validatedToken||!validatedAccountId){showToast('⚠️ اول توکن را بررسی کنید');return}
    if(!selectedPanel){showToast('⚠️ نوع پنل را انتخاب کنید');return}
    var workerName=$('panelName').value.trim();
    if(!workerName){showToast('⚠️ نام ورکر را وارد کنید');return}
    
    $('deployBtn').textContent='⏳ در حال نصب...';$('deployBtn').disabled=true;
    $('deployProgress').style.display='block';$('deployResult').style.display='none';
    
    try{
      var body={token:validatedToken,accountId:validatedAccountId,panelType:selectedPanel,workerName:workerName};
      if(validatedEmail)body.email=validatedEmail;
      var r=await fetch('/api/wizard/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      var d=await r.json();
      
      if(d.logs){$('deployProgress').innerHTML=d.logs.map(function(l){return l}).join('<br>');$('deployProgress').scrollTop=$('deployProgress').scrollHeight}
      
      if(d.success){
        $('res-url').textContent=d.panelURL;$('res-name').textContent=d.workerName;$('res-panel').textContent=d.panelType;
        $('deployResult').style.display='block';
        $('deployBtn').textContent='✅ نصب کامل شد';
        showToast('✅ پنل نصب شد!');
      }else{
        showToast('❌ خطا در نصب');
        $('deployBtn').textContent='🚀 نصب مجدد';
      }
    }catch(e){showToast('❌ خطا: '+e.message)}
    $('deployBtn').disabled=false;
  };

  function showToast(msg){var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove()},3000)}
})();
</script>
</body></html>`;
}