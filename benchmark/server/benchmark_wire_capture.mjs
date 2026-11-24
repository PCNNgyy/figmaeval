import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { fingerprint } from "./benchmark_protocol.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function captureWireRequest(runDir, source, forwarded, requestPath, profileHash) {
  const value = { kind: "benchmark-wire-request/v1", method: "POST", path: requestPath,
    profile_hash: profileHash, source, forwarded };
  const bytes = Buffer.from(JSON.stringify(value)), digest = sha(bytes);
  const relative = `wire-request-captures/${digest}.json.gz`, file = path.join(runDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, gzipSync(bytes, { level: 1 }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (sha(gunzipSync(fs.readFileSync(file), { maxOutputLength: 128 * 1024 * 1024 })) !== digest) throw new Error("Wire request capture changed");
  }
  return { kind: value.kind, file: relative, sha256: digest,
    source_json_sha256: fingerprint(source), forwarded_json_sha256: fingerprint(forwarded) };
}

export function readWireRequest(runDir, receipt) {
  const proof = receipt?.wire_request;
  if (!proof) return null;
  if (proof.kind !== "benchmark-wire-request/v1" || !/^[a-f0-9]{64}$/.test(proof.sha256 || "")
    || proof.file !== `wire-request-captures/${proof.sha256}.json.gz`) throw new Error("Invalid wire request proof");
  const root = fs.realpathSync(runDir), file = path.join(root, proof.file);
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()
    || path.relative(root, fs.realpathSync(file)).startsWith("..")) throw new Error("Wire request proof escapes its run");
  const bytes = gunzipSync(fs.readFileSync(file), { maxOutputLength: 128 * 1024 * 1024 });
  if (sha(bytes) !== proof.sha256) throw new Error("Wire request bytes changed");
  const value = JSON.parse(bytes);
  if (value.kind !== proof.kind || value.method !== "POST" || value.path !== receipt.path
    || value.profile_hash !== receipt.profile_hash || !Array.isArray(value.source?.messages)
    || fingerprint(value.source) !== proof.source_json_sha256 || fingerprint(value.forwarded) !== proof.forwarded_json_sha256
    || proof.source_json_sha256 !== receipt.source_json_sha256 || proof.forwarded_json_sha256 !== receipt.forwarded_json_sha256) {
    throw new Error("Wire request does not match its forwarding receipt");
  }
  return value;
}
