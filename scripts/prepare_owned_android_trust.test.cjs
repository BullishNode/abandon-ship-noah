const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { prepare } = require("./prepare_owned_signet_routing.cjs");
const { trustFiles, apply } = require("./prepare_owned_android_trust.cjs");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const ca = fs.readFileSync(path.join(__dirname, "test-fixtures/synthetic-qualification-ca.crt"));
const sdk = "a".repeat(40), nitro = "b".repeat(40), profile = "track-a-two-step-per-key";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-trust-software-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, data) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), {recursive:true});fs.writeFileSync(p,data);return p; };
  const data = {schema:1,profile,network:"signet",genesis:"00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",server_pubkey:"02"+"c".repeat(64),sdk_commit:sdk,nitro_commit:nitro,api_url:"https://noah.example.test",lnurl_domain:"noah.example.test",blockheight_url:"https://noah.example.test/height",wallet:{ark:"http://127.0.0.1:3535",bitcoind:"http://127.0.0.1:18443",bitcoind_user:"synthetic-role",bitcoind_pass:"synthetic-software-token",vtxo_refresh_expiry_threshold:12,fallback_fee_rate:10000,htlc_recv_claim_delta:18,vtxo_exit_margin:12,round_tx_required_confirmations:2}};
  const bytes=Buffer.from(JSON.stringify(data)), original={mainnet:{preserved:true},regtest:{preserved:true},signet:{}};
  const env={NOAH_ARK_PROFILE:profile,EXPO_PUBLIC_NOAH_PROFILE:profile,NOAH_A_ROUTING_MANIFEST:put("manifest.json",bytes),NOAH_A_ROUTING_SHA256:sha(bytes),NOAH_ARK_SDK_COMMIT:sdk,NOAH_ARK_NITRO_COMMIT:nitro,NOAH_A_CA_FILE:put("test-ca.pem",ca),NOAH_A_CA_SHA256:sha(ca)};
  const p=prepare(bytes,sha(bytes),sdk,nitro,original);
  put("client/src/owned-signet-routing.json",p.js);put("client/nitromodules/noah-tools/android/src/main/assets/noah_bark_config.json",p.android);
  put("client/android/app/src/signet/AndroidManifest.xml",'<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application><receiver tools:node="remove" /></application></manifest>');
  return {root,env,put,out:path.join(root,"client/android/app/owned-a-trust")};
}
test("actual X509 CA and matching prepared inputs produce qualification-only Android files",t=>{
 const f=fixture(t),x=apply(f.root,"prepare",f.env);assert.equal(x.transport_or_payment_ready,false);assert.deepEqual(apply(f.root,"check",f.env),x);
 const xml=fs.readFileSync(path.join(f.out,"res/xml/noah_a_network_security_config.xml"),"utf8");assert.ok(xml.includes('@raw/noah_a_qualification_ca'));assert.ok(!xml.includes('src="system"'));assert.ok(!xml.includes('src="user"'));assert.ok(xml.includes('cleartextTrafficPermitted="false"'));
 assert.ok(fs.readFileSync(path.join(f.out,"AndroidManifest.xml"),"utf8").includes('tools:node="remove"'));
});
for(const [name,change] of [
 ["wrong CA pin",f=>f.env.NOAH_A_CA_SHA256="0".repeat(64)],
 ["partial profile",f=>delete f.env.EXPO_PUBLIC_NOAH_PROFILE],
 ["wrong SDK",f=>f.env.NOAH_ARK_SDK_COMMIT="d".repeat(40)],
 ["JS differs",f=>f.put("client/src/owned-signet-routing.json","null")],
 ["native routing differs",f=>{const p="client/nitromodules/noah-tools/android/src/main/assets/noah_bark_config.json";const d=JSON.parse(fs.readFileSync(path.join(f.root,p)));d.signet.ark="http://127.0.0.1:9999";f.put(p,JSON.stringify(d,null,2)+"\n");}],
 ["malformed CA",f=>{f.env.NOAH_A_CA_FILE=f.put("bad.pem","bad");f.env.NOAH_A_CA_SHA256=sha(Buffer.from("bad"));}],
]) test(name+" refuses before generation",t=>{const f=fixture(t);change(f);assert.throws(()=>apply(f.root,"prepare",f.env));assert.equal(fs.existsSync(f.out),false);});
test("expired actual CA refuses",t=>{const f=fixture(t);assert.throws(()=>trustFiles(f.root,f.env,Date.parse(new crypto.X509Certificate(ca).validTo)+1),/valid CA/);});
test("tampered system trust cannot pass check",t=>{const f=fixture(t);apply(f.root,"prepare",f.env);fs.writeFileSync(path.join(f.out,"res/xml/noah_a_network_security_config.xml"),'<certificates src="system"/>');assert.throws(()=>apply(f.root,"check",f.env),/differs/);});
test("missing partial generated CA refuses check",t=>{const f=fixture(t);apply(f.root,"prepare",f.env);fs.unlinkSync(path.join(f.out,"res/raw/noah_a_qualification_ca.pem"));assert.throws(()=>apply(f.root,"check",f.env));});
test("stale preparation cannot be overwritten",t=>{const f=fixture(t);apply(f.root,"prepare",f.env);const p=path.join(f.out,"preparation-receipt.json"),before=fs.readFileSync(p);assert.throws(()=>apply(f.root,"prepare",f.env));assert.deepEqual(fs.readFileSync(p),before);});

test("oversize actual manifest refuses before generation even with its correct hash",t=>{const f=fixture(t),b=Buffer.alloc(65537,32);f.env.NOAH_A_ROUTING_MANIFEST=f.put("oversize-manifest",b);f.env.NOAH_A_ROUTING_SHA256=sha(b);assert.throws(()=>apply(f.root,"prepare",f.env),/Bounded regular/);assert.equal(fs.existsSync(f.out),false);});
test("oversize actual generated file refuses bounded check",t=>{const f=fixture(t);apply(f.root,"prepare",f.env);fs.writeFileSync(path.join(f.out,"res/raw/noah_a_qualification_ca.pem"),Buffer.alloc(65537,32));assert.throws(()=>apply(f.root,"check",f.env),/Bounded regular/);});
