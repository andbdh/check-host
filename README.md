# 🔍 Check Host

ابزار همه‌کاره Cloudflare Worker

**🔗 استفاده آنلاین:** [wizardcf.dpdns.org](https://wizardcf.dpdns.org)

## ابزارها

| ابزار | توضیح |
|-------|-------|
| 🔑 **تولید رمز عبور** | رمز 32 کاراکتری قوی و یکتا |
| 🌍 **اسکنر IP** | اطلاعات IP و موقعیت جغرافیایی |
| ☁️ **اسکنر Cloudflare** | بررسی پینگ آیپی‌های Cloudflare |
| 🧙 **Wizard نصب پنل** | نصب خودکار پنل‌های VPN |

### 🧙 پنل‌های پشتیبانی شده

| پنل | ستاره | ویژگی |
|-----|-------|-------|
| 🔴 **EdgeTunnel** | ⭐ 41.4k | VLESS/Trojan/SS |
| 🟢 **Nahan Panel** | 60+ | VLESS/Reality |
| 🟣 **Cfnew** | ⭐ 14.6k | GrainTCP (کم پینگ) |

## 🔒 امنیت

- ✅ **توکن‌ها ذخیره نمیشوند** — فقط در حافظه مرورگر نگه داشته میشوند
- ✅ **پاک کردن خودکار** — هنگام بستن صفحه، توکن‌ها پاک میشوند
- ✅ **بدون localStorage** — هیچ اطلاعاتی در مرورگر ذخیره نمیشود
- ✅ **بدون cookie** — جلسه کاری ردیابی نمیشود
- ✅ **Security Headers** — محافظت در برابر XSS، Clickjacking و ...
- ✅ **پردازش سمت سرور** — توکن‌ها فقط روی سرور Cloudflare پردازش میشوند

### Security Headers
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

## فناوری

- Cloudflare Workers
- ES Modules
- Vanilla JavaScript
- رابط کاربری RTL فارسی
