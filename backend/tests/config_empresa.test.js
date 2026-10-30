import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

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

console.log('Iniciando testes da tabela ConfigEmpresa e seus endpoints...');

try {
  // 1. Verifica se a tabela ConfigEmpresa existe no banco com os atributos esperados
  const tableCheck = await db.get(
    "SELECT COUNT(*) as cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ConfigEmpresa'"
  );
  assert.equal(Number(tableCheck.cnt), 1, 'Tabela ConfigEmpresa deve existir no banco.');
  console.log('✅ Tabela ConfigEmpresa existe no banco de dados.');

  // Verifica colunas
  const cols = await db.all(
    "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ConfigEmpresa'"
  );
  const colNames = cols.map(c => c.COLUMN_NAME);
  assert.ok(colNames.includes('EmpresaID'), 'Deve possuir coluna EmpresaID');
  assert.ok(colNames.includes('ConfigChave'), 'Deve possuir coluna ConfigChave');
  assert.ok(colNames.includes('ConfigValor'), 'Deve possuir coluna ConfigValor');
  assert.ok(colNames.includes('ConfigGestor'), 'Deve possuir coluna ConfigGestor');
  console.log('✅ Colunas EmpresaID, ConfigChave, ConfigValor e ConfigGestor verificadas.');

  // Obtém empresa de teste (ID = 1)
  const empresa = await db.get('SELECT id FROM empresas ORDER BY id ASC LIMIT 1');
  const empresaId = empresa.id;

  // Cria tokens: um para usuário comum da empresa ('admin' / 'user' sem master) e outro para Master
  // Usuário comum da empresa:
  const userRegular = await db.get(
    `SELECT u.id, u.empresa_id, u.email, u.login, u.nome
     FROM usuarios u
     LEFT JOIN perfis p ON p.id = u.perfil_id
     WHERE u.empresa_id = ? AND (p.nome != 'Master' OR p.nome IS NULL)
     LIMIT 1`,
    [empresaId]
  );
  let regularUserId = userRegular?.id;
  if (!regularUserId) {
    const ins = await db.run(
      `INSERT INTO usuarios (empresa_id, nome, login, email, senha, role, ativo, situacao)
       VALUES (?, 'Usuario Empresa', 'user_empresa', 'user_empresa@teste.com', 'hash', 'user', 1, 'Ativado')`,
      [empresaId]
    );
    regularUserId = ins.lastID;
  }

  const regularToken = jwt.sign(
    { id: regularUserId, empresa_id: empresaId, role: 'user', email: 'user@teste.com' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Usuário Master da empresa (perfil Master):
  const masterPerfil = await db.get(
    `SELECT id FROM perfis WHERE empresa_id = ? AND nome = 'Master' LIMIT 1`,
    [empresaId]
  );
  let masterUser = await db.get(
    `SELECT id FROM usuarios WHERE empresa_id = ? AND perfil_id = ? LIMIT 1`,
    [empresaId, masterPerfil?.id]
  );
  if (!masterUser && masterPerfil) {
    const ins = await db.run(
      `INSERT INTO usuarios (empresa_id, perfil_id, nome, login, email, senha, role, ativo, situacao)
       VALUES (?, ?, 'Usuario Master', 'user_master', 'user_master@teste.com', 'hash', 'admin', 1, 'Ativado')`,
      [empresaId, masterPerfil.id]
    );
    masterUser = { id: ins.lastID };
  }

  const masterUserId = masterUser?.id || regularUserId;
  const masterToken = jwt.sign(
    { id: masterUserId, empresa_id: empresaId, role: 'admin', is_master_support: true, login: 'master' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Limpa configurações de teste
  await db.run("DELETE FROM ConfigEmpresa WHERE EmpresaID = ? AND ConfigChave LIKE 'TESTE_%'", [empresaId]);

  // 2. Teste GET /api/config-empresa
  const resGetInit = await apiRequest('GET', '/api/config-empresa', { token: regularToken });
  assert.equal(resGetInit.status, 200);
  assert.ok(Array.isArray(resGetInit.body.configs));
  assert.equal(resGetInit.body.isMaster, false);
  console.log('✅ GET /api/config-empresa retornou lista e isMaster=false para usuário comum.');

  // 3. Teste POST /api/config-empresa por usuário comum com Gestor 'E'
  const resPostE = await apiRequest('POST', '/api/config-empresa', {
    token: regularToken,
    body: {
      ConfigChave: 'TESTE_EMPRESA_1',
      ConfigValor: 'VALOR_EMP_1',
      ConfigGestor: 'E'
    }
  });
  assert.equal(resPostE.status, 201);
  assert.equal(resPostE.body.ConfigChave, 'TESTE_EMPRESA_1');
  assert.equal(resPostE.body.ConfigGestor, 'E');
  assert.equal(resPostE.body.podeAlterar, true);
  console.log('✅ POST /api/config-empresa com Gestor=E criado por usuário comum com sucesso.');

  // 4. Teste POST /api/config-empresa com Gestor 'M' por usuário NÃO-master (DEVE SER REJEITADO COM 403)
  const resPostMFail = await apiRequest('POST', '/api/config-empresa', {
    token: regularToken,
    body: {
      ConfigChave: 'TESTE_MASTER_BLOCK',
      ConfigValor: 'VALOR_FAIL',
      ConfigGestor: 'M'
    }
  });
  assert.equal(resPostMFail.status, 403, 'Usuário comum não pode criar config com Gestor=M');
  console.log('✅ POST /api/config-empresa com Gestor=M rejeitado com 403 para usuário comum.');

  // 5. Teste POST /api/config-empresa com Gestor 'M' por usuário MASTER (DEVE PASSAR)
  const resPostMSuccess = await apiRequest('POST', '/api/config-empresa', {
    token: masterToken,
    body: {
      ConfigChave: 'TESTE_MASTER_1',
      ConfigValor: 'VALOR_MASTER_1',
      ConfigGestor: 'M'
    }
  });
  assert.equal(resPostMSuccess.status, 201);
  assert.equal(resPostMSuccess.body.ConfigGestor, 'M');
  console.log('✅ POST /api/config-empresa com Gestor=M criado com sucesso pelo Master.');

  // 6. Teste de unicidade da chave primária composta (EmpresaID, ConfigChave, ConfigValor)
  const resPostDup = await apiRequest('POST', '/api/config-empresa', {
    token: regularToken,
    body: {
      ConfigChave: 'TESTE_EMPRESA_1',
      ConfigValor: 'VALOR_EMP_1',
      ConfigGestor: 'E'
    }
  });
  assert.equal(resPostDup.status, 400, 'Duplicação de Chave e Valor deve retornar 400');
  console.log('✅ Chave primária composta protegida contra duplicidade (retornou 400).');

  // Chave igual com valor diferente deve ser aceita (pois ConfigValor faz parte da PK composta!)
  const resPostSameKeyDiffVal = await apiRequest('POST', '/api/config-empresa', {
    token: regularToken,
    body: {
      ConfigChave: 'TESTE_EMPRESA_1',
      ConfigValor: 'VALOR_EMP_2',
      ConfigGestor: 'E'
    }
  });
  assert.equal(resPostSameKeyDiffVal.status, 201, 'Mesma chave com valor diferente compõe nova PK e deve ser aceita');
  console.log('✅ Mesma chave com valor diferente aceita na PK composta.');

  // 7. Teste de PUT: usuário comum tentando alterar registro com Gestor 'M' (DEVE SER BLOQUEADO COM 403)
  const resPutMBlocked = await apiRequest('PUT', '/api/config-empresa', {
    token: regularToken,
    body: {
      oldChave: 'TESTE_MASTER_1',
      oldValor: 'VALOR_MASTER_1',
      ConfigChave: 'TESTE_MASTER_1',
      ConfigValor: 'NOVO_VALOR',
      ConfigGestor: 'M'
    }
  });
  assert.equal(resPutMBlocked.status, 403, 'Usuário comum não pode alterar registro Gestor=M');
  console.log('✅ PUT em registro Gestor=M bloqueado com 403 para usuário comum.');

  // 8. Teste de PUT: usuário comum alterando registro Gestor 'E' (DEVE PASSAR)
  const resPutE = await apiRequest('PUT', '/api/config-empresa', {
    token: regularToken,
    body: {
      oldChave: 'TESTE_EMPRESA_1',
      oldValor: 'VALOR_EMP_1',
      ConfigChave: 'TESTE_EMPRESA_1',
      ConfigValor: 'VALOR_ATUALIZADO',
      ConfigGestor: 'E'
    }
  });
  assert.equal(resPutE.status, 200);
  assert.equal(resPutE.body.ConfigValor, 'VALOR_ATUALIZADO');
  console.log('✅ PUT em registro Gestor=E atualizado com sucesso por usuário comum.');

  // 9. Teste de DELETE: usuário comum tentando excluir registro Gestor 'M' (DEVE SER BLOQUEADO COM 403)
  const resDelBlocked = await apiRequest('DELETE', '/api/config-empresa?chave=TESTE_MASTER_1&valor=VALOR_MASTER_1', {
    token: regularToken
  });
  assert.equal(resDelBlocked.status, 403, 'Usuário comum não pode excluir registro Gestor=M');
  console.log('✅ DELETE em registro Gestor=M bloqueado com 403 para usuário comum.');

  // 10. Teste de DELETE: usuário Master excluindo registro Gestor 'M' (DEVE PASSAR)
  const resDelMaster = await apiRequest('DELETE', '/api/config-empresa?chave=TESTE_MASTER_1&valor=VALOR_MASTER_1', {
    token: masterToken
  });
  assert.equal(resDelMaster.status, 200);
  console.log('✅ DELETE em registro Gestor=M executado com sucesso pelo Master.');

  // Limpeza
  await db.run("DELETE FROM ConfigEmpresa WHERE EmpresaID = ? AND ConfigChave LIKE 'TESTE_%'", [empresaId]);

  console.log('=============================================================');
  console.log('Resumo dos Testes de ConfigEmpresa: Todos os 10 testes APROVADOS!');
  console.log('=============================================================');

  server.close();
  process.exit(0);
} catch (err) {
  console.error('❌ Erro no teste de ConfigEmpresa:', err);
  server.close();
  process.exit(1);
}
