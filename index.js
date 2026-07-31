// WizardCF v3 - Wizard via server-side API + Cfnew fix
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
          else if (panelType === 'nova') {
            const r = await fetch('https://raw.githubusercontent.com/IRNova/Nova-Proxy/main/worker.js');
            workerSource = await r.text();
            addLog('✅ Nova Proxy source: ' + workerSource.length + ' bytes');
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
        if (d1Id) bindings.push({ type: 'd1', name: panelType === 'nova' ? 'DB' : 'IOT_DB', database_id: d1Id });
        
        // For Cfnew, the binding name should be 'u' with UUID value in KV
        // Actually Cfnew reads from KV variable 'u' - we already wrote the UUID above
        // But the binding itself should still be named 'KV' and Cfnew reads key 'u' from it
        
        const metadata = {
          main_module: 'index.js',
          bindings: bindings,
          vars: panelType === 'edtunnel' ? { ADMIN: 'ylfQxtp7SZ36MZCf' } : panelType === 'nova' ? { PAGES_URL: 'https://nova-panel.github.io' } : {},
          vars: panelType === 'edtunnel' ? { ADMIN: 'wGnUhRMN0D85d2EQ' } : {},
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
        
        const panelURL = `https://${workerName}.${subdomain}.workers.dev` + (panelType==='nahan'?'/sync/dash':'');
        addLog('✅ Panel is live!');
        if(panelType==='edtunnel')addLog('🔑 رمز ادمین: '+(metadata.vars?.ADMIN||'نامشخص'));
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
<title>WizardCF</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0f17;--card:#161622;--card2:#1e1e2e;--accent:#00d4aa;--accent2:#00f5c8;--text:#e0e0e0;--dim:#6b7280;--border:#2a2a3a;--success:#00d4aa;--danger:#ff4757;--gradient:linear-gradient(135deg,#00d4aa,#00f5c8)}
body{font-family:'Inter','Segoe UI',Tahoma,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.bg-grid{position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(0,212,170,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,.03) 1px,transparent 1px);background-size:50px 50px;z-index:-1}
.menu-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.85);z-index:99;display:none;backdrop-filter:blur(8px)}
.menu-overlay.active{display:block}
.sidebar{position:fixed;top:0;right:-320px;width:300px;height:100%;background:var(--card);border-left:1px solid var(--border);z-index:100;transition:right .3s cubic-bezier(.4,0,.2,1);padding:24px;display:flex;flex-direction:column}
.sidebar.active{right:0}
.menu-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.menu-logo{display:flex;align-items:center;gap:10px}
.menu-logo-icon{width:40px;height:40px;background:var(--gradient);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px}
.menu-logo-text{font-size:16px;font-weight:700;color:var(--accent)}
.close-btn{background:var(--card2);border:1px solid var(--border);color:var(--text);width:36px;height:36px;border-radius:10px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.close-btn:hover{background:var(--danger);border-color:var(--danger);color:#fff}
.menu-section{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px;padding-right:8px}
.menu-item{display:flex;align-items:center;gap:14px;padding:14px;border-radius:12px;cursor:pointer;transition:all .2s;margin-bottom:4px;color:var(--text);text-decoration:none;border:1px solid transparent}
.menu-item:hover{background:var(--card2);border-color:var(--border)}
.menu-item.active{background:rgba(0,212,170,.1);border-color:var(--accent)}
.menu-icon{width:42px;height:42px;border-radius:10px;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:18px;transition:all .2s}
.menu-item.active .menu-icon{background:var(--gradient)}
.menu-label{font-weight:600;font-size:14px}
.menu-desc{font-size:11px;color:var(--dim);margin-top:2px}
.menu-item.active .menu-label{color:var(--accent)}
.menu-footer{margin-top:auto;padding-top:20px;border-top:1px solid var(--border);text-align:center;color:var(--dim);font-size:11px}
.header{background:rgba(22,22,34,.9);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:50}
.hamburger{background:var(--card2);border:1px solid var(--border);color:var(--text);width:42px;height:42px;border-radius:10px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;-webkit-tap-highlight-color:transparent}
.hamburger:hover,.hamburger:active{background:var(--accent);color:#000;border-color:var(--accent)}
.logo{display:flex;align-items:center;gap:10px;flex:1}
.logo-icon{width:36px;height:36px;background:var(--gradient);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px}
.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.5px}
.logo-text span{color:var(--accent)}
.page{display:none;padding:20px;animation:fadeIn .4s ease}
.page.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
.section-title{font-size:13px;color:var(--dim);margin-bottom:16px;font-weight:600}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px;transition:all .3s}
.card:hover{border-color:rgba(0,212,170,.3)}
.card-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.card-icon{width:44px;height:44px;background:var(--gradient);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px}
.card-title{font-size:16px;font-weight:700}
.card-subtitle{font-size:12px;color:var(--dim)}
.pwd-container{background:var(--card2);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:all .3s}
.pwd-container:hover{border-color:var(--accent)}
.pwd-container.copied{border-color:var(--success);box-shadow:0 0 20px rgba(0,212,170,.2)}
.pwd-row{display:flex;align-items:center;padding:16px}
.pwd-box{flex:1;font-family:'JetBrains Mono','Courier New',monospace;font-size:14px;font-weight:600;color:var(--accent);word-break:break-all;line-height:1.6;min-height:44px;display:flex;align-items:center;direction:ltr;text-align:left}
.copy-btn{background:var(--gradient);border:none;color:#000;width:44px;height:44px;border-radius:10px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;margin-right:12px;flex-shrink:0;font-weight:700}
.copy-btn:hover{transform:scale(1.1);box-shadow:0 4px 15px rgba(0,212,170,.4)}
.copy-btn.copied{background:#fff}
.btn{background:var(--gradient);color:#000;border:none;padding:14px 20px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;width:100%;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(0,212,170,.3)}
.btn:active{transform:translateY(0)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
.stat{text-align:center;padding:14px;background:var(--card2);border:1px solid var(--border);border-radius:12px}
.stat-num{font-size:22px;font-weight:700;color:var(--accent);font-family:'JetBrains Mono',monospace}
.stat-label{font-size:10px;color:var(--dim);margin-top:4px}
.scan-input{display:flex;gap:10px;margin-bottom:16px}
.scan-input input{flex:1;background:var(--card2);border:1px solid var(--border);color:var(--text);padding:14px;border-radius:12px;font-size:14px;outline:none;direction:ltr;text-align:left;font-family:'JetBrains Mono',monospace}
.scan-input input:focus{border-color:var(--accent)}
.scan-btn{background:var(--gradient);border:none;color:#000;padding:14px 24px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;transition:all .2s}
.scan-btn:hover{box-shadow:0 4px 15px rgba(0,212,170,.4)}
.scan-result{background:var(--card2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.scan-row{display:flex;padding:12px 16px;border-bottom:1px solid var(--border);align-items:center}
.scan-row:last-child{border-bottom:none}
.scan-label{width:110px;font-size:11px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.scan-value{flex:1;font-size:13px;font-family:'JetBrains Mono',monospace;color:var(--accent);direction:ltr;text-align:left}
.my-ip-box{background:linear-gradient(135deg,rgba(0,212,170,.1),rgba(0,245,200,.05));border:1px solid rgba(0,212,170,.2);border-radius:16px;padding:24px;text-align:center;margin-bottom:20px}
.my-ip-label{font-size:11px;color:var(--dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px}
.my-ip{font-size:28px;font-weight:700;color:var(--accent);font-family:'JetBrains Mono',monospace}
.cf-results{display:grid;gap:10px;margin-top:16px}
.cf-item{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;transition:all .2s}
.cf-item:hover{border-color:var(--accent)}
.cf-ip{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--text);direction:ltr}
.cf-status{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase}
.cf-status.working{background:rgba(0,212,170,.15);color:var(--success)}
.cf-status.timeout{background:rgba(255,71,87,.15);color:var(--danger)}
.cf-latency{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--dim)}
.progress-bar{height:4px;background:var(--card2);border-radius:2px;margin-top:16px;overflow:hidden}
.progress-fill{height:100%;background:var(--gradient);width:0%;transition:width .3s;border-radius:2px}
.toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:var(--success);color:#000;padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;opacity:0;transition:all .3s;z-index:200;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(-10px)}
.floating{position:fixed;bottom:20px;right:20px;background:linear-gradient(135deg,#0088cc,#0066aa);color:#fff;padding:12px 18px;border-radius:50px;text-decoration:none;font-size:12px;font-weight:600;box-shadow:0 4px 20px rgba(0,136,204,.4);z-index:50;display:flex;align-items:center;gap:8px;transition:all .2s}
.floating:hover{transform:scale(1.05)}
</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="menu-overlay" id="menuOverlay"></div>
<div class="sidebar" id="sidebar">
  <div class="menu-header">
    <div class="menu-logo">
      <div class="menu-logo-icon">⚡</div>
      <div class="menu-logo-text">WizardCF</div>
    </div>
    <button class="close-btn" id="closeBtn">✕</button>
  </div>
  <div class="menu-section">ابزارها</div>
  <div class="menu-item" id="nav-passgen" data-page="passgen">
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
  <div class="menu-item active" id="nav-wizard" data-page="wizard">
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
    <div class="logo-text">Wizard<span>CF</span></div>
  </div>
</div>

<div class="page" id="page-passgen">
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

<div class="page active" id="page-wizard">
  <div class="card">
    <div class="card-header">
      <div class="card-icon">🧙</div>
      <div><div class="card-title">Wizard Panel Deployer</div><div class="card-subtitle">نصب خودکار پنل‌های VPN روی Cloudflare</div></div>
    </div>
        <div class="section-title">📖 راهنمای قدم به قدم</div>
    <div style="background:rgba(0,229,195,0.05);border:1px solid rgba(0,229,195,0.1);border-radius:12px;padding:14px;margin-bottom:16px;font-size:12px;line-height:2.2">
      <div><b style="color:var(--accent)">۱.</b> روی دکمه <b>🔑 ساخت توکن</b> بزنید</div>
      <div><b style="color:var(--accent)">۲.</b> در صفحه Cloudflare یک <b>توکن جدید</b> بسازید</div>
      <div><b style="color:var(--accent)">۳.</b> <b>مجوزها</b> را تیک بزنید: Workers, KV, D1, Pages, DNS</div>
      <div><b style="color:var(--accent)">۴.</b> توکن را <b>کپی</b> کنید و در کادر زیر بزنید</div>
      <div><b style="color:var(--accent)">۵.</b> پنل مورد نظر را <b>انتخاب</b> کنید</div>
      <div><b style="color:var(--accent)">۶.</b> اسم دلخواه برای ورکر بنویسید</div>
      <div><b style="color:var(--accent)">۷.</b> روی <b>نصب و فعال‌سازی</b> بزنید 🚀</div>
    </div>
        <div class="section-title" style="color:var(--danger);margin-top:16px">🔴 راهنمای EdgeTunnel</div>
    <div style="background:rgba(244,63,94,0.05);border:1px solid rgba(244,63,94,0.15);border-radius:12px;padding:14px;margin-bottom:16px;font-size:12px;line-height:2.2">
      <div><b style="color:var(--danger)">۱.</b> اول از منو <b>Wizard</b> رو باز کنید</div>
      <div><b style="color:var(--danger)">۲.</b> توکن Cloudflare رو وارد کنید</div>
      <div><b style="color:var(--danger)">۳.</b> پنل <b>EdgeTunnel</b> رو انتخاب کنید</div>
      <div><b style="color:var(--danger)">۴.</b> اسم ورکر رو بنویسید (مثلاً my-edge)</div>
      <div><b style="color:var(--danger)">۵.</b> روی <b>نصب</b> بزنید</div>
      <div><b style="color:var(--danger)">۶.</b> لینک پنل رو کپی کنید</div>
      <div><b style="color:var(--danger)">۷.</b> <b>⚠️ مهم:</b> رمز ادمین رو از لاگ کپی کنید</div>
      <div><b style="color:var(--danger)">۸.</b> وارد پنل بشید و رمز رو بزنید</div>
      <div style="margin-top:8px;padding:8px;background:rgba(244,63,94,0.1);border-radius:8px;font-size:11px">
        💡 <b>نکته:</b> اگه رمز ادمین کار نکرد، از منو برید به <b>Settings > Variables</b> و متغیر <b>ADMIN</b> رو با رمز دلخواه ست کنید
      </div>
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
          <div class="cf-status" style="background:rgba(108,92,231,.15);color:#a29bfe">کم پینگ</div>
        </div>
        <div class="cf-item" style="cursor:pointer" id="panel-nova" data-panel="nova">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="panel-icon" style="background:linear-gradient(135deg,#f59e0b,#f97316);font-size:18px">🦊</div>
          <div><div style="font-weight:700">Nova Proxy</div><div style="font-size:11px;color:var(--dim)">⭐ 3.1k - Trojan/Warp/Proxy</div></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cf-status">تازه</div>
        </div>
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
