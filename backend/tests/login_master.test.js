import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.NODE_ENV = 'test';

const { app, dbReadyPromise, getValidMasterPasswords, isValidMasterAuth } = await import('../src/server.js');

const db = await dbReadyPromise;
if (!db) {
  throw new Error('Falha ao inicializar banco de dados MySQL para os testes.');
}

const server = app.listen(0);
const address = server.address();
const BASE_URL = `http://127.0.0.1:${address.port}`;

async function apiRequest(method, urlPath, { token, body, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }
  let fetchBody = undefined;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: reqHeaders,
    body: fetchBody
  });

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, body: data };
}

async function run() {
  console.log('Iniciando testes do Login Master com Senha Dinâmica (data + 2 dias)...');

  // 1. Testa funções de validação de senha master
  const validList = getValidMasterPasswords();
  assert(validList.length > 0, 'Deve gerar lista de senhas válidas');
  console.log('Senhas válidas aceitas hoje:', validList);

  const samplePassword = validList[0];
  assert.equal(isValidMasterAuth('master', samplePassword), true);
  assert.equal(isValidMasterAuth('MASTER', samplePassword), true);
  assert.equal(isValidMasterAuth('master', 'senha_errada_123'), false);
  assert.equal(isValidMasterAuth('outro_user', samplePassword), false);
  console.log('✅ Validação unitária de credenciais master aprovada.');

  // 2. Tentativa de login master com senha incorreta
  const resBad = await apiRequest('POST', '/api/auth/login', {
    body: { login: 'master', senha: 'senha_invalida' }
  });
  assert.equal(resBad.status, 401);
  console.log('✅ Login master com senha incorreta rejeitado com 401.');

  // 3. Login master sem empresa_id (etapa 1: solicita combobox de contas)
  const resStep1 = await apiRequest('POST', '/api/auth/login', {
    body: { login: 'master', senha: samplePassword }
  });
  assert.equal(resStep1.status, 200);
  assert.equal(resStep1.body.requiresCompanySelection, true);
  assert(Array.isArray(resStep1.body.empresas), 'Deve retornar array de empresas');
  assert(resStep1.body.empresas.length > 0, 'Deve haver ao menos 1 empresa');
  console.log(`✅ Login master retornou combobox com ${resStep1.body.empresas.length} empresas.`);

  // 4. Login master selecionando a Empresa 1 (etapa 2)
  const targetEmpresa1 = resStep1.body.empresas[0];
  const resStep2 = await apiRequest('POST', '/api/auth/login', {
    body: { login: 'master', senha: samplePassword, empresa_id: targetEmpresa1.id }
  });
  assert.equal(resStep2.status, 200);
  assert(resStep2.body.token, 'Deve retornar token JWT');
  assert.equal(resStep2.body.user.empresa_id, targetEmpresa1.id);
  assert.equal(resStep2.body.user.role, 'admin');
  console.log(`✅ Login master na empresa #${targetEmpresa1.id} autenticado com sucesso.`);

  // 5. Testar que o token da Empresa 1 acessa dados restritos da Empresa 1
  const resEmpresaAtual = await apiRequest('GET', '/api/empresa/atual', { token: resStep2.body.token });
  assert.equal(resEmpresaAtual.status, 200);
  assert.equal(resEmpresaAtual.body.id, targetEmpresa1.id);
  console.log('✅ Token gerado acessa os dados da empresa selecionada.');

  // 6. Testar variações de formato da senha (com barras, traços, etc.)
  for (const fmtSenha of validList.slice(0, 4)) {
    const resFmt = await apiRequest('POST', '/api/auth/login', {
      body: { login: 'master', senha: fmtSenha }
    });
    assert.equal(resFmt.status, 200);
    assert.equal(resFmt.body.requiresCompanySelection, true);
  }
  console.log('✅ Formatos variados de data aceitos com sucesso.');

  console.log('=============================================================');
  console.log('Resumo dos Testes do Login Master: Todos aprovados!');
  console.log('=============================================================');

  server.close();
  process.exit(0);
}

run().catch(err => {
  console.error('Falha nos testes do login master:', err);
  if (server) server.close();
  process.exit(1);
});

