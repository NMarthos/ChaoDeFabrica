import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.NODE_ENV = 'test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, dbReadyPromise } = await import('../src/server.js');
const { validateCPF, validateCNPJ, validatePhone, validateEmail, validateLogin, validatePassword } = await import('../src/server.js');

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
  return { status: res.status, data, headers: res.headers };
}

// Helpers para gerar CPFs e CNPJs válidos com dígitos verificadores corretos
function generateValidCPF() {
  const rnd = () => Math.floor(Math.random() * 9);
  const n = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
  let s1 = 0;
  for (let i = 0; i < 9; i++) s1 += n[i] * (10 - i);
  let r1 = 11 - (s1 % 11);
  const d1 = (r1 === 10 || r1 === 11) ? 0 : r1;
  n.push(d1);

  let s2 = 0;
  for (let i = 0; i < 10; i++) s2 += n[i] * (11 - i);
  let r2 = 11 - (s2 % 11);
  const d2 = (r2 === 10 || r2 === 11) ? 0 : r2;
  n.push(d2);

  return `${n[0]}${n[1]}${n[2]}.${n[3]}${n[4]}${n[5]}.${n[6]}${n[7]}${n[8]}-${n[9]}${n[10]}`;
}

function generateValidCNPJ() {
  const rnd = () => Math.floor(Math.random() * 9);
  const n = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), 0, 0, 0, 1];
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let s1 = 0;
  for (let i = 0; i < 12; i++) s1 += n[i] * w1[i];
  let r1 = s1 % 11;
  const d1 = r1 < 2 ? 0 : 11 - r1;
  n.push(d1);

  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let s2 = 0;
  for (let i = 0; i < 13; i++) s2 += n[i] * w2[i];
  let r2 = s2 % 11;
  const d2 = r2 < 2 ? 0 : 11 - r2;
  n.push(d2);

  return `${n[0]}${n[1]}.${n[2]}${n[3]}${n[4]}.${n[5]}${n[6]}${n[7]}/${n[8]}${n[9]}${n[10]}${n[11]}-${n[12]}${n[13]}`;
}

const results = [];
async function runTest(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`✅ PASS: ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error });
    console.error(`❌ FAIL: ${name}`);
    console.error(error);
  }
}

const createdCompanyIds = [];
const createdUserIds = [];

const suffix = Date.now();

try {
  // ==========================================================================
  // CENÁRIO 1: Validação de utilitários de CPF, CNPJ, DDD/Telefone, E-mail, Login e Senha
  // ==========================================================================
  await runTest('1. Validações de CPF, CNPJ, Telefone, E-mail, Login e Senha funcionam corretamente', async () => {
    // CPF
    assert.equal(validateCPF('111.111.111-11'), false, 'CPF com dígitos repetidos deve ser inválido');
    assert.equal(validateCPF('123.456.789-00'), false, 'CPF com dígitos verificadores errados deve ser inválido');
    const validCpf = generateValidCPF();
    assert.equal(validateCPF(validCpf), true, `CPF gerado ${validCpf} deve ser válido`);

    // CNPJ
    assert.equal(validateCNPJ('00.000.000/0000-00'), false, 'CNPJ com zeros repetidos deve ser inválido');
    assert.equal(validateCNPJ('12.345.678/0001-00'), false, 'CNPJ com dígitos verificadores errados deve ser inválido');
    const validCnpj = generateValidCNPJ();
    assert.equal(validateCNPJ(validCnpj), true, `CNPJ gerado ${validCnpj} deve ser válido`);

    // Telefone
    assert.equal(validatePhone('123'), false, 'Telefone curto deve ser inválido');
    assert.equal(validatePhone('(00) 99999-9999'), false, 'DDD 00 deve ser inválido');
    assert.equal(validatePhone('(11) 98765-4321'), true, 'Celular com DDD 11 deve ser válido');
    assert.equal(validatePhone('(11) 3456-7890'), true, 'Fixo com DDD 11 deve ser válido');

    // Email
    assert.equal(validateEmail('invalido'), false);
    assert.equal(validateEmail('teste@dominio.com.br'), true);

    // Login
    assert.equal(validateLogin('ab'), false, 'Login com menos de 3 chars deve ser inválido');
    assert.equal(validateLogin('joao.silva'), true);
    assert.equal(validateLogin('admin@empresa.com'), true);

    // Senha
    assert.equal(validatePassword('12345'), false, 'Senha menor que 6 chars deve ser inválida');
    assert.equal(validatePassword('123456'), true, 'Senha com 6 chars deve ser válida');
  });

  // ==========================================================================
  // CENÁRIO 2: Validação da Etapa 1 via API (/api/public/nova-conta/validar-etapa1)
  // ==========================================================================
  await runTest('2. Endpoint /api/public/nova-conta/validar-etapa1 valida campos obrigatórios e rejeita dados inválidos', async () => {
    // 2.1 Requisição vazia
    const resEmpty = await apiRequest('POST', '/api/public/nova-conta/validar-etapa1', { body: {} });
    assert.equal(resEmpty.status, 400);
    assert.ok(resEmpty.data.errors.tipo_pessoa);
    assert.ok(resEmpty.data.errors.nome);
    assert.ok(resEmpty.data.errors.cpf_cnpj);
    assert.ok(resEmpty.data.errors.telefone);
    assert.ok(resEmpty.data.errors.email);

    // 2.2 CPF inválido para Pessoa Física
    const resBadCpf = await apiRequest('POST', '/api/public/nova-conta/validar-etapa1', {
      body: {
        tipo_pessoa: 'Física',
        nome: 'João Teste',
        cpf_cnpj: '111.222.333-44',
        telefone: '(11) 98765-4321',
        email: 'joao@teste.com'
      }
    });
    assert.equal(resBadCpf.status, 400);
    assert.ok(resBadCpf.data.errors.cpf_cnpj);

    // 2.3 CNPJ inválido para Pessoa Jurídica
    const resBadCnpj = await apiRequest('POST', '/api/public/nova-conta/validar-etapa1', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: 'Empresa Teste',
        cpf_cnpj: '00.000.000/0001-99',
        telefone: '(11) 98765-4321',
        email: 'contato@empresa.com'
      }
    });
    assert.equal(resBadCnpj.status, 400);
    assert.ok(resBadCnpj.data.errors.cpf_cnpj);

    // 2.4 Dados válidos para Pessoa Física
    const validCpf = generateValidCPF();
    const resOkPf = await apiRequest('POST', '/api/public/nova-conta/validar-etapa1', {
      body: {
        tipo_pessoa: 'Física',
        nome: 'Titular Pessoa Física',
        cpf_cnpj: validCpf,
        telefone: '(11) 98888-7777',
        email: `pf.${suffix}@teste.com`
      }
    });
    assert.equal(resOkPf.status, 200);
    assert.equal(resOkPf.data.valid, true);

    // 2.5 Dados válidos para Pessoa Jurídica
    const validCnpj = generateValidCNPJ();
    const resOkPj = await apiRequest('POST', '/api/public/nova-conta/validar-etapa1', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: 'Marcenaria Alpha Ltda',
        cpf_cnpj: validCnpj,
        telefone: '(19) 3456-7890',
        email: `pj.${suffix}@teste.com`
      }
    });
    assert.equal(resOkPj.status, 200);
    assert.equal(resOkPj.data.valid, true);
  });

  // ==========================================================================
  // CENÁRIO 3: Criação atômica de conta e usuário master com vigência de 30 dias
  // ==========================================================================
  let empresa1Id = null;
  let login1 = `master.alpha.${suffix}`;
  let senha1 = 'MasterSecret123!';
  const cnpj1 = generateValidCNPJ();

  await runTest('3. Criação atômica de conta e usuário master com perfil Master, situação Ativado e vigência de 30 dias', async () => {
    const resCreate = await apiRequest('POST', '/api/public/nova-conta', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: `Marcenaria Alpha ${suffix} LTDA`,
        cpf_cnpj: cnpj1,
        telefone: '(11) 99887-6655',
        email: `contato.${suffix}@alpha.com`,
        login: login1,
        master_nome: 'Carlos Master Alpha',
        senha: senha1
      }
    });

    assert.equal(resCreate.status, 201, `Criação deve retornar 201: ${JSON.stringify(resCreate.data)}`);
    assert.equal(resCreate.data.success, true);
    assert.equal(resCreate.data.message, 'Conta criada com sucesso. Entre com seu login e senha.');
    // Garante que a senha não foi devolvida na resposta
    assert.equal(resCreate.data.senha, undefined);

    // Inspeção no banco de dados da empresa criada
    const empDb = await db.get('SELECT * FROM empresas WHERE cnpj = ?', [cnpj1]);
    assert.ok(empDb, 'Empresa deve ter sido gravada no banco');
    empresa1Id = empDb.id;
    createdCompanyIds.push(empresa1Id);

    assert.equal(empDb.tipo_pessoa, 'Jurídica');
    assert.equal(empDb.status, 'Ativo');
    assert.equal(empDb.ativo, 1);
    assert.ok(empDb.data_cadastro, 'data_cadastro da empresa deve estar preenchida');
    assert.ok(empDb.data_vigencia, 'data_vigencia da empresa deve estar preenchida');

    // Valida cálculo de vigência: exatamente 30 dias após cadastro
    const dtCad = new Date(empDb.data_cadastro);
    const dtVig = new Date(empDb.data_vigencia);
    const diffDays = Math.round((dtVig - dtCad) / (1000 * 60 * 60 * 24));
    assert.equal(diffDays, 30, 'Vigência da conta deve ser de exatamente 30 dias');

    // Inspeção do usuário master criado
    const userDb = await db.get('SELECT * FROM usuarios WHERE login = ?', [login1]);
    assert.ok(userDb, 'Usuário master deve ter sido gravado no banco');
    createdUserIds.push(userDb.id);

    assert.equal(userDb.empresa_id, empresa1Id, 'Usuário master deve estar estritamente vinculado à empresa criada');
    assert.equal(userDb.role, 'admin', 'Usuário master deve ter role admin da própria empresa');
    assert.equal(userDb.ativo, 1, 'Usuário master deve estar ativo');
    assert.equal(userDb.situacao, 'Ativado', 'Usuário master deve ter situacao = Ativado');
    assert.ok(userDb.data_cadastro, 'data_cadastro do master deve estar preenchida');
    assert.ok(userDb.data_vigencia, 'data_vigencia do master deve estar preenchida');

    // Valida que a senha NÃO está em texto puro no banco
    assert.notEqual(userDb.senha, senha1);
    assert.ok(await bcrypt.compare(senha1, userDb.senha), 'Senha deve coincidir com o hash bcrypt');

    // Valida que o perfil atribuído é o perfil Master da própria empresa
    const perfilDb = await db.get('SELECT * FROM perfis WHERE id = ?', [userDb.perfil_id]);
    assert.ok(perfilDb, 'Perfil do master deve existir');
    assert.equal(perfilDb.empresa_id, empresa1Id, 'Perfil deve pertencer à mesma empresa');
    assert.equal(perfilDb.nome, 'Master', 'Perfil deve ser o perfil Master da empresa');

    // Valida que foram gerados os defaults da empresa (serviços, parâmetros financeiros, etc.)
    const servicosCount = await db.get('SELECT COUNT(*) as cnt FROM servicos WHERE empresa_id = ?', [empresa1Id]);
    assert.ok(Number(servicosCount.cnt) > 0, 'Serviços padrão devem ter sido semeados para a nova empresa');
  });

  // ==========================================================================
  // CENÁRIO 4: Login do usuário master com credenciais criadas
  // ==========================================================================
  let tokenMaster1 = null;

  await runTest('4. Usuário master realiza login com sucesso pelo login criado e acessa apenas sua empresa', async () => {
    // 4.1 Login com senha errada falha (401)
    const loginFail = await apiRequest('POST', '/api/auth/login', {
      body: { login: login1, senha: 'SenhaErrada999!' }
    });
    assert.equal(loginFail.status, 401);

    // 4.2 Login com login correto tem sucesso (200)
    const loginOk = await apiRequest('POST', '/api/auth/login', {
      body: { login: login1, senha: senha1 }
    });
    assert.equal(loginOk.status, 200);
    assert.ok(loginOk.data.token, 'Token JWT deve ser gerado');
    assert.equal(loginOk.data.user.empresa_id, empresa1Id);
    assert.equal(loginOk.data.user.login, login1);
    assert.equal(loginOk.data.user.role, 'admin');
    tokenMaster1 = loginOk.data.token;

    // 4.3 Master lista clientes da sua empresa (começa vazio)
    const cliRes = await apiRequest('GET', '/api/clientes', { token: tokenMaster1 });
    assert.equal(cliRes.status, 200);
    assert.equal(cliRes.data.length, 0);

    // 4.4 Master cadastra um cliente na sua empresa
    const postCli = await apiRequest('POST', '/api/clientes', {
      token: tokenMaster1,
      body: { nome: 'Cliente Alpha 1', tipo_pessoa: 'Física', status: 'Ativo' }
    });
    assert.equal(postCli.status, 201);
    assert.equal(postCli.data.empresa_id, empresa1Id);
  });

  // ==========================================================================
  // CENÁRIO 5: Rejeição de login duplicado e de documento duplicado
  // ==========================================================================
  await runTest('5. Rejeição de login duplicado (inclusive case-insensitive) e documento duplicado', async () => {
    // Tentativa com o MESMO login em maiúsculas
    const dupLogin = await apiRequest('POST', '/api/public/nova-conta', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: 'Outra Empresa',
        cpf_cnpj: generateValidCNPJ(),
        telefone: '(11) 91111-2222',
        email: 'outro@email.com',
        login: login1.toUpperCase(),
        master_nome: 'Outro Master',
        senha: 'OutraSenha123!'
      }
    });
    assert.equal(dupLogin.status, 400);
    assert.ok(dupLogin.data.errors?.login);

    // Tentativa com o MESMO CNPJ já cadastrado
    const dupCnpj = await apiRequest('POST', '/api/public/nova-conta', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: 'Empresa Clonada',
        cpf_cnpj: cnpj1,
        telefone: '(11) 91111-2222',
        email: 'clonada@email.com',
        login: `outro.login.${suffix}`,
        master_nome: 'Outro Master',
        senha: 'OutraSenha123!'
      }
    });
    assert.equal(dupCnpj.status, 400);
    assert.ok(dupCnpj.data.errors?.cpf_cnpj);
  });

  // ==========================================================================
  // CENÁRIO 6: Dois cadastros distintos geram empresas e dados 100% isolados
  // ==========================================================================
  let empresa2Id = null;
  let login2 = `master.beta.${suffix}`;
  let senha2 = 'BetaSecret456!';
  const cnpj2 = generateValidCNPJ();
  let tokenMaster2 = null;

  await runTest('6. Dois cadastros distintos geram empresas independentes e dados isolados', async () => {
    const resCreateB = await apiRequest('POST', '/api/public/nova-conta', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: `Marcenaria Beta ${suffix} LTDA`,
        cpf_cnpj: cnpj2,
        telefone: '(21) 97777-6666',
        email: `contato.${suffix}@beta.com`,
        login: login2,
        master_nome: 'Bruna Master Beta',
        senha: senha2
      }
    });
    assert.equal(resCreateB.status, 201);

    const empB = await db.get('SELECT id FROM empresas WHERE cnpj = ?', [cnpj2]);
    empresa2Id = empB.id;
    createdCompanyIds.push(empresa2Id);
    assert.notEqual(empresa2Id, empresa1Id, 'Empresa 2 deve ter id diferente de Empresa 1');

    const userB = await db.get('SELECT id FROM usuarios WHERE login = ?', [login2]);
    createdUserIds.push(userB.id);

    // Login do Master 2
    const loginB = await apiRequest('POST', '/api/auth/login', {
      body: { login: login2, senha: senha2 }
    });
    assert.equal(loginB.status, 200);
    tokenMaster2 = loginB.data.token;

    // Master 2 não enxerga o cliente cadastrado pelo Master 1
    const cliResB = await apiRequest('GET', '/api/clientes', { token: tokenMaster2 });
    assert.equal(cliResB.status, 200);
    assert.equal(cliResB.data.length, 0, 'Master 2 não deve ver clientes da Empresa 1');

    // Master 2 cadastra cliente em sua empresa
    const postCliB = await apiRequest('POST', '/api/clientes', {
      token: tokenMaster2,
      body: { nome: 'Cliente Exclusivo Beta', tipo_pessoa: 'Jurídica', status: 'Ativo' }
    });
    assert.equal(postCliB.status, 201);
    assert.equal(postCliB.data.empresa_id, empresa2Id);

    // Master 1 continua vendo apenas o seu cliente
    const cliResA = await apiRequest('GET', '/api/clientes', { token: tokenMaster1 });
    assert.equal(cliResA.status, 200);
    assert.equal(cliResA.data.length, 1);
    assert.equal(cliResA.data[0].nome, 'Cliente Alpha 1');
    assert.equal(cliResA.data[0].empresa_id, empresa1Id);
  });

  // ==========================================================================
  // CENÁRIO 7: Tentativa de mass assignment (injeção de empresa_id, role, etc.)
  // ==========================================================================
  await runTest('7. Backend ignora tentativa de mass assignment no cadastro público (empresa_id, role, situacao, vigência)', async () => {
    const loginSpoof = `master.spoof.${suffix}`;
    const cnpjSpoof = generateValidCNPJ();

    const resSpoof = await apiRequest('POST', '/api/public/nova-conta', {
      body: {
        tipo_pessoa: 'Jurídica',
        nome: `Empresa Spoof ${suffix}`,
        cpf_cnpj: cnpjSpoof,
        telefone: '(11) 94444-5555',
        email: `spoof.${suffix}@teste.com`,
        login: loginSpoof,
        master_nome: 'Hacker Master',
        senha: 'HackerSecret123!',
        // Campos que o cliente malicioso tentaria injetar:
        empresa_id: 1,
        role: 'superadmin_global',
        situacao: 'Desativado',
        ativo: 0,
        data_vigencia: '2099-12-31 23:59:59'
      }
    });

    assert.equal(resSpoof.status, 201);

    const empSpoof = await db.get('SELECT * FROM empresas WHERE cnpj = ?', [cnpjSpoof]);
    assert.ok(empSpoof);
    createdCompanyIds.push(empSpoof.id);
    assert.notEqual(empSpoof.id, 1, 'Não deve vincular à empresa 1');

    const userSpoof = await db.get('SELECT * FROM usuarios WHERE login = ?', [loginSpoof]);
    assert.ok(userSpoof);
    createdUserIds.push(userSpoof.id);

    assert.equal(userSpoof.empresa_id, empSpoof.id, 'Usuário deve ser vinculado à empresa criada, ignorando empresa_id injetado');
    assert.equal(userSpoof.role, 'admin', 'Role deve ser admin da empresa, ignorando superadmin_global');
    assert.equal(userSpoof.situacao, 'Ativado', 'Situacao deve ser Ativado, ignorando valor injetado');
    assert.equal(userSpoof.ativo, 1, 'Ativo deve ser 1');

    // Vigência deve ser calculada estritamente pelo backend (~30 dias) e não 2099
    const dtVig = new Date(userSpoof.data_vigencia);
    const dtCad = new Date(userSpoof.data_cadastro);
    const diffDays = Math.round((dtVig - dtCad) / (1000 * 60 * 60 * 24));
    assert.equal(diffDays, 30, 'Vigência deve ser 30 dias ignorando ano 2099 injetado');
  });

} finally {
  // Limpeza das fixtures de teste
  try {
    for (const uid of createdUserIds) {
      await db.run('DELETE FROM usuarios WHERE id = ?', [uid]);
    }
    for (const eid of createdCompanyIds) {
      await db.run('DELETE FROM clientes WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM servicos WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM Material WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM Parametro_Financeiro WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM configuracoes_financeiras WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM formas_pagamento WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM condicoes_pagamento WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM parametros_empresa WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM perfil_funcoes WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM perfis WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM auditoria_logs WHERE empresa_id = ?', [eid]);
      await db.run('DELETE FROM empresas WHERE id = ?', [eid]);
    }
  } catch (cleanErr) {
    console.error('Aviso ao limpar fixtures de teste:', cleanErr.message);
  }
  server.close();
}

const failed = results.filter(r => !r.passed);
console.log(`\n=============================================================`);
console.log(`Resumo dos Testes do Fluxo Nova Conta: ${results.length - failed.length}/${results.length} aprovados.`);
console.log(`=============================================================\n`);

if (failed.length > 0) {
  process.exit(1);
}
process.exit(0);

