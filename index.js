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
<title>WizardCF</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap');

*{box-sizing:border-box;margin:0;padding:0}

:root{
  --bg:#06090f;
  --bg2:#0a0e18;
  --card:rgba(12,18,32,0.75);
  --card2:rgba(18,26,48,0.8);
  --card3:rgba(24,34,60,0.6);
  --accent:#00e5c3;
  --accent2:#00ffc8;
  --accent-dim:rgba(0,229,195,0.15);
  --accent-glow:rgba(0,229,195,0.4);
  --purple:#8b5cf6;
  --purple-dim:rgba(139,92,246,0.15);
  --blue:#3b82f6;
  --blue-dim:rgba(59,130,246,0.15);
  --orange:#f59e0b;
  --orange-dim:rgba(245,158,11,0.15);
  --red:#f85149;
  --red-dim:rgba(248,81,73,0.15);
  --text:#e8ecf4;
  --text2:#c0c8d8;
  --dim:#5a6478;
  --border:rgba(255,255,255,0.06);
  --border2:rgba(255,255,255,0.1);
  --success:#00e5c3;
  --danger:#f85149;
  --gradient:linear-gradient(135deg,#00e5c3 0%,#00ffc8 50%,#00d4aa 100%);
  --gradient-purple:linear-gradient(135deg,#8b5cf6,#a78bfa);
  --gradient-blue:linear-gradient(135deg,#3b82f6,#60a5fa);
  --glow:0 0 20px rgba(0,229,195,0.3),0 0 60px rgba(0,229,195,0.1);
  --glow-sm:0 0 10px rgba(0,229,195,0.2);
}

html{scroll-behavior:smooth}

body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg);
  color:var(--text);
  min-height:100vh;
  overflow-x:hidden;
  line-height:1.6;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}

/* Background effects */
.bg-grid{
  position:fixed;top:0;left:0;right:0;bottom:0;
  background-image:
    radial-gradient(ellipse 80% 50% at 50% -20%,rgba(0,229,195,0.08),transparent),
    radial-gradient(ellipse 60% 40% at 80% 100%,rgba(139,92,246,0.05),transparent),
    linear-gradient(rgba(255,255,255,0.015) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,0.015) 1px,transparent 1px);
  background-size:100% 100%,100% 100%,60px 60px,60px 60px;
  z-index:-1;
  pointer-events:none;
}

.bg-grid::after{
  content:'';position:fixed;top:0;left:0;right:0;bottom:0;
  background:radial-gradient(circle at 20% 20%,rgba(0,229,195,0.03) 0%,transparent 50%),
    radial-gradient(circle at 80% 80%,rgba(139,92,246,0.03) 0%,transparent 50%);
  z-index:-1;
  animation:bgPulse 8s ease-in-out infinite alternate;
}

@keyframes bgPulse{
  0%{opacity:0.5}
  100%{opacity:1}
}

/* Menu Overlay */
.menu-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;
  background:rgba(0,0,0,0.7);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  z-index:99;display:none;
  transition:opacity 0.3s ease;
}
.menu-overlay.active{display:block;animation:overlayIn 0.3s ease}

@keyframes overlayIn{from{opacity:0}to{opacity:1}}

/* Sidebar */
.sidebar{
  position:fixed;top:0;right:-340px;width:310px;height:100%;
  background:rgba(10,14,24,0.95);
  backdrop-filter:blur(40px);
  -webkit-backdrop-filter:blur(40px);
  border-left:1px solid var(--border2);
  z-index:100;
  transition:right 0.4s cubic-bezier(0.16,1,0.3,1);
  padding:24px 18px;
  display:flex;flex-direction:column;
  box-shadow:-20px 0 60px rgba(0,0,0,0.5);
}
.sidebar.active{right:0}

.menu-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:28px;padding-bottom:20px;
  border-bottom:1px solid var(--border);
}
.menu-logo{display:flex;align-items:center;gap:12px}
.menu-logo-icon{
  width:42px;height:42px;
  background:var(--gradient);
  border-radius:14px;
  display:flex;align-items:center;justify-content:center;
  font-size:20px;
  box-shadow:var(--glow-sm);
  animation:iconPulse 3s ease-in-out infinite;
}

@keyframes iconPulse{
  0%,100%{box-shadow:0 0 10px rgba(0,229,195,0.2)}
  50%{box-shadow:0 0 20px rgba(0,229,195,0.4)}
}

.menu-logo-text{font-size:17px;font-weight:800;color:var(--accent);letter-spacing:-0.3px}

.close-btn{
  background:rgba(255,255,255,0.04);
  border:1px solid var(--border2);
  color:var(--dim);
  width:36px;height:36px;border-radius:10px;
  font-size:14px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.25s ease;
}
.close-btn:hover{
  background:var(--red-dim);
  border-color:rgba(248,81,73,0.3);
  color:var(--red);
  transform:rotate(90deg);
}

.menu-section{
  font-size:10px;color:var(--dim);
  text-transform:uppercase;letter-spacing:1.5px;
  margin:22px 0 10px;padding-right:10px;
  font-weight:600;
}

.menu-item{
  display:flex;align-items:center;gap:14px;
  padding:13px 14px;border-radius:14px;
  cursor:pointer;transition:all 0.25s ease;
  margin-bottom:4px;color:var(--text);
  text-decoration:none;
  border:1px solid transparent;
  position:relative;
}
.menu-item:hover{
  background:rgba(255,255,255,0.04);
  border-color:var(--border2);
  transform:translateX(-3px);
}
.menu-item.active{
  background:rgba(0,229,195,0.08);
  border-color:rgba(0,229,195,0.2);
}
.menu-item.active::before{
  content:'';position:absolute;
  right:0;top:50%;transform:translateY(-50%);
  width:3px;height:60%;
  background:var(--gradient);
  border-radius:0 3px 3px 0;
}

.menu-icon{
  width:42px;height:42px;border-radius:12px;
  background:rgba(255,255,255,0.03);
  display:flex;align-items:center;justify-content:center;
  font-size:18px;transition:all 0.25s ease;
  border:1px solid var(--border);
}
.menu-item.active .menu-icon{
  background:var(--gradient);
  border-color:transparent;
  box-shadow:var(--glow-sm);
}

.menu-label{font-weight:600;font-size:13.5px}
.menu-desc{font-size:11px;color:var(--dim);margin-top:2px;line-height:1.4}
.menu-item.active .menu-label{color:var(--accent)}

.menu-footer{
  margin-top:auto;padding-top:20px;
  border-top:1px solid var(--border);
  text-align:center;color:var(--dim);font-size:11px;
  font-weight:500;
}

/* Header */
.header{
  background:rgba(6,9,15,0.85);
  backdrop-filter:blur(30px);
  -webkit-backdrop-filter:blur(30px);
  border-bottom:1px solid var(--border);
  padding:14px 20px;
  display:flex;align-items:center;gap:14px;
  position:sticky;top:0;z-index:50;
}
.header::after{
  content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(0,229,195,0.3),transparent);
}

.hamburger{
  background:rgba(255,255,255,0.04);
  border:1px solid var(--border2);
  color:var(--text);
  width:42px;height:42px;border-radius:12px;
  font-size:18px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.3s ease;
  -webkit-tap-highlight-color:transparent;
}
.hamburger:hover,.hamburger:active{
  background:var(--gradient);
  color:#000;border-color:transparent;
  box-shadow:var(--glow-sm);
  transform:scale(1.05);
}

.logo{display:flex;align-items:center;gap:10px;flex:1}
.logo-icon{
  width:38px;height:38px;
  background:var(--gradient);
  border-radius:11px;
  display:flex;align-items:center;justify-content:center;
  font-size:17px;
  box-shadow:var(--glow-sm);
}
.logo-text{font-size:19px;font-weight:800;letter-spacing:-0.5px}
.logo-text span{
  background:var(--gradient);
  -webkit-background-clip:text;
  -webkit-text-fill-color:transparent;
  background-clip:text;
}

/* Pages */
.page{display:none;padding:20px 16px;animation:pageIn 0.5s cubic-bezier(0.16,1,0.3,1)}
.page.active{display:block}

@keyframes pageIn{
  from{opacity:0;transform:translateY(20px)}
  to{opacity:1;transform:translateY(0)}
}

/* Section titles */
.section-title{
  font-size:11px;color:var(--dim);
  margin-bottom:14px;font-weight:600;
  text-transform:uppercase;letter-spacing:1px;
  display:flex;align-items:center;gap:8px;
}
.section-title::after{
  content:'';flex:1;height:1px;
  background:linear-gradient(90deg,var(--border2),transparent);
}

/* Cards */
.card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:22px;
  padding:24px;
  margin-bottom:18px;
  transition:all 0.35s ease;
  position:relative;
  overflow:hidden;
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(0,229,195,0.15),transparent);
}
.card:hover{
  border-color:rgba(0,229,195,0.12);
  box-shadow:0 8px 40px rgba(0,0,0,0.3),0 0 30px rgba(0,229,195,0.05);
  transform:translateY(-2px);
}

.card-header{
  display:flex;align-items:center;gap:14px;
  margin-bottom:20px;
}
.card-icon{
  width:48px;height:48px;
  background:var(--gradient);
  border-radius:14px;
  display:flex;align-items:center;justify-content:center;
  font-size:22px;
  box-shadow:var(--glow-sm);
  transition:transform 0.3s ease;
}
.card:hover .card-icon{transform:scale(1.05)}
.card-title{font-size:17px;font-weight:700;letter-spacing:-0.3px}
.card-subtitle{font-size:12px;color:var(--dim);margin-top:3px;font-weight:500}

/* Password Container */
.pwd-container{
  background:rgba(0,0,0,0.3);
  border:1px solid var(--border2);
  border-radius:16px;
  overflow:hidden;
  transition:all 0.35s ease;
  position:relative;
}
.pwd-container::before{
  content:'';position:absolute;inset:0;
  border-radius:16px;
  background:linear-gradient(135deg,rgba(0,229,195,0.05),transparent);
  pointer-events:none;
}
.pwd-container:hover{border-color:rgba(0,229,195,0.2)}
.pwd-container.copied{
  border-color:rgba(0,229,195,0.4);
  box-shadow:0 0 30px rgba(0,229,195,0.15),inset 0 0 30px rgba(0,229,195,0.05);
}

.pwd-row{display:flex;align-items:center;padding:18px 20px}
.pwd-box{
  flex:1;
  font-family:'JetBrains Mono','SF Mono','Cascadia Code',monospace;
  font-size:14px;font-weight:600;
  color:var(--accent);
  word-break:break-all;line-height:1.7;
  min-height:44px;display:flex;align-items:center;
  direction:ltr;text-align:left;
  letter-spacing:0.5px;
}

.copy-btn{
  background:var(--gradient);
  border:none;color:#000;
  width:46px;height:46px;border-radius:12px;
  font-size:18px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.3s ease;
  margin-right:14px;flex-shrink:0;
  font-weight:700;
  position:relative;
}
.copy-btn::after{
  content:'';position:absolute;inset:-2px;
  border-radius:14px;
  background:var(--gradient);
  opacity:0;filter:blur(8px);
  transition:opacity 0.3s ease;
  z-index:-1;
}
.copy-btn:hover{transform:scale(1.12)}
.copy-btn:hover::after{opacity:0.5}
.copy-btn:active{transform:scale(0.95)}
.copy-btn.copied{background:var(--gradient);box-shadow:var(--glow)}

/* Buttons */
.btn{
  background:var(--gradient);
  color:#000;border:none;
  padding:15px 24px;border-radius:14px;
  font-size:14px;font-weight:700;
  cursor:pointer;width:100%;
  transition:all 0.3s ease;
  display:flex;align-items:center;justify-content:center;gap:8px;
  position:relative;overflow:hidden;
  letter-spacing:0.2px;
}
.btn::before{
  content:'';position:absolute;top:0;left:-100%;
  width:100%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);
  transition:left 0.5s ease;
}
.btn:hover::before{left:100%}
.btn:hover{
  transform:translateY(-2px);
  box-shadow:0 8px 30px rgba(0,229,195,0.35),0 0 20px rgba(0,229,195,0.15);
}
.btn:active{transform:translateY(0) scale(0.98)}
.btn:disabled{
  opacity:0.5;cursor:not-allowed;
  transform:none !important;
  box-shadow:none !important;
}
.btn:disabled::before{display:none}

/* Stats */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:18px}
.stat{
  text-align:center;padding:16px 12px;
  background:rgba(0,0,0,0.25);
  border:1px solid var(--border);
  border-radius:14px;
  transition:all 0.3s ease;
  position:relative;
}
.stat:hover{border-color:rgba(0,229,195,0.15)}
.stat-num{
  font-size:24px;font-weight:800;
  color:var(--accent);
  font-family:'JetBrains Mono',monospace;
  line-height:1.2;
}
.stat-label{
  font-size:10px;color:var(--dim);
  margin-top:6px;font-weight:600;
  text-transform:uppercase;letter-spacing:0.5px;
}

/* Scan Input */
.scan-input{display:flex;gap:10px;margin-bottom:16px}
.scan-input input{
  flex:1;
  background:rgba(0,0,0,0.3);
  border:1px solid var(--border2);
  color:var(--text);
  padding:14px 16px;border-radius:14px;
  font-size:14px;outline:none;
  direction:ltr;text-align:left;
  font-family:'JetBrains Mono',monospace;
  transition:all 0.3s ease;
}
.scan-input input::placeholder{color:var(--dim);font-family:'Inter',sans-serif;direction:rtl;text-align:right}
.scan-input input:focus{
  border-color:rgba(0,229,195,0.4);
  box-shadow:0 0 0 3px rgba(0,229,195,0.1),0 0 20px rgba(0,229,195,0.08);
  background:rgba(0,229,195,0.03);
}

.scan-btn{
  background:var(--gradient);
  border:none;color:#000;
  padding:14px 24px;border-radius:14px;
  font-size:14px;font-weight:700;
  cursor:pointer;white-space:nowrap;
  transition:all 0.3s ease;
}
.scan-btn:hover{
  box-shadow:0 4px 20px rgba(0,229,195,0.4);
  transform:translateY(-1px);
}
.scan-btn:active{transform:translateY(0) scale(0.97)}

/* Scan Result */
.scan-result{
  background:rgba(0,0,0,0.25);
  border:1px solid var(--border);
  border-radius:14px;
  overflow:hidden;
}
.scan-row{
  display:flex;padding:13px 18px;
  border-bottom:1px solid var(--border);
  align-items:center;
  transition:background 0.2s ease;
}
.scan-row:last-child{border-bottom:none}
.scan-row:hover{background:rgba(255,255,255,0.02)}
.scan-label{
  width:110px;font-size:11px;color:var(--dim);
  font-weight:600;text-transform:uppercase;letter-spacing:0.5px;
}
.scan-value{
  flex:1;font-size:13px;
  font-family:'JetBrains Mono',monospace;
  color:var(--accent);direction:ltr;text-align:left;
}

/* My IP Box */
.my-ip-box{
  background:linear-gradient(135deg,rgba(0,229,195,0.08),rgba(139,92,246,0.05),rgba(0,229,195,0.03));
  border:1px solid rgba(0,229,195,0.15);
  border-radius:22px;
  padding:28px 24px;text-align:center;
  margin-bottom:20px;
  position:relative;overflow:hidden;
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
}
.my-ip-box::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(0,229,195,0.3),transparent);
}
.my-ip-box::after{
  content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse at center,rgba(0,229,195,0.05),transparent 70%);
  pointer-events:none;
}
.my-ip-label{
  font-size:10px;color:var(--dim);
  margin-bottom:10px;text-transform:uppercase;letter-spacing:2px;
  font-weight:600;
}
.my-ip{
  font-size:30px;font-weight:800;
  color:var(--accent);
  font-family:'JetBrains Mono',monospace;
  text-shadow:0 0 30px rgba(0,229,195,0.3);
}

/* CF Results */
.cf-results{display:grid;gap:8px;margin-top:16px}
.cf-item{
  background:rgba(0,0,0,0.25);
  border:1px solid var(--border);
  border-radius:12px;
  padding:13px 16px;
  display:flex;align-items:center;justify-content:space-between;
  transition:all 0.25s ease;
}
.cf-item:hover{
  border-color:rgba(0,229,195,0.15);
  background:rgba(255,255,255,0.02);
}
.cf-ip{
  font-family:'JetBrains Mono',monospace;
  font-size:13px;color:var(--text);direction:ltr;
}
.cf-status{
  padding:4px 12px;border-radius:8px;
  font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:0.5px;
}
.cf-status.working{
  background:rgba(0,229,195,0.12);
  color:var(--success);
  border:1px solid rgba(0,229,195,0.2);
}
.cf-status.timeout{
  background:rgba(248,81,73,0.12);
  color:var(--danger);
  border:1px solid rgba(248,81,73,0.2);
}
.cf-latency{
  font-family:'JetBrains Mono',monospace;
  font-size:12px;color:var(--dim);
}

/* Progress Bar */
.progress-bar{
  height:4px;background:rgba(255,255,255,0.05);
  border-radius:4px;margin-top:18px;overflow:hidden;
}
.progress-fill{
  height:100%;
  background:var(--gradient);
  width:0%;transition:width 0.5s ease;
  border-radius:4px;
  position:relative;
}
.progress-fill::after{
  content:'';position:absolute;top:0;right:0;bottom:0;
  width:60px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.4));
  animation:progressShine 1.5s ease-in-out infinite;
}
@keyframes progressShine{
  0%{opacity:0}
  50%{opacity:1}
  100%{opacity:0}
}

/* Toast */
.toast{
  position:fixed;bottom:30px;left:50%;
  transform:translateX(-50%) translateY(20px);
  background:rgba(12,18,32,0.95);
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  color:var(--text);
  padding:14px 28px;border-radius:14px;
  font-size:13px;font-weight:600;
  opacity:0;
  transition:all 0.4s cubic-bezier(0.16,1,0.3,1);
  z-index:200;pointer-events:none;
  border:1px solid var(--border2);
  box-shadow:0 10px 40px rgba(0,0,0,0.5);
}
.toast.show{
  opacity:1;
  transform:translateX(-50%) translateY(0);
}

/* Floating Telegram */
.floating{
  position:fixed;bottom:24px;right:24px;
  background:linear-gradient(135deg,#0088cc,#0066aa);
  color:#fff;
  padding:14px 22px;border-radius:50px;
  text-decoration:none;font-size:13px;font-weight:600;
  box-shadow:0 6px 25px rgba(0,136,204,0.5);
  z-index:50;
  display:flex;align-items:center;gap:8px;
  transition:all 0.3s ease;
  border:1px solid rgba(0,136,244,0.3);
}
.floating:hover{
  transform:translateY(-3px) scale(1.05);
  box-shadow:0 10px 35px rgba(0,136,204,0.6),0 0 20px rgba(0,136,204,0.3);
}
.floating:active{transform:translateY(0) scale(0.98)}

/* Deploy Log */
#deployLog{
  background:rgba(0,0,0,0.4);
  border:1px solid var(--border);
  border-radius:14px;
  padding:18px;
  font-family:'JetBrains Mono',monospace;
  font-size:12px;color:var(--accent);
  max-height:300px;overflow-y:auto;
  direction:ltr;text-align:left;
  line-height:1.8;
}
#deployLog::-webkit-scrollbar{width:6px}
#deployLog::-webkit-scrollbar-track{background:transparent}
#deployLog::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* Loading Spinner */
@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
.spinner{
  display:inline-block;width:18px;height:18px;
  border:2px solid rgba(0,0,0,0.2);
  border-top-color:#000;border-radius:50%;
  animation:spin 0.8s linear infinite;
}

/* Smooth scrollbar */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.15)}

/* Responsive */
@media(max-width:480px){
  .header{padding:12px 16px}
  .page{padding:16px 12px}
  .card{padding:20px 16px;border-radius:18px}
  .my-ip{font-size:24px}
  .my-ip-box{padding:22px 16px}
  .floating{bottom:18px;right:18px;padding:12px 18px;font-size:12px}
  .sidebar{width:280px;padding:20px 14px}
  .menu-item{padding:11px 12px}
}

/* Entrance animation for cards */
@keyframes cardIn{
  from{opacity:0;transform:translateY(15px) scale(0.98)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
.page.active .card{animation:cardIn 0.5s cubic-bezier(0.16,1,0.3,1) both}
.page.active .card:nth-child(2){animation-delay:0.08s}
.page.active .card:nth-child(3){animation-delay:0.16s}

/* Panel selection cards in wizard */
.panel-card{
  background:rgba(0,0,0,0.25);
  border:1px solid var(--border);
  border-radius:16px;
  padding:16px;
  cursor:pointer;
  transition:all 0.3s ease;
  position:relative;overflow:hidden;
}
.panel-card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,transparent,var(--border2),transparent);
  transition:all 0.3s ease;
}
.panel-card:hover{
  border-color:rgba(0,229,195,0.2);
  transform:translateY(-2px);
  box-shadow:0 8px 30px rgba(0,0,0,0.3);
}
.panel-card:hover::before{
  background:linear-gradient(90deg,transparent,rgba(0,229,195,0.4),transparent);
}
</style>
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
    <div class="logo-text">Wizard<span>CF</span></div>
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
      <button class="btn" id="createTokenBtn" onclick="createToken()" style="flex:1;background:var(--gradient-purple);color:#fff">🔑 ساخت توکن</button>
    </div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:16px;text-align:center;line-height:1.6">API Token نداری؟ روی «🔑 ساخت توکن» بزن → توکن بساز → کپی کن → اینجا بزن</div>
    <div style="font-size:10px;color:var(--dim);margin-bottom:12px;text-align:center;padding:10px;background:rgba(0,229,195,0.04);border-radius:10px;border:1px solid rgba(0,229,195,0.1);line-height:1.6">🔒 توکن شما ذخیره نمیشود و فقط برای نصب پنل استفاده میشود</div>
    <div id="accountInfo" style="display:none;margin-bottom:16px">
      <div class="scan-result">
        <div class="scan-row"><div class="scan-label">اکانت</div><div class="scan-value" id="accName">-</div></div>
        <div class="scan-row"><div class="scan-label">ID</div><div class="scan-value" id="accId">-</div></div>
      </div>
    </div>
    <div id="panelSelect" style="display:none">
      <div class="section-title">نوع پنل را انتخاب کنید</div>
      <div id="panelList" style="display:grid;gap:10px;margin-bottom:16px">
        <div class="panel-card" id="panel-edtunnel" data-panel="edtunnel">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:44px;height:44px;background:linear-gradient(135deg,#ff6b6b,#ee5a24);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 15px rgba(255,107,107,0.3)">🔴</div>
            <div><div style="font-weight:700;font-size:14px">EdgeTunnel</div><div style="font-size:11px;color:var(--dim);margin-top:2px">⭐ 41.4k - VLESS/Trojan/SS</div></div>
          </div>
          <div class="cf-status working" style="margin-top:10px;display:inline-flex">پیشنهادی</div>
        </div>
        <div class="panel-card" id="panel-nahan" data-panel="nahan">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:44px;height:44px;background:linear-gradient(135deg,#00b894,#00cec9);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 15px rgba(0,184,148,0.3)">🟢</div>
            <div><div style="font-weight:700;font-size:14px">Nahan Panel</div><div style="font-size:11px;color:var(--dim);margin-top:2px">⭐ 60+ - VLESS/Reality</div></div>
          </div>
          <div class="cf-status" style="background:rgba(0,229,195,0.12);color:var(--success);border:1px solid rgba(0,229,195,0.2);margin-top:10px;display:inline-flex">سریع</div>
        </div>
        <div class="panel-card" id="panel-cfnew" data-panel="cfnew">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:44px;height:44px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 15px rgba(108,92,231,0.3)">🟣</div>
            <div><div style="font-weight:700;font-size:14px">Cfnew Panel</div><div style="font-size:11px;color:var(--dim);margin-top:2px">⭐ 14.6k - GrainTCP (کم پینگ)</div></div>
          </div>
          <div class="cf-status" style="background:rgba(108,92,231,0.15);color:var(--purple);border:1px solid rgba(108,92,231,0.2);margin-top:10px;display:inline-flex">کم پینگ</div>
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
      <div class="section-title">وضعیت نصب</div>
      <div id="deployLog"></div>
    </div>
    <div id="deployResult" style="display:none;margin-top:16px">
      <div class="section-title">✅ نصب کامل شد!</div>
      <div class="scan-result">
        <div class="scan-row"><div class="scan-label">URL</div><div class="scan-value" id="res-url" style="color:var(--success)">-</div></div>
        <div class="scan-row"><div class="scan-label">نام</div><div class="scan-value" id="res-name">-</div></div>
        <div class="scan-row"><div class="scan-label">پنل</div><div class="scan-value" id="res-panel">-</div></div>
      </div>
      <button class="btn" id="copyPanelBtn" style="margin-top:14px">📋 کپی لینک پنل</button>
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
