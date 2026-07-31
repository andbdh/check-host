// Check Host v3 - Wizard via server-side API + Cfnew fix
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
    
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
    
    // Wizard API routes - server-side to avoid CORS
    if (url.pathname === '/api/wizard/validate' && request.method === 'POST') {
      try {
        const { token, email } = await request.json();
        if (!token) return Response.json({ success: false, error: 'Token required' }, { headers: cors });
        
        // Build auth headers (support both API Token and Global Key)
        function authH(ct) {
          const base = ct ? {'Content-Type': ct} : {};
          return email 
            ? Object.assign({'X-Auth-Email': email, 'X-Auth-Key': token}, base)
            : Object.assign({'Authorization': 'Bearer ' + token}, base);
        }
        
        const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
          headers: authH()
        });
        const d = await r.json();
        if (!d.success) {
          // For Global Key, try accounts endpoint directly
          if (email) {
            const r2 = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: authH() });
            const d2 = await r2.json();
            if (!d2.success || !d2.result.length) return Response.json({ success: false, error: 'Invalid key or email' }, { headers: cors });
            return Response.json({ 
              success: true, 
              accountName: d2.result[0].name, 
              accountId: d2.result[0].id,
              email: email
            }, { headers: cors });
          }
          return Response.json({ success: false, error: 'Invalid token' }, { headers: cors });
        }
        
        // Get account info
        const r2 = await fetch('https://api.cloudflare.com/client/v4/accounts', {
          headers: authH()
        });
        const d2 = await r2.json();
        if (!d2.success || !d2.result.length) return Response.json({ success: false, error: 'No accounts found' }, { headers: cors });
        
        return Response.json({ 
          success: true, 
          accountId: d2.result[0].id, 
          accountName: d2.result[0].name 
        }, { headers: cors });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { headers: cors });
      }
    }
    
    if (url.pathname === '/api/wizard/deploy' && request.method === 'POST') {
      try {
        const { token, accountId, panelType, workerName, email } = await request.json();
        if (!token || !accountId || !panelType || !workerName) {
          return Response.json({ success: false, error: 'Missing parameters' }, { headers: cors });
        }
        
        const logs = [];
        function addLog(msg) { logs.push(msg); }
        
        // Build auth headers (support both API Token and Global Key)
        function authH(ct) {
          const base = ct ? {'Content-Type': ct} : {};
          return email 
            ? Object.assign({'X-Auth-Email': email, 'X-Auth-Key': token}, base)
            : Object.assign({'Authorization': 'Bearer ' + token}, base);
        }
        
        addLog('🔄 Starting deployment...');
        
        // Step 1: Create KV or D1 based on panel type
        let kvId = null;
        let d1Id = null;
        
        if (panelType === 'edtunnel' || panelType === 'cfnew') {
          addLog('📦 Creating KV namespace...');
          const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
            method: 'POST',
            headers: authH('application/json'),
            body: JSON.stringify({ title: workerName + '-kv-' + Date.now() })
          });
          const d = await r.json();
          if (d.success) {
            kvId = d.result.id;
            addLog('✅ KV created: ' + kvId);
          } else {
            addLog('❌ KV error: ' + (d.errors?.[0]?.message || 'Unknown'));
            return Response.json({ success: false, logs, error: 'KV creation failed' }, { headers: cors });
          }
        }
        
        if (panelType === 'nahan') {
          addLog('🗄️ Creating D1 database...');
          const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
            method: 'POST',
            headers: authH('application/json'),
            body: JSON.stringify({ name: workerName + '-db' })
          });
          const d = await r.json();
          if (d.success) {
            d1Id = d.result.uuid;
            addLog('✅ D1 created: ' + d1Id);
          } else {
            addLog('❌ D1 error: ' + (d.errors?.[0]?.message || 'Unknown'));
            return Response.json({ success: false, logs, error: 'D1 creation failed' }, { headers: cors });
          }
        }
        
        // Step 2: Download source code
        addLog('📥 Downloading source...');
        let workerSource = '';
        try {
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
          }
        } catch (e) {
          addLog('❌ Download failed: ' + e.message);
          return Response.json({ success: false, logs, error: 'Download failed' }, { headers: cors });
        }
        
        // Step 3: Deploy worker
        addLog('📤 Deploying worker...');
        
        // For Cfnew, we need to write the UUID to KV variable 'u'
        if (panelType === 'cfnew' && kvId) {
          const cfnewUuid = crypto.randomUUID();
          addLog('🔑 Generating Cfnew UUID: ' + cfnewUuid);
          
          // Write UUID to KV with key 'u'
          const rKV = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/u`, {
            method: 'PUT',
            headers: authH(),
            body: cfnewUuid
          });
          const dKV = await rKV.json();
          if (dKV.success) {
            addLog('✅ KV variable "u" set with UUID');
          } else {
            addLog('⚠️ KV write failed: ' + (dKV.errors?.[0]?.message || 'Unknown'));
          }
        }
        
        // For BPB, we need to write some initial config to KV
        if (panelType === 'edtunnel' && kvId) {
          addLog('📝 Setting up BPB KV config...');
          // BPB expects certain KV keys, write empty config
          const rKV = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/settings`, {
            method: 'PUT',
            headers: authH(),
            body: JSON.stringify({ mode: 'no_usage' })
          });
          addLog('✅ BPB KV initialized');
        }
        
        // Build bindings
        let bindings = [];
        if (kvId) bindings.push({ type: 'kv_namespace', name: 'KV', namespace_id: kvId });
        if (d1Id) bindings.push({ type: 'd1', name: 'IOT_DB', database_id: d1Id });
        
        // For Cfnew, the binding name should be 'u' with UUID value in KV
        // Actually Cfnew reads from KV variable 'u' - we already wrote the UUID above
        // But the binding itself should still be named 'KV' and Cfnew reads key 'u' from it
        
        const metadata = {
          main_module: 'index.js',
          bindings: bindings,
          compatibility_date: '2024-01-01',
          compatibility_flags: ['nodejs_compat']
        };
        
        const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
        const bodyParts = [];
        bodyParts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(metadata));
        bodyParts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n' + workerSource);
        bodyParts.push('--' + boundary + '--');
        
        const body = bodyParts.join('\r\n');
        
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, {
          method: 'PUT',
          headers: authH('multipart/form-data; boundary=' + boundary),
          body: body
        });
        const d = await r.json();
        
        if (!d.success) {
          addLog('❌ Deploy error: ' + (d.errors?.[0]?.message || 'Unknown'));
          return Response.json({ success: false, logs, error: 'Deploy failed' }, { headers: cors });
        }
        addLog('✅ Worker deployed!');
        
        // Step 4: Enable subdomain
        addLog('🌐 Enabling subdomain...');
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
          method: 'POST',
          headers: authH('application/json'),
          body: JSON.stringify({ enabled: true })
        });
        
        // Get the account subdomain
        const rSub = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
          headers: authH()
        });
        const dSub = await rSub.json();
        const subdomain = dSub.result?.subdomain || accountId.substr(0, 8);
        
        const panelURL = `https://${workerName}.${subdomain}.workers.dev`;
        addLog('✅ Panel is live!');
        addLog('🔗 ' + panelURL);
        
        return Response.json({ 
          success: true, 
          logs, 
          panelURL, 
          workerName, 
          panelType: panelType.toUpperCase() 
        }, { headers: cors });
        
      } catch (e) {
        return Response.json({ success: false, logs: ['❌ Error: ' + e.message], error: e.message }, { headers: cors });
      }
    }
    
    return new Response(UI, { headers: { 'Content-Type': 'text/html;charset=utf-8', ...cors } });
  }
};

function generatePassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const all = upper + lower + numbers + symbols;
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  let pwd = upper[array[0] % upper.length] + lower[array[1] % lower.length] + numbers[array[2] % numbers.length] + symbols[array[3] % symbols.length];
  for (let i = 4; i < 32; i++) pwd += all[array[i] % all.length];
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

async function scanCloudflareIPs() {
  const ranges = [
    {prefix:'103.21.247',bits:24},{prefix:'103.21.246',bits:24},{prefix:'104.23.0',bits:19},
    {prefix:'104.22.240',bits:20},{prefix:'141.101.89',bits:24},{prefix:'141.101.88',bits:24},
    {prefix:'172.70.0',bits:19},{prefix:'172.69.24',bits:21},{prefix:'198.41.144',bits:22},
    {prefix:'172.70.64',bits:21},{prefix:'198.41.243',bits:24},{prefix:'198.41.148',bits:24},
    {prefix:'198.41.246',bits:23},{prefix:'198.41.245',bits:24},{prefix:'198.41.249',bits:24},
    {prefix:'198.41.248',bits:24},{prefix:'198.41.251',bits:24},{prefix:'198.41.250',bits:24},
    {prefix:'198.41.255',bits:24}
  ];
  const sampleIPs = [];
  const ipsPerRange = Math.ceil(60 / ranges.length);
  for (const range of ranges) {
    for (let i = 0; i < ipsPerRange; i++) {
      sampleIPs.push(range.prefix + '.' + (Math.floor(Math.random() * 254) + 1));
    }
  }
  sampleIPs.sort(() => Math.random() - 0.5);
  const toScan = sampleIPs.slice(0, 60);
  const results = [];
  for (const ip of toScan) {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const r = await fetch('https://' + ip + '/', { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      results.push({ ip, status: r.status < 500 ? 'working' : 'error', latency: Date.now() - start, type: 'CF Edge' });
    } catch (e) {
      results.push({ ip, status: 'timeout', latency: 0, type: 'CF Edge' });
    }
  }
  return { results, total: results.length, working: results.filter(r => r.status === 'working').length };
}

const UI = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check Host</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#08080f;--bg2:#0d0d1a;--card:rgba(16,16,30,0.85);--card2:rgba(20,20,35,0.9);--accent:#00e5c3;--accent2:#00ffd5;--text:#e2e8f0;--text-bright:#f8fafc;--dim:#64748b;--border:rgba(255,255,255,0.06);--success:#00e5c3;--danger:#f43f5e;--purple:#a78bfa;--blue:#3b82f6;--orange:#f59e0b;--glow:rgba(0,229,195,0.15);--glow2:rgba(0,229,195,0.08)}
body{font-family:'Inter','Segoe UI',Tahoma,sans-serif;background:var(--bg);background-image:radial-gradient(ellipse at 20% 0%,rgba(0,229,195,0.06) 0%,transparent 50%),radial-gradient(ellipse at 80% 100%,rgba(167,139,250,0.04) 0%,transparent 50%);background-attachment:fixed;color:var(--text);min-height:100vh;overflow-x:hidden}
::selection{background:var(--accent);color:#000}
.header{background:rgba(8,8,15,0.9);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.header::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),var(--purple),var(--accent),transparent);animation:headerGlow 4s ease infinite}
@keyframes headerGlow{0%,100%{opacity:0.5}50%{opacity:1}}
.logo{font-size:20px;font-weight:800;letter-spacing:-0.5px}
.logo span{color:var(--accent)}
.header-icons{display:flex;gap:10px}
.header-icon{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--card);border:1px solid var(--border);cursor:pointer;transition:all 0.3s;font-size:18px}
.header-icon:hover{background:var(--glow);border-color:var(--accent);transform:scale(1.05)}
.card{background:var(--card);backdrop-filter:blur(16px);border:1px solid var(--border);border-radius:20px;padding:20px;margin-bottom:16px;position:relative;overflow:hidden;transition:all 0.3s}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent)}
.card:hover{border-color:rgba(0,229,195,0.15);box-shadow:0 8px 32px rgba(0,229,195,0.08)}
.card-header{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.card-icon{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--accent),var(--accent2));font-size:22px;box-shadow:0 4px 20px rgba(0,229,195,0.3)}
.card-title{font-size:17px;font-weight:700;color:var(--text-bright)}
.card-subtitle{font-size:12px;color:var(--dim);margin-top:2px}
.btn{background:var(--gradient);color:#000;border:none;border-radius:14px;padding:14px 24px;font-size:14px;font-weight:700;cursor:pointer;width:100%;transition:all 0.3s;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 20px rgba(0,229,195,0.25)}
.btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,229,195,0.35)}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
.input{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:14px;padding:14px 16px;color:var(--text);font-size:14px;width:100%;transition:all 0.3s;outline:none}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--glow2),0 0 20px var(--glow2)}
.input::placeholder{color:var(--dim)}
.pwd-box{background:rgba(0,229,195,0.05);border:1px solid rgba(0,229,195,0.15);border-radius:14px;padding:16px;font-family:'Courier New',monospace;font-size:13px;color:var(--accent);word-break:break-all;min-height:60px;display:flex;align-items:center;justify-content:center;text-align:center;transition:all 0.3s}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.stat{background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:12px;padding:12px 8px;text-align:center}
.stat-value{font-size:20px;font-weight:800;color:var(--accent)}
.stat-label{font-size:10px;color:var(--dim);margin-top:4px}
.section-title{font-size:13px;font-weight:600;color:var(--dim);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.section-title::after{content:'';flex:1;height:1px;background:var(--border)}
.scan-result{background:rgba(0,229,195,0.03);border:1px solid rgba(0,229,195,0.1);border-radius:14px;padding:16px;margin-top:12px}
.scan-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)}
.scan-row:last-child{border:none}
.scan-label{font-size:12px;color:var(--dim)}
.scan-value{font-size:13px;font-weight:600;color:var(--text-bright)}
.cf-item{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;cursor:pointer;transition:all 0.3s;display:flex;justify-content:space-between;align-items:center}
.cf-item:hover{border-color:var(--accent);background:var(--glow2)}
.cf-item.active{border-color:var(--accent);box-shadow:0 0 20px var(--glow)}
.panel-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px}
.deploy-log{background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:14px;padding:16px;font-family:'Courier New',monospace;font-size:12px;max-height:300px;overflow-y:auto;line-height:1.8}
.toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:12px 24px;font-size:13px;color:var(--text);z-index:1000;backdrop-filter:blur(10px);transition:all 0.3s;opacity:0;box-shadow:0 8px 32px rgba(0,0,0,0.3)}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.sidebar{position:fixed;top:0;right:-280px;width:280px;height:100vh;background:rgba(8,8,15,0.95);backdrop-filter:blur(20px);border-left:1px solid var(--border);z-index:200;transition:right 0.3s;padding:20px}
.sidebar.active{right:0}
.sidebar-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:199;opacity:0;pointer-events:none;transition:opacity 0.3s}
.sidebar-overlay.active{opacity:1;pointer-events:auto}
.menu-item{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;cursor:pointer;transition:all 0.3s;margin-bottom:4px;font-size:14px}
.menu-item:hover,.menu-item.active{background:var(--glow);color:var(--accent)}
.telegram-float{position:fixed;bottom:24px;left:24px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border-radius:14px;padding:12px 20px;font-size:13px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(59,130,246,0.4);transition:all 0.3s;z-index:50}
.telegram-float:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(59,130,246,0.5)}
.cf-status{font-size:11px;padding:4px 10px;border-radius:8px;border:1px solid var(--border)}
@media(max-width:480px){.header{padding:12px 16px}.logo{font-size:18px}.card{padding:16px;border-radius:16px}.stats{grid-template-columns:repeat(3,1fr);gap:6px}}</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="menu-overlay" id="menuOverlay"></div>
<div class="sidebar" id="sidebar">
  <div class="menu-header">
    <div class="menu-logo">
      <div class="menu-logo-icon">⚡</div>
      <div class="menu-logo-text">Check Host</div>
    </div>
    <button class="close-btn" id="closeBtn">✕</button>
  </div>
  <div class="menu-section">ابزارها</div>
  <div class="menu-item active" id="nav-passgen" data-page="passgen">
    <div class="menu-icon">🔐</div>
    <div><div class="menu-label">Password Generator</div><div class="menu-desc">ساخت رمز ۳۲ کاراکتری قوی</div></div>
  </div>
  <div class="menu-item" id="nav-ipscan" data-page="ipscan">
    <div class="menu-icon">🌍</div>
    <div><div class="menu-label">IP Scanner</div><div class="menu-desc">بررسی اطلاعات IP آنلاین</div></div>
  </div>
  <div class="menu-item" id="nav-cfscan" data-page="cfscan">
    <div class="menu-icon">☁️</div>
    <div><div class="menu-label">Cloudflare Scanner</div><div class="menu-desc">اسکن آیپی‌های Cloudflare</div></div>
  </div>
  <div class="menu-section">ابزارهای پیشرفته</div>
  <div class="menu-item" id="nav-wizard" data-page="wizard">
    <div class="menu-icon">🧙</div>
    <div><div class="menu-label">Wizard</div><div class="menu-desc">نصب خودکار پنل‌ها</div></div>
  </div>
  <div class="menu-section">لینک‌ها</div>
  <a class="menu-item" href="https://t.me/Arshia_Kennedy" target="_blank" rel="noopener">
    <div class="menu-icon">📬</div>
    <div><div class="menu-label">تلگرام</div><div class="menu-desc">پشتیبانی و آپدیت</div></div>
  </a>
  <div class="menu-footer">Made with ❤️ by Arshia</div>
</div>
<div class="header">
  <button class="hamburger" id="hamburgerBtn">☰</button>
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div class="logo-text">Check<span>Host</span></div>
  </div>
</div>

<div class="page active" id="page-passgen">
  <div class="card">
    <div class="card-header">
      <div class="card-icon">🔐</div>
      <div><div class="card-title">Password Generator</div><div class="card-subtitle">رمز عبور ۳۲ کاراکتری قوی و یکتا</div></div>
    </div>
    <div class="pwd-container" id="pwdContainer">
      <div class="pwd-row">
        <div class="pwd-box" id="password">در حال ساختن...</div>
        <button class="copy-btn" id="copyBtn">📋</button>
      </div>
    </div>
    <button class="btn" id="generateBtn">🔄 ساختن رمز جدید</button>
    <div class="stats">
      <div class="stat"><div class="stat-num" id="count">0</div><div class="stat-label">ساخته شده</div></div>
      <div class="stat"><div class="stat-num">32</div><div class="stat-label">کاراکتر</div></div>
      <div class="stat"><div class="stat-num">∞</div><div class="stat-label">بدون تکرار</div></div>
    </div>
  </div>
</div>

<div class="page" id="page-ipscan">
  <div class="my-ip-box">
    <div class="my-ip-label">آیپی شما</div>
    <div class="my-ip" id="myIp">در حال دریافت...</div>
  </div>
  <div class="card">
    <div class="card-header">
      <div class="card-icon">🌍</div>
      <div><div class="card-title">IP Scanner</div><div class="card-subtitle">بررسی اطلاعات هر آیپی</div></div>
    </div>
    <div class="scan-input">
      <input type="text" id="ipInput" placeholder="مثلاً 8.8.8.8">
      <button class="scan-btn" id="scanIpBtn">🔍 اسکن</button>
    </div>
    <div class="scan-result" id="scanResult" style="display:none">
      <div class="scan-row"><div class="scan-label">IP</div><div class="scan-value" id="res-ip">-</div></div>
      <div class="scan-row"><div class="scan-label">شهر</div><div class="scan-value" id="res-city">-</div></div>
      <div class="scan-row"><div class="scan-label">استان</div><div class="scan-value" id="res-region">-</div></div>
      <div class="scan-row"><div class="scan-label">کشور</div><div class="scan-value" id="res-country">-</div></div>
      <div class="scan-row"><div class="scan-label">موقعیت</div><div class="scan-value" id="res-loc">-</div></div>
      <div class="scan-row"><div class="scan-label">ISP</div><div class="scan-value" id="res-org">-</div></div>
      <div class="scan-row"><div class="scan-label">منطقه زمانی</div><div class="scan-value" id="res-timezone">-</div></div>
      <div class="scan-row"><div class="scan-label">کد پستی</div><div class="scan-value" id="res-postal">-</div></div>
      <div class="scan-row"><div class="scan-label">هاست‌نم</div><div class="scan-value" id="res-hostname">-</div></div>
    </div>
  </div>
</div>

<div class="page" id="page-wizard">
  <div class="card">
    <div class="card-header">
      <div class="card-icon">🧙</div>
      <div><div class="card-title">Wizard Panel Deployer</div><div class="card-subtitle">نصب خودکار پنل‌های VPN روی Cloudflare</div></div>
    </div>
    <div class="section-title">توکن Cloudflare API</div>
    <div class="scan-input" style="margin-bottom:12px">
      <input type="password" id="cfToken" placeholder="API Token را وارد کنید" style="font-size:12px">
    </div>
    <div class="scan-input" style="margin-bottom:12px">
      <input type="email" id="cfEmail" placeholder="ایمیل (فقط برای Global Key)" style="font-size:12px">
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn" id="validateBtn" style="flex:1">🔍 بررسی</button>
      <button class="btn" id="createTokenBtn" onclick="createToken()" style="flex:1;background:linear-gradient(135deg,#6c5ce7,#a29bfe)">🔑 ساخت توکن</button>
    </div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:16px;text-align:center">API Token نداری؟ روی «🔑 ساخت توکن» بزن → توکن بساز → کپی کن → اینجا بزن</div>
<div style="font-size:10px;color:var(--dim);margin-bottom:12px;text-align:center;padding:8px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.05)">🔒 توکن شما ذخیره نمیشود و فقط برای نصب پنل استفاده میشود</div>
    <div id="accountInfo" style="display:none;margin-bottom:16px">
      <div class="scan-result">
        <div class="scan-row"><div class="scan-label">اکانت</div><div class="scan-value" id="accName">-</div></div>
        <div class="scan-row"><div class="scan-label">ID</div><div class="scan-value" id="accId">-</div></div>
      </div>
    </div>
    <div id="panelSelect" style="display:none">
      <div class="section-title">نوع پنل را انتخاب کنید</div>
      <div id="panelList" style="display:grid;gap:10px;margin-bottom:16px">
        <div class="cf-item" style="cursor:pointer" id="panel-edtunnel" data-panel="edtunnel">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:40px;height:40px;background:linear-gradient(135deg,#ff6b6b,#ee5a24);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px">🔴</div>
            <div><div style="font-weight:700;font-size:14px">EdgeTunnel</div><div style="font-size:11px;color:var(--dim)">⭐ 41.4k - VLESS/Trojan/SS</div></div>
          </div>
          <div class="cf-status working">پیشنهادی</div>
        </div>
        <div class="cf-item" style="cursor:pointer" id="panel-nahan" data-panel="nahan">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:40px;height:40px;background:linear-gradient(135deg,#00b894,#00cec9);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px">🟢</div>
            <div><div style="font-weight:700;font-size:14px">Nahan Panel</div><div style="font-size:11px;color:var(--dim)">⭐ 60+ - VLESS/Reality</div></div>
          </div>
          <div class="cf-status" style="background:rgba(0,212,170,.15);color:var(--success)">سریع</div>
        </div>
        <div class="cf-item" style="cursor:pointer" id="panel-cfnew" data-panel="cfnew">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:40px;height:40px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px">🟣</div>
            <div><div style="font-weight:700;font-size:14px">Cfnew Panel</div><div style="font-size:11px;color:var(--dim)">⭐ 14.6k - GrainTCP (کم پینگ)</div></div>
          </div>
          <div class="cf-status" style="background:rgba(108,92,231,.15);color:var(--accent)">کم پینگ</div>
        </div>
      </div>
    </div>
    <div id="wizardConfig" style="display:none">
      <div class="section-title">تنظیمات پنل</div>
      <div class="scan-input" style="margin-bottom:10px">
        <input type="text" id="panelName" placeholder="نام ورکر (خودکار ساخته میشه)">
      </div>
      <button class="btn" id="deployBtn">🚀 نصب و فعال‌سازی</button>
    </div>
    <div id="deployProgress" style="display:none;margin-top:16px">
      <div class="section-title"> وضعیت نصب</div>
      <div id="deployLog" style="background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:16px;font-family:'Courier New',monospace;font-size:12px;color:var(--accent);max-height:300px;overflow-y:auto;direction:ltr;text-align:left"></div>
    </div>
    <div id="deployResult" style="display:none;margin-top:16px">
      <div class="section-title">✅ نصب کامل شد!</div>
      <div class="scan-result">
        <div class="scan-row"><div class="scan-label">URL</div><div class="scan-value" id="res-url" style="color:var(--success)">-</div></div>
        <div class="scan-row"><div class="scan-label">نام</div><div class="scan-value" id="res-name">-</div></div>
        <div class="scan-row"><div class="scan-label">پنل</div><div class="scan-value" id="res-panel">-</div></div>
      </div>
      <button class="btn" id="copyPanelBtn" style="margin-top:12px">📋 کپی لینک پنل</button>
    </div>
  </div>
</div>

<div class="page" id="page-cfscan">
  <div class="card">
    <div class="card-header">
      <div class="card-icon">☁️</div>
      <div><div class="card-title">Cloudflare Scanner</div><div class="card-subtitle">اسکن آیپی‌های Cloudflare برای پیدا کردن بهترین IP</div></div>
    </div>
    <button class="btn" id="cfScanBtn">🚀 شروع اسکن</button>
    <div class="progress-bar" id="cfProgress" style="display:none"><div class="progress-fill" id="cfProgressFill"></div></div>
    <div class="stats" id="cfStats" style="display:none">
      <div class="stat"><div class="stat-num" id="cfTotal">0</div><div class="stat-label">کل اسکن شده</div></div>
      <div class="stat"><div class="stat-num" id="cfWorking" style="color:var(--success)">0</div><div class="stat-label">فعال</div></div>
      <div class="stat"><div class="stat-num" id="cfFailed" style="color:var(--danger)">0</div><div class="stat-label">غیرفعال</div></div>
    </div>
    <div class="cf-results" id="cfResults"></div>
  </div>
</div>

<a class="floating" href="https://t.me/Arshia_Kennedy" target="_blank" rel="noopener">📬 تلگرام</a>
<div class="toast" id="toast"></div>

<script>
(function(){
  var currentPassword='', count=0, scanning=false, selectedPanel=null, validatedToken=null, validatedAccountId=null, validatedEmail=null;

  function $(id){return document.getElementById(id)}
  function openMenu(){$('menuOverlay').classList.add('active');$('sidebar').classList.add('active')}
  function closeMenu(){$('menuOverlay').classList.remove('active');$('sidebar').classList.remove('active')}
  function showPage(page){
    document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});
    document.querySelectorAll('.menu-item[data-page]').forEach(function(m){m.classList.remove('active')});
    var el=$('page-'+page);if(el)el.classList.add('active');
    var nav=$('nav-'+page);if(nav)nav.classList.add('active');
    if(page==='ipscan')getMyIP();
    closeMenu();
  }
  function showToast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2500)}

  async function generate(){
    try{
      $('generateBtn').textContent='⏳ ...';$('generateBtn').disabled=true;
      var r=await fetch('/api/generate');var d=await r.json();
      currentPassword=d.password;$('password').textContent=currentPassword;
      $('pwdContainer').classList.remove('copied');$('copyBtn').classList.remove('copied');$('copyBtn').textContent='📋';
      count++;$('count').textContent=count;
      $('generateBtn').textContent='🔄 ساختن رمز جدید';$('generateBtn').disabled=false;
    }catch(e){$('generateBtn').textContent='🔄 ساختن رمز جدید';$('generateBtn').disabled=false}
  }

  function copyPassword(){
    if(!currentPassword)return;
    navigator.clipboard.writeText(currentPassword).then(function(){
      $('copyBtn').classList.add('copied');$('copyBtn').textContent='✅';$('pwdContainer').classList.add('copied');
      showToast('✅ رمز کپی شد!');
      setTimeout(function(){$('copyBtn').classList.remove('copied');$('copyBtn').textContent='📋';$('pwdContainer').classList.remove('copied')},2000);
    }).catch(function(){showToast('❌ خطا در کپی')});
  }

  async function getMyIP(){
    try{var r=await fetch('/api/my-ip');var d=await r.json();$('myIp').textContent=d.ip}
    catch(e){$('myIp').textContent='خطا'}
  }

  async function scanIP(){
    var ip=$('ipInput').value.trim();
    if(!ip){showToast('⚠️ آیپی رو وارد کنید');return}
    $('scanResult').style.display='none';showToast('⏳ در حال اسکن...');
    try{
      var r=await fetch('https://ipwho.is/'+ip);var d=await r.json();
      if(!d.success){showToast('❌ IP پیدا نشد');return}
      $('res-ip').textContent=d.ip||'-';$('res-city').textContent=d.city||'-';$('res-region').textContent=d.region||'-';
      $('res-country').textContent=d.country||'-';$('res-loc').textContent=d.latitude+','+d.longitude||'-';$('res-org').textContent=d.connection.org||'-';
      $('res-timezone').textContent=d.timezone||'-';$('res-postal').textContent=d.postal||'-';$('res-hostname').textContent=d.connection.domain||'-';
      $('scanResult').style.display='block';showToast('✅ اسکن کامل شد!');
    }catch(e){showToast('❌ خطا در اسکن')}
  }

  async function startCFScan(){
    if(scanning)return;scanning=true;
    $('cfScanBtn').textContent='⏳ در حال اسکن...';$('cfScanBtn').disabled=true;
    $('cfProgress').style.display='block';$('cfStats').style.display='grid';$('cfResults').innerHTML='';
    $('cfProgressFill').style.width='50%';
    try{
      var r=await fetch('/api/scan-cf');var d=await r.json();
      $('cfProgressFill').style.width='100%';$('cfTotal').textContent=d.total;
      $('cfWorking').textContent=d.working;$('cfFailed').textContent=d.total-d.working;
      var html='';
      d.results.forEach(function(item){
        html+='<div class="cf-item"><div class="cf-ip">'+item.ip+'</div><div class="cf-latency">'+item.latency+'ms</div><div class="cf-status '+item.status+'">'+(item.status==='working'?'فعال':'غیرفعال')+'</div></div>';
      });
      $('cfResults').innerHTML=html;
    }catch(e){showToast('❌ خطا در اسکن')}
    $('cfScanBtn').textContent='🔄 اسکن مجدد';$('cfScanBtn').disabled=false;scanning=false;showToast('✅ اسکن کامل شد!');
  }

  // Wizard - Server-side API
  // Create API Token from Global Key
  window.createToken=function(){
    var url='https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22page%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Wizard-Token';
    window.open(url,'_blank');
    showToast('🔑 صفحه ساخت توکن باز شد!');
  };
  async function validateToken(){
    var token=$('cfToken').value.trim();
    var email=$('cfEmail').value.trim();
    if(!token){showToast('⚠️ توکن رو وارد کنید');return}
    $('validateBtn').textContent='⏳ در حال بررسی...';$('validateBtn').disabled=true;
    try{
      var body={token:token};
      if(email)body.email=email;
      var r=await fetch('/api/wizard/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      var d=await r.json();
      if(!d.success){showToast('❌ '+d.error);$('validateBtn').textContent='🔍 بررسی';$('validateBtn').disabled=false;return}
      validatedToken=token;validatedAccountId=d.accountId;
      if(email)validatedEmail=email;
      // Clear input fields for security
      $('cfToken').value='';$('cfEmail').value='';
      $('accName').textContent=d.accountName;$('accId').textContent=d.accountId;
      $('accountInfo').style.display='block';$('panelSelect').style.display='block';
      $('validateBtn').textContent='✅ معتبر';
      showToast('✅ توکن معتبر!');
    }catch(e){showToast('❌ خطا: '+e.message);$('validateBtn').textContent='🔍 بررسی';$('validateBtn').disabled=false}
  }

  function selectPanel(type,el){
    selectedPanel=type;
    document.querySelectorAll('#panelList .cf-item').forEach(function(item){item.style.borderColor='var(--border)';item.style.background=''});
    el.style.borderColor='var(--accent)';el.style.background='rgba(0,212,170,.05)';
    $('wizardConfig').style.display='block';
    $('panelName').value=type+'-'+Math.random().toString(36).substr(2,8);
  }

  async function deployPanel(){
    if(!validatedToken||!validatedAccountId){showToast('⚠️ اول توکن رو بررسی کنید');return}
    if(!selectedPanel){showToast('⚠️ نوع پنل رو انتخاب کنید');return}
    var workerName=$('panelName').value.trim();
    if(!workerName){showToast('⚠️ نام ورکر رو وارد کنید');return}
    
    $('deployBtn').textContent='⏳ در حال نصب...';$('deployBtn').disabled=true;
    $('deployProgress').style.display='block';$('deployResult').style.display='none';
    $('deployLog').innerHTML='';
    
    try{
      var r=await fetch('/api/wizard/deploy',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:validatedToken,accountId:validatedAccountId,panelType:selectedPanel,workerName:workerName,email:validatedEmail})
      });
      var d=await r.json();
      
      // Show logs
      if(d.logs){
        $('deployLog').innerHTML=d.logs.map(function(l){return l}).join('<br>');
        $('deployLog').scrollTop=$('deployLog').scrollHeight;
      }
      
      if(d.success){
        $('res-url').textContent=d.panelURL;$('res-name').textContent=d.workerName;$('res-panel').textContent=d.panelType;
        $('deployResult').style.display='block';
        $('deployBtn').textContent='✅ نصب کامل شد';
        showToast('✅ پنل نصب شد!');
      }else{
        showToast('❌ '+d.error);
        $('deployBtn').textContent='🚀 نصب و فعال‌سازی';$('deployBtn').disabled=false;
      }
    }catch(e){
      showToast('❌ خطا: '+e.message);
      $('deployBtn').textContent='🚀 نصب و فعال‌سازی';$('deployBtn').disabled=false;
    }
  }

  function copyPanelURL(){var url=$('res-url').textContent;navigator.clipboard.writeText(url).then(function(){showToast('✅ لینک کپی شد!')}).catch(function(){showToast('❌ خطا')})}

  // All event listeners
  $('hamburgerBtn').addEventListener('click', openMenu);
  $('closeBtn').addEventListener('click', closeMenu);
  $('menuOverlay').addEventListener('click', closeMenu);
  $('generateBtn').addEventListener('click', generate);
  $('copyBtn').addEventListener('click', copyPassword);
  $('scanIpBtn').addEventListener('click', scanIP);
  $('cfScanBtn').addEventListener('click', startCFScan);
  $('validateBtn').addEventListener('click', validateToken);
  $('deployBtn').addEventListener('click', deployPanel);
  $('copyPanelBtn').addEventListener('click', copyPanelURL);

  document.querySelectorAll('.menu-item[data-page]').forEach(function(item){
    item.addEventListener('click', function(){showPage(this.getAttribute('data-page'))});
  });

  document.querySelectorAll('#panelList .cf-item[data-panel]').forEach(function(item){
    item.addEventListener('click', function(){selectPanel(this.getAttribute('data-panel'),this)});
  });

  generate();
  
  // Security: Clear sensitive data on page unload
  window.addEventListener('beforeunload', function(){
    validatedToken=null;validatedAccountId=null;validatedEmail=null;
    var t=document.getElementById('cfToken');if(t)t.value='';
    var e=document.getElementById('cfEmail');if(e)e.value='';
  });
})();
</script>
</body>
</html>`;
