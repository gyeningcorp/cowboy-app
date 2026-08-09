#!/usr/bin/env node
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const KEY_ID    = process.env.ASC_KEY_ID;
const ISSUER_ID = process.env.ASC_ISSUER_ID;
const KEY_PATH  = process.env.ASC_KEY_PATH;
const APP_ID    = '6789995023';

function makeJWT() {
  const privKey = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg:'ES256', kid:KEY_ID, typ:'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss:ISSUER_ID, iat:now, exp:now+1200, aud:'appstoreconnect-v1' })).toString('base64url');
  const s = crypto.createSign('SHA256'); s.update(h+'.'+p);
  return `${h}.${p}.${s.sign({ key:privKey, dsaEncoding:'ieee-p1363' }).toString('base64url')}`;
}

function api(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.appstoreconnect.apple.com',
      path, method: 'GET',
      headers: { Authorization: `Bearer ${makeJWT()}`, 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.end();
  });
}

async function main() {
  console.log(`\n=== COWS AND BOYS — ASC STATUS (App ID: ${APP_ID}) ===\n`);

  const versR = await api(`/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=5`);
  const versions = versR.body.data || [];
  console.log('--- App Store Versions ---');
  for (const v of versions) {
    const a = v.attributes;
    console.log(`  ${a.versionString} | ${a.appVersionState ?? a.appStoreState} | created: ${a.createdDate ?? 'n/a'}`);
  }

  const buildsR = await api(`/v1/builds?filter[app]=${APP_ID}&sort=-uploadedDate&limit=5&fields[builds]=version,uploadedDate,processingState`);
  const builds = buildsR.body.data || [];
  console.log('\n--- Recent Builds ---');
  for (const b of builds) {
    const a = b.attributes;
    console.log(`  build ${a.version} | ${a.processingState} | uploaded: ${a.uploadedDate}`);
  }

  console.log('\n--- Beta Review (TestFlight external) ---');
  const latest = builds[0];
  if (latest) {
    const bd = await api(`/v1/builds/${latest.id}/buildBetaDetail`);
    const ext = bd.body?.data?.attributes?.externalBuildState ?? 'n/a';
    const bar = await api(`/v1/builds/${latest.id}/betaAppReviewSubmission`);
    const barState = bar.body?.data?.attributes?.betaReviewState ?? 'n/a';
    console.log(`  build ${latest.attributes.version} | betaReview: ${barState} | externalState: ${ext}`);
  } else {
    console.log('  no builds found');
  }

  const subR = await api(`/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=IOS&limit=5`);
  console.log('\n--- Review Submissions ---');
  for (const s of (subR.body.data || [])) {
    console.log(`  ${s.id} | state: ${s.attributes.state} | submitted: ${s.attributes.submittedDate ?? 'n/a'}`);
  }
  console.log('');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
