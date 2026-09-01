const fs = require('fs');
const path = require('path');

// 讀取 .env 檔案或系統環境變數並解析
const envPath = path.join(__dirname, '.env');
let url = process.env.SUPABASE_URL || "";
let anonKey = process.env.SUPABASE_ANON_KEY || "";
let nlcClientId = process.env.NLC_CLIENT_ID || "";
let nlcLogtoIssuer = process.env.NLC_LOGTO_ISSUER || "https://sso.newlife.org.tw/oidc";
let nlcMemberHubUrl = process.env.NLC_MEMBER_HUB_URL || "https://member.newlife.org.tw";
let nlcScopes = process.env.NLC_SCOPES || "openid profile email offline_access member:read.basic";
let nlcPlatformResource = process.env.NLC_PLATFORM_RESOURCE || "https://platform.newlife.org.tw";
let nlcPlatformApiUrl = process.env.NLC_PLATFORM_API_URL || "https://platform.newlife.org.tw/platform/v1";
const appVersion = process.env.APP_VERSION || "0.1.1";
const onboardingVersion = process.env.ONBOARDING_VERSION || appVersion;

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const lines = envContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
      if (key === 'SUPABASE_URL' && !url) url = val;
      else if (key === 'SUPABASE_ANON_KEY' && !anonKey) anonKey = val;
      else if (key === 'NLC_CLIENT_ID' && !nlcClientId) nlcClientId = val;
      else if (key === 'NLC_LOGTO_ISSUER') nlcLogtoIssuer = val;
      else if (key === 'NLC_MEMBER_HUB_URL') nlcMemberHubUrl = val;
      else if (key === 'NLC_SCOPES') nlcScopes = val;
      else if (key === 'NLC_PLATFORM_RESOURCE') nlcPlatformResource = val;
      else if (key === 'NLC_PLATFORM_API_URL') nlcPlatformApiUrl = val;
    }
  }
}

// 產生前端可載入的 config.js
const configContent = `// 連線設定 (由 build-config.js 自動從 .env 產生，請勿直接手動編輯此檔案)
// Release defaults: appVersion: "0.1.1", onboardingVersion: "0.1.1"
const APP_CONFIG = {
  appVersion: "${appVersion}",
  onboardingVersion: "${onboardingVersion}"
};

const SUPABASE_CONFIG = {
  url: "${url}",
  anonKey: "${anonKey}"
};

// NLC 生態系整合設定 (向 NLC IT 申請取得 clientId)
const NLC_CONFIG = {
  clientId: "${nlcClientId}",
  issuer: "${nlcLogtoIssuer}",
  memberHubUrl: "${nlcMemberHubUrl}",
  scopes: "${nlcScopes}",
  platformResource: "${nlcPlatformResource}",
  platformApiUrl: "${nlcPlatformApiUrl}"
};

window.APP_CONFIG = APP_CONFIG;
window.APP_VERSION = APP_CONFIG.appVersion;
window.SUPABASE_CONFIG = SUPABASE_CONFIG;
window.NLC_CONFIG = NLC_CONFIG;
`;

fs.writeFileSync(path.join(__dirname, 'config.js'), configContent, 'utf8');
console.log('---');
console.log('成功從 .env 變數中重新產生 config.js 檔案！');
console.log(`Supabase URL: ${url ? url : '(尚未填寫)'}`);
console.log(`Supabase Anon Key: ${anonKey ? '已載入' : '(尚未填寫)'}`);
console.log(`NLC Client ID: ${nlcClientId ? nlcClientId : '(尚未填寫 — 向 NLC IT 申請)'}`);
console.log(`NLC Logto Issuer: ${nlcLogtoIssuer}`);
console.log(`NLC Member Hub URL: ${nlcMemberHubUrl}`);
console.log(`NLC Scopes: ${nlcScopes}`);
console.log(`NLC Platform Resource: ${nlcPlatformResource}`);
console.log(`NLC Platform API URL: ${nlcPlatformApiUrl}`);
console.log(`App Version: ${appVersion}`);
console.log(`Onboarding Version: ${onboardingVersion}`);
console.log('---');
