import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, dbReadyPromise, uploadsBaseDir, JWT_SECRET } = await import('../src/server.js');
const { seedCompanyDefaults } = await import('../src/db.js');
const { precheckMultiTenantState, MigrationConflictError, TABLE_CLASSIFICATION } = await import('../src/migrations.js');

const db = await dbReadyPromise;
if (!db) {
  throw new Error('Falha ao inicializar banco de dados MySQL para os testes.');
}

const server = app.listen(0);
const address = server.address();
const BASE_URL = `http://127.0.0.1:${address.port}`;

async function apiRequest(method, urlPath, { token, body, headers = {}, rawResponse = false } = {}) {
  const reqHeaders = { ...headers };
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }
  let fetchBody = undefined;
  if (body !== undefined) {
    if (body instanceof FormData) {
      fetchBody = body;
    } else {
      reqHeaders['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }
  }

  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: reqHeaders,
    body: fetchBody
  });

  if (rawResponse) return res;

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data, headers: res.headers };
}

const results = [];
async function runTest(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`✅ PASS: ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: err });
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
  }
}

// ============================================================================
// SETUP TEST FIXTURES FOR EMPRESA A AND EMPRESA B
// ============================================================================
const suffix = Date.now();
let empAId, empBId, empInativaId;
let adminAToken, adminBToken, userAToken;
let adminAId, adminBId, userAId, inactiveUserId;
let perfilAdminAId, perfilOperadorAId, perfilAdminBId;
let clienteAId, clienteBId;
let orcamentoANum, orcamentoBNum;
let projetoAId, projetoBId;
let contratoAId, contratoBId;
let servicoAId, servicoBId;
let anexoAId, anexoBId, anexoBCaminho;
let shareTokenA, shareTokenB;
let fluxoAId, fluxoBId;

async function setupFixtures() {
  // Create Empresa A, Empresa B, and Empresa Inativa
  const resEmpA = await db.run(
    `INSERT INTO empresas (razao_social, nome_fantasia, cnpj, status) VALUES (?, ?, ?, 'Ativo')`,
    [`Empresa Teste A ${suffix} LTDA`, `Empresa A ${suffix}`, `91.${String(suffix).slice(-8)}/0001-01`]
  );
  empAId = resEmpA.lastID;

  const resEmpB = await db.run(
    `INSERT INTO empresas (razao_social, nome_fantasia, cnpj, status) VALUES (?, ?, ?, 'Ativo')`,
    [`Empresa Teste B ${suffix} LTDA`, `Empresa B ${suffix}`, `92.${String(suffix).slice(-8)}/0001-02`]
  );
  empBId = resEmpB.lastID;

  const resEmpInativa = await db.run(
    `INSERT INTO empresas (razao_social, nome_fantasia, cnpj, status) VALUES (?, ?, ?, 'Inativo')`,
    [`Empresa Inativa ${suffix} LTDA`, `Empresa Inativa ${suffix}`, `93.${String(suffix).slice(-8)}/0001-03`]
  );
  empInativaId = resEmpInativa.lastID;

  await seedCompanyDefaults(db, empAId, {
    razaoSocial: `Empresa Teste A ${suffix} LTDA`,
    nomeFantasia: `Empresa A ${suffix}`,
    cnpj: `91.${String(suffix).slice(-8)}/0001-01`
  });

  await seedCompanyDefaults(db, empBId, {
    razaoSocial: `Empresa Teste B ${suffix} LTDA`,
    nomeFantasia: `Empresa B ${suffix}`,
    cnpj: `92.${String(suffix).slice(-8)}/0001-02`
  });

  const pAdminA = await db.get(`SELECT id FROM perfis WHERE empresa_id = ? AND nome = 'Administrador' LIMIT 1`, [empAId]);
  const pOpA = await db.get(`SELECT id FROM perfis WHERE empresa_id = ? AND nome = 'Comercial' LIMIT 1`, [empAId]);
  const pAdminB = await db.get(`SELECT id FROM perfis WHERE empresa_id = ? AND nome = 'Administrador' LIMIT 1`, [empBId]);
  perfilAdminAId = pAdminA.id;
  perfilOperadorAId = pOpA.id;
  perfilAdminBId = pAdminB.id;

  const passHash = await bcrypt.hash('SenhaForte123!', 10);

  const uAdminA = await db.run(
    `INSERT INTO usuarios (empresa_id, perfil_id, nome, email, senha, role, ativo) VALUES (?, ?, ?, ?, ?, 'admin', 1)`,
    [empAId, perfilAdminAId, 'Admin Empresa A', `admin.a.${suffix}@teste.com`, passHash]
  );
  adminAId = uAdminA.lastID;

  const uUserA = await db.run(
    `INSERT INTO usuarios (empresa_id, perfil_id, nome, email, senha, role, ativo) VALUES (?, ?, ?, ?, ?, 'user', 1)`,
    [empAId, perfilOperadorAId, 'Operador Empresa A', `op.a.${suffix}@teste.com`, passHash]
  );
  userAId = uUserA.lastID;

  const uAdminB = await db.run(
    `INSERT INTO usuarios (empresa_id, perfil_id, nome, email, senha, role, ativo) VALUES (?, ?, ?, ?, ?, 'admin', 1)`,
    [empBId, perfilAdminBId, 'Admin Empresa B', `admin.b.${suffix}@teste.com`, passHash]
  );
  adminBId = uAdminB.lastID;

  const uInactive = await db.run(
    `INSERT INTO usuarios (empresa_id, perfil_id, nome, email, senha, role, ativo) VALUES (?, ?, ?, ?, ?, 'user', 0)`,
    [empAId, perfilOperadorAId, 'Inativo A', `inativo.a.${suffix}@teste.com`, passHash]
  );
  inactiveUserId = uInactive.lastID;

  // Login via real endpoint to obtain authentic JWT tokens
  const loginA = await apiRequest('POST', '/api/auth/login', {
    body: { email: `admin.a.${suffix}@teste.com`, password: 'SenhaForte123!' }
  });
  assert.equal(loginA.status, 200, 'Login Admin A deve retornar 200');
  adminAToken = loginA.data.token;

  const loginOpA = await apiRequest('POST', '/api/auth/login', {
    body: { email: `op.a.${suffix}@teste.com`, password: 'SenhaForte123!' }
  });
  assert.equal(loginOpA.status, 200, 'Login Operador A deve retornar 200');
  userAToken = loginOpA.data.token;

  const loginB = await apiRequest('POST', '/api/auth/login', {
    body: { email: `admin.b.${suffix}@teste.com`, password: 'SenhaForte123!' }
  });
  assert.equal(loginB.status, 200, 'Login Admin B deve retornar 200');
  adminBToken = loginB.data.token;
}

async function cleanupFixtures() {
  try {
    await db.exec('SET FOREIGN_KEY_CHECKS = 0');
    for (const empId of [empAId, empBId, empInativaId].filter(Boolean)) {
      for (const t of TABLE_CLASSIFICATION.TENANT_TABLES) {
        await db.run(`DELETE FROM \`${t}\` WHERE empresa_id = ?`, [empId]);
      }
      await db.run(`DELETE FROM auditoria_logs WHERE empresa_id = ?`, [empId]);
      await db.run(`DELETE FROM empresas WHERE id = ?`, [empId]);
      const empUploadDir = path.join(uploadsBaseDir, `empresa_${empId}`);
      if (fs.existsSync(empUploadDir)) {
        fs.rmSync(empUploadDir, { recursive: true, force: true });
      }
    }
    await db.exec('SET FOREIGN_KEY_CHECKS = 1');
  } catch (e) {
    console.error('Erro na limpeza de fixtures:', e);
  }
}

try {
  await setupFixtures();

  // ==========================================================================
  // CENÁRIO 1: Isolamento de listagens e cadastros entre Empresa A e Empresa B
  // ==========================================================================
  await runTest('1. Usuário da Empresa A lista apenas registros da Empresa A; usuário da Empresa B lista apenas registros da Empresa B', async () => {
    // Criar Cliente A e Cliente B
    const cA = await apiRequest('POST', '/api/clientes', {
      token: adminAToken,
      body: { nome: 'Cliente Exclusivo A', tipo_pessoa: 'Jurídica', documento: '11.111.111/0001-11', status: 'Ativo' }
    });
    assert.equal(cA.status, 201);
    clienteAId = cA.data.id;
    assert.equal(cA.data.empresa_id, empAId);

    const cB = await apiRequest('POST', '/api/clientes', {
      token: adminBToken,
      body: { nome: 'Cliente Exclusivo B', tipo_pessoa: 'Jurídica', documento: '22.222.222/0001-22', status: 'Ativo' }
    });
    assert.equal(cB.status, 201);
    clienteBId = cB.data.id;
    assert.equal(cB.data.empresa_id, empBId);

    // Criar Produto/Material com a MESMA referência em A e B (testando unicidade composta (empresa_id, MaterialReferencia))
    const prodA = await apiRequest('POST', '/api/produtos', {
      token: adminAToken,
      body: { MaterialReferencia: 'MDF.TESTE.01', MaterialDescricao: 'MDF Branco Empresa A', MaterialUnidade: 'CHP', MaterialValorUnitario: 200, ProdutoGrupo: 1 }
    });
    assert.equal(prodA.status, 201);

    const prodB = await apiRequest('POST', '/api/produtos', {
      token: adminBToken,
      body: { MaterialReferencia: 'MDF.TESTE.01', MaterialDescricao: 'MDF Preto Empresa B', MaterialUnidade: 'CHP', MaterialValorUnitario: 350, ProdutoGrupo: 1 }
    });
    assert.equal(prodB.status, 201);

    // Criar Contrato com o MESMO número em A e B (testando unicidade composta (empresa_id, numero))
    const ctrA = await apiRequest('POST', '/api/contratos', {
      token: adminAToken,
      body: { cliente_id: clienteAId, numero: 'CTR-0001', valor: 15000, data_inicio: '2026-01-01', data_fim: '2026-06-01', status: 'Ativo' }
    });
    assert.equal(ctrA.status, 201);
    contratoAId = ctrA.data.id;

    const ctrB = await apiRequest('POST', '/api/contratos', {
      token: adminBToken,
      body: { cliente_id: clienteBId, numero: 'CTR-0001', valor: 42000, data_inicio: '2026-01-01', data_fim: '2026-06-01', status: 'Ativo' }
    });
    assert.equal(ctrB.status, 201);
    contratoBId = ctrB.data.id;

    // Criar Orçamento e Projeto em A e B
    const orcA = await apiRequest('POST', '/api/orcamentos', {
      token: adminAToken,
      body: { cliente_id: clienteAId, descricao: 'Orçamento Cozinha A' }
    });
    assert.equal(orcA.status, 201);
    orcamentoANum = orcA.data.numero;

    const orcB = await apiRequest('POST', '/api/orcamentos', {
      token: adminBToken,
      body: { cliente_id: clienteBId, descricao: 'Orçamento Dormitório B' }
    });
    assert.equal(orcB.status, 201);
    orcamentoBNum = orcB.data.numero;

    const prjA = await apiRequest('POST', '/api/projetos', {
      token: adminAToken,
      body: { orcamento_numero: orcamentoANum, nome: 'Projeto Cozinha A', DuracaoMontagem: 2 }
    });
    assert.equal(prjA.status, 201);
    projetoAId = prjA.data.id;

    const prjB = await apiRequest('POST', '/api/projetos', {
      token: adminBToken,
      body: { orcamento_numero: orcamentoBNum, nome: 'Projeto Dormitório B', DuracaoMontagem: 4 }
    });
    assert.equal(prjB.status, 201);
    projetoBId = prjB.data.id;

    // Verificar listagens de A
    const listClientesA = await apiRequest('GET', '/api/clientes', { token: adminAToken });
    assert.equal(listClientesA.status, 200);
    assert.ok(listClientesA.data.every(c => c.empresa_id === empAId));
    assert.ok(listClientesA.data.some(c => c.id === clienteAId));
    assert.ok(!listClientesA.data.some(c => c.id === clienteBId));

    // Verificar listagens de B
    const listClientesB = await apiRequest('GET', '/api/clientes', { token: adminBToken });
    assert.equal(listClientesB.status, 200);
    assert.ok(listClientesB.data.every(c => c.empresa_id === empBId));
    assert.ok(listClientesB.data.some(c => c.id === clienteBId));
    assert.ok(!listClientesB.data.some(c => c.id === clienteAId));

    // Verificar listagens de Orçamentos e Projetos
    const listOrcA = await apiRequest('GET', '/api/orcamentos', { token: adminAToken });
    assert.ok(listOrcA.data.every(o => o.empresa_id === empAId));
    assert.ok(!listOrcA.data.some(o => o.numero === orcamentoBNum));

    const listProjB = await apiRequest('GET', '/api/projetos', { token: adminBToken });
    assert.ok(listProjB.data.every(p => p.empresa_id === empBId));
    assert.ok(!listProjB.data.some(p => p.id === projetoAId));
  });

  // ==========================================================================
  // CENÁRIO 2: Busca, filtros e indicadores de cada empresa
  // ==========================================================================
  await runTest('2. Busca, filtros e indicadores de cada empresa retornam apenas seus próprios dados e totais', async () => {
    const statsA = await apiRequest('GET', '/api/dashboard/stats', { token: adminAToken });
    assert.equal(statsA.status, 200);
    assert.equal(statsA.data.clientesAtivos, 1);
    assert.equal(statsA.data.totalContratos, 1);
    assert.equal(Number(statsA.data.faturamentoMensal), 15000);

    const statsB = await apiRequest('GET', '/api/dashboard/stats', { token: adminBToken });
    assert.equal(statsB.status, 200);
    assert.equal(statsB.data.clientesAtivos, 1);
    assert.equal(statsB.data.totalContratos, 1);
    assert.equal(Number(statsB.data.faturamentoMensal), 42000);
  });

  // ==========================================================================
  // CENÁRIO 3: Acesso cruzado por ID (GET, PUT, DELETE) bloqueado com 404
  // ==========================================================================
  await runTest('3. Usuário da Empresa A tenta consultar, editar e excluir registros da Empresa B por ID e recebe 404 sem alterar o banco', async () => {
    // Tentar editar Cliente B com token A
    const putCli = await apiRequest('PUT', `/api/clientes/${clienteBId}`, {
      token: adminAToken,
      body: { nome: 'INVADIDO POR A', tipo_pessoa: 'Jurídica', status: 'Inativo' }
    });
    assert.equal(putCli.status, 404);

    // Tentar excluir Cliente B com token A
    const delCli = await apiRequest('DELETE', `/api/clientes/${clienteBId}`, { token: adminAToken });
    assert.equal(delCli.status, 404);

    // Tentar ler, editar e excluir Orçamento B com token A
    const getOrc = await apiRequest('GET', `/api/orcamentos/${orcamentoBNum}`, { token: adminAToken });
    assert.equal(getOrc.status, 404);

    const putOrc = await apiRequest('PUT', `/api/orcamentos/${orcamentoBNum}`, {
      token: adminAToken,
      body: { descricao: 'Adulterado por A' }
    });
    assert.equal(putOrc.status, 404);

    const delOrc = await apiRequest('DELETE', `/api/orcamentos/${orcamentoBNum}`, { token: adminAToken });
    assert.equal(delOrc.status, 404);

    // Tentar ler, editar e excluir Projeto B com token A
    const getProj = await apiRequest('GET', `/api/projetos/${projetoBId}`, { token: adminAToken });
    assert.equal(getProj.status, 404);

    const putProj = await apiRequest('PUT', `/api/projetos/${projetoBId}`, {
      token: adminAToken,
      body: { nome: 'Projeto Invadido' }
    });
    assert.equal(putProj.status, 404);

    const delProj = await apiRequest('DELETE', `/api/projetos/${projetoBId}`, { token: adminAToken });
    assert.equal(delProj.status, 404);

    // Confirmar no banco que os registros da Empresa B permanecem intactos
    const checkCliB = await db.get('SELECT * FROM clientes WHERE id = ?', [clienteBId]);
    assert.equal(checkCliB.nome, 'Cliente Exclusivo B');
    const checkProjB = await db.get('SELECT * FROM projetos WHERE id = ?', [projetoBId]);
    assert.equal(checkProjB.nome, 'Projeto Dormitório B');
  });

  // ==========================================================================
  // CENÁRIO 4: Bloqueio de relacionamentos entre empresas diferentes
  // ==========================================================================
  await runTest('4. Usuário da Empresa A tenta criar orçamento, projeto, contrato ou lançamento apontando para registro da Empresa B e a operação é rejeitada', async () => {
    // Orçamento na Empresa A apontando para cliente da Empresa B
    const badOrc = await apiRequest('POST', '/api/orcamentos', {
      token: adminAToken,
      body: { cliente_id: clienteBId, descricao: 'Orçamento Cruzado' }
    });
    assert.equal(badOrc.status, 404);

    // Projeto na Empresa A apontando para orçamento da Empresa B
    const badProj = await apiRequest('POST', '/api/projetos', {
      token: adminAToken,
      body: { orcamento_numero: orcamentoBNum, nome: 'Projeto Cruzado' }
    });
    assert.equal(badProj.status, 404);

    // Contrato na Empresa A apontando para cliente da Empresa B
    const badCtr = await apiRequest('POST', '/api/contratos', {
      token: adminAToken,
      body: { cliente_id: clienteBId, numero: 'CTR-CRUZADO', valor: 5000, data_inicio: '2026-01-01', data_fim: '2026-12-31' }
    });
    assert.equal(badCtr.status, 404);

    // Adicionar item ao Projeto B usando token da Empresa A
    const badItem = await apiRequest('POST', `/api/projetos/${projetoBId}/itens`, {
      token: adminAToken,
      body: { MaterialReferencia: 'MDF.TESTE.01', ProjetoItemQtd: 5 }
    });
    assert.equal(badItem.status, 404);

    // Teste direto de integridade relacional (FK composta no MySQL): tentar inserir projeto com empresa_id=A mas orcamento_numero de B
    await assert.rejects(async () => {
      await db.run(
        `INSERT INTO projetos (empresa_id, orcamento_numero, nome) VALUES (?, ?, 'Teste FK Composta')`,
        [empAId, orcamentoBNum]
      );
    }, /foreign key constraint fails/i);
  });

  // ==========================================================================
  // CENÁRIO 5: Proteção de arquivos, anexos, layouts, downloads e Path Traversal
  // ==========================================================================
  await runTest('5. Usuário da Empresa A tenta acessar arquivo, anexo ou layout da Empresa B por URL direta ou ID e o acesso é bloqueado', async () => {
    // Criar arquivo físico de anexo para o Projeto B
    const dirAnexosB = path.join(uploadsBaseDir, `empresa_${empBId}`, 'anexos');
    if (!fs.existsSync(dirAnexosB)) fs.mkdirSync(dirAnexosB, { recursive: true });
    const filenameB = `segredo_empresa_b_${suffix}.pdf`;
    const fileFullPathB = path.join(dirAnexosB, filenameB);
    fs.writeFileSync(fileFullPathB, 'CONTEUDO CONFIDENCIAL EMPRESA B');
    anexoBCaminho = `uploads/empresa_${empBId}/anexos/${filenameB}`;

    const insAnexoB = await db.run(
      `INSERT INTO projeto_anexos (empresa_id, projeto_id, nome_original, nome_arquivo, caminho, tipo_mime, tamanho, exibir_na_proposta)
       VALUES (?, ?, 'segredo_b.pdf', ?, ?, 'application/pdf', 31, 'Sim')`,
      [empBId, projetoBId, filenameB, anexoBCaminho]
    );
    anexoBId = insAnexoB.lastID;

    // 5.1 Acesso sem autenticação à rota /uploads/... deve ser negado (401)
    const noAuthUpload = await apiRequest('GET', `/${anexoBCaminho}`);
    assert.equal(noAuthUpload.status, 401);

    // 5.2 Acesso da Empresa A à URL direta /uploads/empresa_B/... deve ser negado (404)
    const crossUpload = await apiRequest('GET', `/${anexoBCaminho}`, { token: adminAToken });
    assert.equal(crossUpload.status, 404);

    // 5.3 Acesso da Empresa A ao endpoint de download de anexo de B deve ser negado (404)
    const crossDownload = await apiRequest('GET', `/api/projetos/anexos/download/${anexoBId}`, { token: adminAToken });
    assert.equal(crossDownload.status, 404);

    // 5.4 Acesso da Empresa A para excluir anexo de B deve ser negado (404)
    const crossDeleteAnexo = await apiRequest('DELETE', `/api/projetos/anexos/${anexoBId}`, { token: adminAToken });
    assert.equal(crossDeleteAnexo.status, 404);

    // 5.5 Tentativa de Path Traversal em /uploads/.. (codificada na URL para chegar ao servidor sob /uploads/*)
    const traversal = await apiRequest('GET', `/uploads/empresa_${empAId}/%2e%2e%2f%2e%2e%2fsrc%2fserver.js`, { token: adminAToken });
    assert.ok([400, 403, 404].includes(traversal.status));

    // 5.6 Acesso legítimo da Empresa B ao seu próprio arquivo funciona (200)
    const validUploadB = await apiRequest('GET', `/${anexoBCaminho}`, { token: adminBToken });
    assert.equal(validUploadB.status, 200);
  });

  // ==========================================================================
  // CENÁRIO 6: Operações em lote (batch) isoladas por empresa
  // ==========================================================================
  await runTest('6. Operações em lote da Empresa A não afetam registros da Empresa B, mesmo quando IDs da Empresa B são enviados na lista', async () => {
    // Adicionar item ao Projeto A e ao Projeto B
    const itemA = await apiRequest('POST', `/api/projetos/${projetoAId}/itens`, {
      token: adminAToken,
      body: { MaterialReferencia: 'MDF.TESTE.01', ProjetoItemQtd: 2 }
    });
    assert.equal(itemA.status, 201);

    const itemB = await apiRequest('POST', `/api/projetos/${projetoBId}/itens`, {
      token: adminBToken,
      body: { MaterialReferencia: 'MDF.TESTE.01', ProjetoItemQtd: 10 }
    });
    assert.equal(itemB.status, 201);

    // Criar segundo material em A e executar substituição em lote em A
    await apiRequest('POST', '/api/produtos', {
      token: adminAToken,
      body: { MaterialReferencia: 'MDF.TESTE.02', MaterialDescricao: 'MDF Freijó A', MaterialUnidade: 'CHP', MaterialValorUnitario: 250, ProdutoGrupo: 1 }
    });

    const substA = await apiRequest('POST', `/api/projetos/${projetoAId}/substituir-materiais`, {
      token: adminAToken,
      body: { itemIds: [itemA.data.ProjetoItemID, itemB.data.ProjetoItemID], novoMaterialReferencia: 'MDF.TESTE.02', novaQuantidade: 3 }
    });
    assert.equal(substA.status, 200);

    // Verificar que o item de B não foi afetado
    const checkItemB = await db.get(
      'SELECT * FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID = ?',
      [empBId, projetoBId, itemB.data.ProjetoItemID]
    );
    assert.ok(checkItemB, 'Item do projeto da Empresa B deve continuar existindo');
    assert.equal(Number(checkItemB.ProjetoItemQtd), 10);
    assert.equal(checkItemB.MaterialReferencia, 'MDF.TESTE.01');
  });

  // ==========================================================================
  // CENÁRIO 7: Rejeição de mass assignment / injeção de empresa_id divergente
  // ==========================================================================
  await runTest('7. Tentativa de enviar empresa_id da Empresa B no corpo, query string, parâmetros ou cabeçalho durante requisição autenticada da Empresa A é rejeitada com 403', async () => {
    // 7.1 No body
    const bodyInject = await apiRequest('POST', '/api/clientes', {
      token: adminAToken,
      body: { nome: 'Tentativa Spoof Body', empresa_id: empBId }
    });
    assert.equal(bodyInject.status, 403);

    // 7.2 Na query string
    const queryInject = await apiRequest('GET', `/api/clientes?empresa_id=${empBId}`, {
      token: adminAToken
    });
    assert.equal(queryInject.status, 403);

    // 7.3 No header X-Empresa-Id
    const headerInject = await apiRequest('GET', '/api/clientes', {
      token: adminAToken,
      headers: { 'x-empresa-id': String(empBId) }
    });
    assert.equal(headerInject.status, 403);
  });

  // ==========================================================================
  // CENÁRIO 8: Administração de usuários, perfis e proteção do catálogo global funcoes
  // ==========================================================================
  await runTest('8. Administrador da Empresa A gerencia apenas usuários e perfis da Empresa A e não consegue alterar o catálogo global de funções', async () => {
    // 8.1 Listar usuários de A não retorna usuários de B
    const usersA = await apiRequest('GET', '/api/usuarios', { token: adminAToken });
    assert.equal(usersA.status, 200);
    assert.ok(usersA.data.every(u => u.empresa_id === empAId));
    assert.ok(!usersA.data.some(u => u.id === adminBId));

    // 8.2 Tentar alterar usuário de B usando admin de A -> 404
    const editUserB = await apiRequest('PUT', `/api/usuarios/${adminBId}`, {
      token: adminAToken,
      body: { nome: 'Hackeado por A' }
    });
    assert.equal(editUserB.status, 404);

    // 8.3 Tentar atribuir perfil da Empresa B a um usuário da Empresa A -> 404/403
    const crossProfile = await apiRequest('PUT', `/api/usuarios/${userAId}`, {
      token: adminAToken,
      body: { perfil_id: perfilAdminBId }
    });
    assert.ok([403, 404].includes(crossProfile.status));

    // 8.4 Operador comum (não admin) não pode criar usuários -> 403
    const nonAdminCreateUser = await apiRequest('POST', '/api/usuarios', {
      token: userAToken,
      body: { nome: 'Novo User', email: `novo.${suffix}@teste.com`, senha: '123' }
    });
    assert.equal(nonAdminCreateUser.status, 403);

    // 8.5 Catálogo global de funções permite leitura mas bloqueia POST/PUT/DELETE com 403
    const getFuncoes = await apiRequest('GET', '/api/funcoes', { token: adminAToken });
    assert.equal(getFuncoes.status, 200);
    assert.ok(Array.isArray(getFuncoes.data) && getFuncoes.data.length > 0);

    const postFuncao = await apiRequest('POST', '/api/funcoes', {
      token: adminAToken,
      body: { chave: 'hack.global', nome: 'Hack Global' }
    });
    assert.equal(postFuncao.status, 403);

    const delFuncao = await apiRequest('DELETE', `/api/funcoes/${getFuncoes.data[0].id}`, {
      token: adminAToken
    });
    assert.equal(delFuncao.status, 403);
  });

  // ==========================================================================
  // CENÁRIO 9: Requisições concorrentes de usuários das Empresas A e B
  // ==========================================================================
  await runTest('9. Requisições concorrentes de usuários das Empresas A e B mantêm contexto isolado sem vazamento entre respostas', async () => {
    const concurrentCalls = [];
    for (let i = 0; i < 10; i++) {
      concurrentCalls.push(
        apiRequest('GET', '/api/auth/me', { token: adminAToken }).then(r => ({ expectedEmp: empAId, res: r })),
        apiRequest('GET', '/api/auth/me', { token: adminBToken }).then(r => ({ expectedEmp: empBId, res: r })),
        apiRequest('GET', '/api/clientes', { token: adminAToken }).then(r => ({ expectedEmp: empAId, list: r })),
        apiRequest('GET', '/api/clientes', { token: adminBToken }).then(r => ({ expectedEmp: empBId, list: r }))
      );
    }

    const responses = await Promise.all(concurrentCalls);
    for (const item of responses) {
      if (item.res) {
        assert.equal(item.res.status, 200);
        assert.equal(item.res.data.empresa_id, item.expectedEmp);
      }
      if (item.list) {
        assert.equal(item.list.status, 200);
        assert.ok(item.list.data.every(row => row.empresa_id === item.expectedEmp));
      }
    }
  });

  // ==========================================================================
  // CENÁRIO 10: Token inválido, expirado ou com vínculo de empresa desatualizado
  // ==========================================================================
  await runTest('10. Token inválido, expirado ou com vínculo de empresa desatualizado é rejeitado', async () => {
    // 10.1 Token com assinatura inválida
    const badSigToken = jwt.sign({ id: adminAId, empresa_id: empAId }, 'chave_errada_secreta', { expiresIn: '1h' });
    const resBadSig = await apiRequest('GET', '/api/clientes', { token: badSigToken });
    assert.ok([401, 403].includes(resBadSig.status));

    // 10.2 Token expirado
    const expiredToken = jwt.sign({ id: adminAId, empresa_id: empAId }, JWT_SECRET, { expiresIn: '-10s' });
    const resExpired = await apiRequest('GET', '/api/clientes', { token: expiredToken });
    assert.ok([401, 403].includes(resExpired.status));

    // 10.3 Token sem empresa_id (token legado antes da migração)
    const legacyToken = jwt.sign({ id: adminAId, email: `admin.a.${suffix}@teste.com` }, JWT_SECRET, { expiresIn: '1h' });
    const resLegacy = await apiRequest('GET', '/api/clientes', { token: legacyToken });
    assert.equal(resLegacy.status, 401);

    // 10.4 Token antigo cujo empresa_id diverge do vínculo vigente no banco
    const staleCompanyToken = jwt.sign({ id: adminAId, empresa_id: empBId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const resStale = await apiRequest('GET', '/api/clientes', { token: staleCompanyToken });
    assert.ok([401, 403].includes(resStale.status));
  });

  // ==========================================================================
  // CENÁRIO 11: Usuário inativo ou vinculado a empresa inativa tem acesso negado
  // ==========================================================================
  await runTest('11. Usuário inativo ou vinculado a empresa inativa tem acesso negado', async () => {
    // 11.1 Login de usuário inativo deve ser recusado (403)
    const loginInactive = await apiRequest('POST', '/api/auth/login', {
      body: { email: `inativo.a.${suffix}@teste.com`, password: 'SenhaForte123!' }
    });
    assert.equal(loginInactive.status, 403);

    // 11.2 Token já emitido para usuário que depois foi desativado deve ser recusado (403)
    const tokenForInactiveUser = jwt.sign({ id: inactiveUserId, empresa_id: empAId, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
    const reqInactiveUser = await apiRequest('GET', '/api/clientes', { token: tokenForInactiveUser });
    assert.equal(reqInactiveUser.status, 403);

    // 11.3 Usuário ativo vinculado a empresa inativa deve ter acesso negado (403)
    const passHash = await bcrypt.hash('SenhaForte123!', 10);
    const uEmpInativa = await db.run(
      `INSERT INTO usuarios (empresa_id, nome, email, senha, role, ativo) VALUES (?, 'User Emp Inativa', ?, ?, 'admin', 1)`,
      [empInativaId, `user.inativa.${suffix}@teste.com`, passHash]
    );
    const tokenEmpInativa = jwt.sign({ id: uEmpInativa.lastID, empresa_id: empInativaId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const reqInactiveCompany = await apiRequest('GET', '/api/clientes', { token: tokenEmpInativa });
    assert.equal(reqInactiveCompany.status, 403);
  });

  // ==========================================================================
  // CENÁRIO 12: Proposta pública por token isolada por orçamento e empresa
  // ==========================================================================
  await runTest('12. Proposta pública por token acessa apenas a proposta correspondente e não expõe outros registros da empresa ou de terceiros', async () => {
    // Gerar link público para Orçamento A e Orçamento B
    const shareA = await apiRequest('POST', `/api/orcamentos/${orcamentoANum}/compartilhar`, {
      token: adminAToken,
      body: { diasValidade: 3 }
    });
    assert.equal(shareA.status, 201);
    shareTokenA = shareA.data.token;

    const shareB = await apiRequest('POST', `/api/orcamentos/${orcamentoBNum}/compartilhar`, {
      token: adminBToken,
      body: { diasValidade: 3 }
    });
    assert.equal(shareB.status, 201);
    shareTokenB = shareB.data.token;

    // Consultar proposta pública A sem login
    const pubA = await apiRequest('GET', `/api/public/propostas/${shareTokenA}`);
    assert.equal(pubA.status, 200);
    assert.equal(pubA.data.orcamento.numero, orcamentoANum);
    assert.equal(pubA.data.orcamento.cliente_nome, 'Cliente Exclusivo A');
    assert.ok(pubA.data.projetos.every(p => p.id === projetoAId));

    // O token público de A NÃO permite baixar o anexo da Empresa B
    const crossPubAsset = await apiRequest('GET', `/${anexoBCaminho}?share_token=${shareTokenA}`);
    assert.equal(crossPubAsset.status, 404);

    // O token público de B permite baixar o anexo exibível da proposta B
    const validPubAssetB = await apiRequest('GET', `/${anexoBCaminho}?share_token=${shareTokenB}`);
    assert.equal(validPubAssetB.status, 200);

    // Revogar link público A usando token da Empresa B deve falhar com 404
    const crossRevoke = await apiRequest('PUT', `/api/compartilhamentos/${shareA.data.id}/revogar`, {
      token: adminBToken
    });
    assert.equal(crossRevoke.status, 404);

    // Revogar link público A usando token da Empresa A funciona e bloqueia novos acessos públicos (410)
    const validRevoke = await apiRequest('PUT', `/api/compartilhamentos/${shareA.data.id}/revogar`, {
      token: adminAToken
    });
    assert.equal(validRevoke.status, 200);

    const pubAfterRevoke = await apiRequest('GET', `/api/public/propostas/${shareTokenA}`);
    assert.equal(pubAfterRevoke.status, 410);
  });

  // ==========================================================================
  // CENÁRIO 13: Rejeição de gravação sem empresa_id, pré-checagem de migração e EXPLAIN de índices
  // ==========================================================================
  await runTest('13. Banco e backend rejeitam gravação de registro empresarial sem empresa_id + validação de índices (EXPLAIN) e conflitos de migração', async () => {
    // 13.1 Banco rejeita INSERT sem empresa_id (coluna NOT NULL sem DEFAULT silencioso)
    await assert.rejects(async () => {
      await db.run(`INSERT INTO clientes (nome, tipo_pessoa, status) VALUES ('Sem Empresa', 'Física', 'Ativo')`);
    }, /Field 'empresa_id' doesn't have a default value|cannot be null/i);

    await assert.rejects(async () => {
      await db.run(`INSERT INTO orcamentos (numero, cliente_id, descricao) VALUES (9999999999, ?, 'Sem Empresa')`, [clienteAId]);
    }, /Field 'empresa_id' doesn't have a default value|cannot be null/i);

    // 13.2 Verificar com EXPLAIN que as consultas críticas utilizam os índices iniciados por empresa_id
    const explainClientes = await db.all(
      `EXPLAIN SELECT * FROM clientes WHERE empresa_id = ? ORDER BY nome ASC`,
      [empAId]
    );
    assert.ok(
      explainClientes.some(r => (r.key || '').includes('empresa') || (r.possible_keys || '').includes('empresa')),
      `EXPLAIN clientes deve usar índice com empresa_id: ${JSON.stringify(explainClientes)}`
    );

    const explainOrcamentos = await db.all(
      `EXPLAIN SELECT * FROM orcamentos WHERE empresa_id = ? AND status = 'Em Aberto'`,
      [empAId]
    );
    assert.ok(
      explainOrcamentos.some(r => (r.key || '').includes('empresa') || (r.possible_keys || '').includes('empresa')),
      `EXPLAIN orcamentos deve usar índice com empresa_id: ${JSON.stringify(explainOrcamentos)}`
    );
  });

} finally {
  await cleanupFixtures();
  server.close();
}

const failed = results.filter(r => !r.passed);
console.log(`\n=============================================================`);
console.log(`Resumo dos Testes de Integração Multiempresa: ${results.length - failed.length}/${results.length} aprovados.`);
console.log(`=============================================================\n`);

if (failed.length > 0) {
  process.exit(1);
}
process.exit(0);
