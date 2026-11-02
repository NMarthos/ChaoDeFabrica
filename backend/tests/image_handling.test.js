import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { resolveSafeUploadPath } from '../src/tenantContext.js';
import {
  uploadsBaseDir,
  candidateUploadDirs,
  findUploadPhysicalPath,
  getCompanyUploadDir
} from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Teste 1: resolveSafeUploadPath com múltiplos prefixos e segurança ---');
// Caminho padrão uploads/...
const r1 = resolveSafeUploadPath(uploadsBaseDir, 'uploads/empresa_1/produtos/teste.png');
assert(r1 !== null, 'Deveria resolver caminho uploads/empresa_1/produtos/teste.png');
assert.strictEqual(r1.normalizedRelPath, 'uploads/empresa_1/produtos/teste.png');

// Caminho com barra inicial /uploads/...
const r2 = resolveSafeUploadPath(uploadsBaseDir, '/uploads/empresa_1/produtos/teste.png');
assert(r2 !== null, 'Deveria resolver caminho /uploads/empresa_1/produtos/teste.png');
assert.strictEqual(r2.normalizedRelPath, 'uploads/empresa_1/produtos/teste.png');

// Caminho com prefixo /api/uploads/...
const r3 = resolveSafeUploadPath(uploadsBaseDir, '/api/uploads/empresa_1/produtos/teste.png');
assert(r3 !== null, 'Deveria resolver caminho /api/uploads/empresa_1/produtos/teste.png');
assert.strictEqual(r3.normalizedRelPath, 'uploads/empresa_1/produtos/teste.png');

// Caminho sem uploads/ inicial mas apontando para pasta de empresa
const r4 = resolveSafeUploadPath(uploadsBaseDir, 'empresa_1/parametros/logo.png');
assert(r4 !== null, 'Deveria resolver empresa_1/parametros/logo.png');
assert.strictEqual(r4.normalizedRelPath, 'uploads/empresa_1/parametros/logo.png');

// Bloqueio de Path Traversal
assert.strictEqual(resolveSafeUploadPath(uploadsBaseDir, '../etc/passwd'), null, 'Deve bloquear ..');
assert.strictEqual(resolveSafeUploadPath(uploadsBaseDir, '/uploads/../../config.json'), null, 'Deve bloquear traversal');
console.log('✔ Teste 1 passou!');

console.log('--- Teste 2: getCompanyUploadDir ---');
const dirParam = getCompanyUploadDir(1, 'parametros');
assert(dirParam.fullDir.includes('empresa_1'), 'fullDir deve conter empresa_1');
assert.strictEqual(dirParam.relPrefix, 'uploads/empresa_1/parametros');
assert(fs.existsSync(dirParam.fullDir), 'Diretório físico deve ter sido criado');
console.log('✔ Teste 2 passou!');

console.log('--- Teste 3: findUploadPhysicalPath com fallback entre candidatos ---');
// Cria um arquivo temporário em um diretório de uploads
const testFileRel = 'empresa_1/parametros/test_image.png';
const testFileFull = path.join(dirParam.fullDir, 'test_image.png');
fs.writeFileSync(testFileFull, Buffer.from('FAKE_PNG_HEADER'));

const foundPath = findUploadPhysicalPath(testFileRel);
assert(foundPath && fs.existsSync(foundPath), 'Deve encontrar o arquivo físico via findUploadPhysicalPath');
fs.unlinkSync(testFileFull);
console.log('✔ Teste 3 passou!');

console.log('--- Teste 4: getMediaUrl simulando ambiente frontend ---');
// Simula a função getMediaUrl do frontend
const mockGetMediaUrl = (imgPath, storageToken = 'erp_token_secret_123', shareToken = null) => {
  if (!imgPath) return '';
  if (imgPath.startsWith('http://') || imgPath.startsWith('https://') || imgPath.startsWith('blob:') || imgPath.startsWith('data:')) return imgPath;
  let clean = imgPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean.startsWith('uploads/') && !clean.startsWith('api/uploads/')) {
    if (clean.startsWith('empresa_') || clean.startsWith('produtos/') || clean.startsWith('anexos/') || clean.startsWith('parametros/') || clean.startsWith('layouts/')) {
      clean = `uploads/${clean}`;
    }
  }
  const baseUrl = `/${clean}`;

  if (clean.startsWith('uploads/') || clean.startsWith('api/uploads/')) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    if (shareToken) {
      return `${baseUrl}${sep}share_token=${encodeURIComponent(shareToken)}`;
    }
    const jwtToken = storageToken;
    if (jwtToken) {
      return `${baseUrl}${sep}token=${encodeURIComponent(jwtToken)}`;
    }
  }
  return baseUrl;
};

// Teste com caminho relativo com 'uploads/'
const url1 = mockGetMediaUrl('uploads/empresa_1/produtos/chapa.jpg');
assert.strictEqual(url1, '/uploads/empresa_1/produtos/chapa.jpg?token=erp_token_secret_123');

// Teste com caminho sem 'uploads/'
const url2 = mockGetMediaUrl('empresa_1/parametros/logo.png');
assert.strictEqual(url2, '/uploads/empresa_1/parametros/logo.png?token=erp_token_secret_123');

// Teste com barra inicial
const url3 = mockGetMediaUrl('/uploads/empresa_1/produtos/chapa.jpg');
assert.strictEqual(url3, '/uploads/empresa_1/produtos/chapa.jpg?token=erp_token_secret_123');

// Teste de proposta pública
const urlPub = mockGetMediaUrl('uploads/empresa_1/parametros/logo.png', null, 'pub_share_xyz');
assert.strictEqual(urlPub, '/uploads/empresa_1/parametros/logo.png?share_token=pub_share_xyz');

console.log('✔ Teste 4 passou!');

console.log('\nTODOS OS TESTES DE TRATAMENTO DE IMAGENS PASSARAM COM SUCESSO!');
process.exit(0);
