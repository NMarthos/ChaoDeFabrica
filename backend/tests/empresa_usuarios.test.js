import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.NODE_ENV = 'test';

const { app, dbReadyPromise, JWT_SECRET } = await import('../src/server.js');

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

function generateValidCNPJ() {
  const rnd = () => Math.floor(Math.random() * 9);
  const n = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), 0, 0, 0, 1];
  let d1 = 0;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (let i = 0; i < 12; i++) d1 += n[i] * w1[i];
  d1 = 11 - (d1 % 11);
  if (d1 >= 10) d1 = 0;
  n.push(d1);
  let d2 = 0;
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (let i = 0; i < 13; i++) d2 += n[i] * w2[i];
  d2 = 11 - (d2 % 11);
  if (d2 >= 10) d2 = 0;
  n.push(d2);
  const s = n.join('');
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
}

async function run() {
  console.log('Iniciando testes dos endpoints de Dados da Empresa e Gestão de Usuários...');

  // Obter uma empresa existente para testar
  const empresa = await db.get('SELECT * FROM empresas LIMIT 1');
  assert(empresa, 'Deve existir uma empresa para os testes');

  // Gerar token de admin dessa empresa
  const adminUser = await db.get('SELECT * FROM usuarios WHERE empresa_id = ? AND role = "admin" LIMIT 1', [empresa.id]);
  const token = jwt.sign(
    { id: adminUser.id, email: adminUser.email, role: 'admin', empresa_id: empresa.id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 1. GET /api/empresa/atual
  const resGetEmpresa = await apiRequest('GET', '/api/empresa/atual', { token });
  assert.strictEqual(resGetEmpresa.status, 200);
  assert.strictEqual(resGetEmpresa.body.id, empresa.id);
  console.log('✅ GET /api/empresa/atual funcionou com sucesso.');

  // 2. PUT /api/empresa/atual
  const originalNome = resGetEmpresa.body.razao_social;
  const validCnpj = generateValidCNPJ();
  const resPutEmpresa = await apiRequest('PUT', '/api/empresa/atual', {
    token,
    body: {
      razao_social: originalNome,
      nome_fantasia: 'Nome Fantasia Atualizado',
      tipo_pessoa: 'Jurídica',
      cpf_cnpj: validCnpj,
      telefone: '(11) 98888-7777',
      email: 'contato@empresa.com'
    }
  });
  if (resPutEmpresa.status !== 200) {
    console.error('Erro no PUT empresa:', resPutEmpresa.body);
  }
  assert.strictEqual(resPutEmpresa.status, 200);
  assert.strictEqual(resPutEmpresa.body.nome_fantasia, 'Nome Fantasia Atualizado');
  console.log('✅ PUT /api/empresa/atual funcionou com sucesso.');

  // 3. Gestão de usuários: Listar
  const resGetUsers = await apiRequest('GET', '/api/usuarios', { token });
  assert.strictEqual(resGetUsers.status, 200);
  assert(Array.isArray(resGetUsers.body));
  console.log(`✅ GET /api/usuarios retornou ${resGetUsers.body.length} usuários.`);

  // 4. Gestão de usuários: Criar usuário
  const testEmail = `user_teste_${Date.now()}@exemplo.com`;
  const testLogin = `usertest_${Date.now()}`;
  const resPostUser = await apiRequest('POST', '/api/usuarios', {
    token,
    body: {
      nome: 'Usuário Criado Teste',
      login: testLogin,
      email: testEmail,
      senha: 'password123',
      role: 'user',
      ativo: 1
    }
  });
  assert.strictEqual(resPostUser.status, 201);
  const createdUserId = resPostUser.body.id;
  assert(createdUserId, 'Deve retornar ID do usuário criado');
  assert.strictEqual(resPostUser.body.login, testLogin);
  console.log('✅ POST /api/usuarios criou o usuário com login e senha.');

  // 5. Gestão de usuários: Atualizar
  const resPutUser = await apiRequest('PUT', `/api/usuarios/${createdUserId}`, {
    token,
    body: {
      nome: 'Usuário Nome Atualizado',
      ativo: 0
    }
  });
  assert.strictEqual(resPutUser.status, 200);
  assert.strictEqual(resPutUser.body.nome, 'Usuário Nome Atualizado');
  assert.strictEqual(resPutUser.body.ativo, 0);
  console.log('✅ PUT /api/usuarios/:id atualizou o usuário com sucesso.');

  // 6. Gestão de usuários: Excluir
  const resDelUser = await apiRequest('DELETE', `/api/usuarios/${createdUserId}`, { token });
  assert.strictEqual(resDelUser.status, 200);
  console.log('✅ DELETE /api/usuarios/:id excluiu o usuário.');

  console.log('=============================================================');
  console.log('Resumo dos Testes de Empresa e Usuários: Todos aprovados!');
  console.log('=============================================================');

  server.close();
  process.exit(0);
}

run().catch(err => {
  console.error('Falha nos testes:', err);
  if (server) server.close();
  process.exit(1);
});
