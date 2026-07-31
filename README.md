# 🔍 Check Host

A powerful Cloudflare Worker tool with 4 features:

- 🔑 **Password Generator** - Strong 32-char passwords, never repeated
- 🌍 **IP Scanner** - Check IP information and network details
- ☁️ **Cloudflare Scanner** - Scan Cloudflare IP ranges for latency
- 🧙 **Wizard** - Auto-deploy VPN panels (EdgeTunnel, Nahan, Cfnew)

## Features

### 🔑 Password Generator
- 32-character strong passwords
- Uses `Math.random()` for generation
- Copy to clipboard with one tap
- Track password count

### 🌍 IP Scanner
- IP geolocation
- ISP information
- City/Country details
- ASN lookup

### ☁️ Cloudflare Scanner
- Scans 19 Cloudflare IP ranges
- Shows ping latency
- Color-coded results

### 🧙 Wizard Panel Deployer
- **EdgeTunnel** (41.4k ⭐) - VLESS/Trojan/SS
- **Nahan Panel** - VLESS/Reality
- **Cfnew** (14.6k ⭐) - GrainTCP (lowest ping)

Supports both API Token and Global API Key.

## Deployment

1. Create a Cloudflare Worker
2. Copy the contents of `index.js`
3. Deploy!

## Tech Stack

- Cloudflare Workers
- ES Modules
- Vanilla JavaScript
- RTL Persian/Farsi UI

## License

MIT
