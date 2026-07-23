#!/usr/bin/env node
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ASC_KEY_ID    = process.env.ASC_KEY_ID;
const ASC_ISSUER_ID = process.env.ASC_ISSUER_ID;
const ASC_KEY_PATH  = process.env.ASC_KEY_PATH;
const BUNDLE_ID     = 'com.innercircle.cowboy';
const TEAM_ID       = '4LZJ7U5FHS';
const TMP           = process.env.RUNNER_TEMP || '/tmp';

// Use Homebrew OpenSSL if available (avoids LibreSSL quirks on macOS runners)
const OPENSSL = fs.existsSync('/opt/homebrew/opt/openssl@3/bin/openssl')
  ? '/opt/homebrew/opt/openssl@3/bin/openssl' : 'openssl';

function makeJWT() {
  const privKey = fs.readFileSync(ASC_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg:'ES256', kid:ASC_KEY_ID, typ:'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss:ASC_ISSUER_ID, iat:now, exp:now+1200, aud:'appstoreconnect-v1' })).toString('base64url');
  const toSign  = `${header}.${payload}`;
  const sign    = crypto.createSign('SHA256');
  sign.update(toSign);
  return `${toSign}.${sign.sign({ key:privKey, dsaEncoding:'ieee-p1363' }).toString('base64url')}`;
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.appstoreconnect.apple.com',
      path: apiPath, method,
      headers: {
        Authorization: `Bearer ${makeJWT()}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureBundleId(bundleId, name) {
  const list = await api('GET', `/v1/bundleIds?filter[identifier]=${bundleId}&filter[platform]=IOS`);
  if (list.body.data?.length) { console.log(`✅ Bundle ID exists: ${bundleId}`); return list.body.data[0].id; }
  console.log(`📦 Creating bundle ID: ${bundleId}`);
  const res = await api('POST', '/v1/bundleIds', {
    data: { type:'bundleIds', attributes:{ identifier:bundleId, name, platform:'IOS' } }
  });
  if (!res.body.data) throw new Error(`Failed to create bundle ID: ${JSON.stringify(res.body.errors)}`);
  return res.body.data.id;
}

async function createProfile(name, bundleIdResourceId, certId) {
  const existing = await api('GET', `/v1/profiles?filter[name]=${encodeURIComponent(name)}`);
  for (const p of (existing.body.data || [])) {
    if (p.attributes.name === name) {
      await api('DELETE', `/v1/profiles/${p.id}`);
    }
  }
  const res = await api('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { profileType:'IOS_APP_STORE', name },
      relationships: {
        bundleId: { data:{ type:'bundleIds', id:bundleIdResourceId } },
        certificates: { data:[{ type:'certificates', id:certId }] },
        devices: { data:[] }
      }
    }
  });
  if (!res.body.data) throw new Error(`Profile creation failed: ${JSON.stringify(res.body.errors)}`);
  return res.body.data;
}

async function main() {
  const distKeyPath = path.join(TMP, 'dist_key.pem');
  const csrPath = path.join(TMP, 'dist.csr');

  console.log('🔑 Generating distribution key and CSR...');
  execSync(`${OPENSSL} genrsa -out ${distKeyPath} 2048`);
  execSync(`${OPENSSL} req -new -key ${distKeyPath} -out ${csrPath} -subj "/CN=iPhone Distribution/O=Inner Circle Group/C=US"`);
  const csrDer = execSync(`${OPENSSL} req -in ${csrPath} -outform DER`);
  const csrB64 = csrDer.toString('base64').replace(/[\n\r]/g, '');

  // Only delete oldest cert if at the 2-cert limit — never nuke all
  console.log('📋 Checking existing distribution certs...');
  const certs = await api('GET', '/v1/certificates?filter[certificateType]=IOS_DISTRIBUTION&limit=20');
  const existingCerts = certs.body.data || [];
  console.log(`Existing IOS_DISTRIBUTION certs: ${existingCerts.length}`);
  existingCerts.forEach(c => console.log(` - ${c.id} exp:${c.attributes.expirationDate} serial:${c.attributes.serialNumber}`));

  if (existingCerts.length >= 2) {
    const oldest = [...existingCerts].sort(
      (a, b) => new Date(a.attributes.expirationDate) - new Date(b.attributes.expirationDate)
    )[0];
    console.log(`At limit — deleting oldest: ${oldest.id}`);
    await api('DELETE', `/v1/certificates/${oldest.id}`);
  }

  console.log('📜 Creating new distribution certificate...');
  const certRes = await api('POST', '/v1/certificates', {
    data: { type:'certificates', attributes:{ certificateType:'IOS_DISTRIBUTION', csrContent:csrB64 } }
  });
  if (!certRes.body.data) throw new Error(`Cert creation failed: ${JSON.stringify(certRes.body.errors)}`);
  const certId = certRes.body.data.id;
  const certContent = certRes.body.data.attributes.certificateContent;
  console.log(`✅ New cert: ${certId}`);

  const certPath = path.join(TMP, 'dist.cer');
  const p12Path = path.join(TMP, 'dist.p12');
  fs.writeFileSync(certPath, Buffer.from(certContent, 'base64'));
  execSync(`${OPENSSL} x509 -inform DER -in ${certPath} -out ${path.join(TMP, 'dist.pem')}`);
  try {
    execSync(`${OPENSSL} pkcs12 -export -legacy -inkey ${distKeyPath} -in ${path.join(TMP, 'dist.pem')} -out ${p12Path} -passout pass:cowboy123`, { stdio:'inherit' });
  } catch {
    execSync(`${OPENSSL} pkcs12 -export -inkey ${distKeyPath} -in ${path.join(TMP, 'dist.pem')} -out ${p12Path} -passout pass:cowboy123`, { stdio:'inherit' });
  }

  execSync(`security create-keychain -p cowboy123 cowboy-build.keychain || true`);
  execSync(`security default-keychain -s cowboy-build.keychain`);
  execSync(`security unlock-keychain -p cowboy123 cowboy-build.keychain`);
  execSync(`security import ${p12Path} -k cowboy-build.keychain -P cowboy123 -A`);
  execSync(`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k cowboy123 cowboy-build.keychain`);
  console.log('✅ Certificate installed in keychain');

  const appBundleResId = await ensureBundleId(BUNDLE_ID, 'Cowboy');

  console.log('📋 Creating provisioning profile...');
  const appProfile = await createProfile('Cowboy AppStore', appBundleResId, certId);

  const profilesDir = path.join(process.env.HOME, 'Library/MobileDevice/Provisioning Profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const appUUID = appProfile.attributes.uuid;
  fs.writeFileSync(path.join(profilesDir, `${appUUID}.mobileprovision`),
    Buffer.from(appProfile.attributes.profileContent, 'base64'));

  fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null',
    `APP_PROFILE_UUID=${appUUID}\n` +
    `APP_PROFILE_NAME=Cowboy AppStore\n`
  );

  console.log(`✅ Signing complete — profile UUID: ${appUUID}`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
