import fs from 'fs';
import path from 'path';
import { X509Certificate, createPrivateKey } from 'crypto';
import { generate } from 'selfsigned';

export interface RemoteTls { key: string; cert: string }

// A fresh installation creates its own identity. Never ship private keys in source.
export async function loadRemoteTls(dataDir: string): Promise<RemoteTls> {
  const filename = path.join(dataDir, 'remote-tls.json');
  if (fs.existsSync(filename)) {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8')) as RemoteTls;
    const certificate = new X509Certificate(saved.cert);
    if (!certificate.checkPrivateKey(createPrivateKey(saved.key))) {
      throw new Error('Remote TLS certificate does not match its private key');
    }
    if (Date.parse(certificate.validTo) > Date.now() + 86400000) {
      if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
      return saved;
    }
  }
  const pems = await generate([{ name: 'commonName', value: 'ConeCode Remote' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
      ] },
    ],
  });
  const tls = { key: pems.private, cert: pems.cert };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(tls), { mode: 0o600 });
  fs.renameSync(temporary, filename);
  return tls;
}
