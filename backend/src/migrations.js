import bcrypt from 'bcryptjs';

export class MigrationConflictError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'MigrationConflictError';
    this.report = report;
  }
}

/**
 * Classificação oficial das tabelas do banco de dados:
 * 1. TENANT_TABLES: Dados pertencentes a uma empresa específica (exigem empresa_id NOT NULL + FK).
 * 2. GLOBAL_CATALOG_TABLES: Catálogos globais deliberadamente compartilhados (protegidos contra escrita por admins de empresa).
 * 3. PLATFORM_CONTROL_TABLES: Dados internos de controle da plataforma e versionamento de migração.
 */
export const TABLE_CLASSIFICATION = {
  TENANT_TABLES: [
    'usuarios',
    'perfis',
    'perfil_funcoes',
    'clientes',
    'contratos',
    'servicos',
    'Material',
    'Parametro_Financeiro',
    'configuracoes_financeiras',
    'orcamentos',
    'projetos',
    'ProjetoItem',
    'arquivos_importados',
    'Projeto_Materiais',
    'projeto_anexos',
    'Projeto_Modulo',
    'Projeto_Chapa',
    'Projeto_Pecas',
    'Ordem_Servico',
    'ordem_servico_checklist',
    'formas_pagamento',
    'condicoes_pagamento',
    'propostas',
    'proposta_compartilhamentos',
    'parametros_empresa',
    'FluxoRecebimento',
    'auditoria_logs'
  ],
  GLOBAL_CATALOG_TABLES: [
    'funcoes'
  ],
  PLATFORM_CONTROL_TABLES: [
    'empresas',
    'schema_migrations'
  ]
};

export const GLOBAL_FUNCOES_SEED = [
  { codigo: 'DASHBOARD_LEITURA', nome: 'Visualizar Dashboard', modulo: 'Dashboard', descricao: 'Permite visualizar indicadores e gráficos da empresa' },
  { codigo: 'CLIENTES_LEITURA', nome: 'Consultar Clientes', modulo: 'Comercial', descricao: 'Permite listar e visualizar clientes da empresa' },
  { codigo: 'CLIENTES_ESCRITA', nome: 'Gerenciar Clientes', modulo: 'Comercial', descricao: 'Permite criar, editar e excluir clientes da empresa' },
  { codigo: 'CONTRATOS_LEITURA', nome: 'Consultar Contratos', modulo: 'Comercial', descricao: 'Permite listar e baixar contratos da empresa' },
  { codigo: 'CONTRATOS_ESCRITA', nome: 'Gerenciar Contratos', modulo: 'Comercial', descricao: 'Permite criar, editar e excluir contratos da empresa' },
  { codigo: 'ORCAMENTOS_LEITURA', nome: 'Consultar Orçamentos e Propostas', modulo: 'Comercial', descricao: 'Permite visualizar orçamentos e propostas da empresa' },
  { codigo: 'ORCAMENTOS_ESCRITA', nome: 'Gerenciar Orçamentos e Propostas', modulo: 'Comercial', descricao: 'Permite criar, editar, aprovar e compartilhar orçamentos' },
  { codigo: 'PROJETOS_LEITURA', nome: 'Consultar Projetos', modulo: 'Engenharia', descricao: 'Permite visualizar projetos, peças, chapas e anexos' },
  { codigo: 'PROJETOS_ESCRITA', nome: 'Gerenciar Projetos e Importações', modulo: 'Engenharia', descricao: 'Permite criar projetos, importar PDFs e substituir materiais' },
  { codigo: 'PRODUTOS_LEITURA', nome: 'Consultar Materiais/Produtos', modulo: 'Cadastros', descricao: 'Permite consultar catálogo de materiais da empresa' },
  { codigo: 'PRODUTOS_ESCRITA', nome: 'Gerenciar Materiais/Produtos', modulo: 'Cadastros', descricao: 'Permite cadastrar, editar e excluir materiais da empresa' },
  { codigo: 'SERVICOS_LEITURA', nome: 'Consultar Serviços', modulo: 'Cadastros', descricao: 'Permite consultar serviços de fabricação da empresa' },
  { codigo: 'SERVICOS_ESCRITA', nome: 'Gerenciar Serviços', modulo: 'Cadastros', descricao: 'Permite cadastrar, editar e excluir serviços da empresa' },
  { codigo: 'PRODUCAO_LEITURA', nome: 'Consultar Ordens de Serviço', modulo: 'Produção', descricao: 'Permite visualizar ordens de serviço e fila de produção' },
  { codigo: 'PRODUCAO_ESCRITA', nome: 'Apontar e Revisar Ordens de Serviço', modulo: 'Produção', descricao: 'Permite criar OS, alterar situação e executar revisão técnica' },
  { codigo: 'FINANCEIRO_LEITURA', nome: 'Consultar Financeiro', modulo: 'Financeiro', descricao: 'Permite visualizar parâmetros financeiros, formas de pagamento e fluxo de recebimento' },
  { codigo: 'FINANCEIRO_ESCRITA', nome: 'Gerenciar Financeiro', modulo: 'Financeiro', descricao: 'Permite efetivar fluxo, baixar parcelas, estornar e configurar parâmetros financeiros' },
  { codigo: 'ADMIN_USUARIOS', nome: 'Administrar Usuários da Empresa', modulo: 'Segurança', descricao: 'Permite listar, criar, ativar/desativar e alterar usuários da própria empresa' },
  { codigo: 'ADMIN_PERFIS', nome: 'Administrar Perfis de Acesso', modulo: 'Segurança', descricao: 'Permite criar e editar perfis de acesso da própria empresa' },
  { codigo: 'ADMIN_PARAMETROS', nome: 'Administrar Parâmetros da Empresa', modulo: 'Administrativo', descricao: 'Permite alterar parâmetros institucionais e logomarca da empresa' }
];

async function tableExists(pool, tableName) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(pool, tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND LOWER(COLUMN_NAME) = LOWER(?)`,
    [tableName, columnName]
  );
  return rows[0] || null;
}

async function indexExists(pool, tableName, indexName) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND LOWER(INDEX_NAME) = LOWER(?)`,
    [tableName, indexName]
  );
  return rows.length > 0;
}

async function fkExists(pool, tableName, constraintName) {
  const [rows] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND LOWER(CONSTRAINT_NAME) = LOWER(?) AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [tableName, constraintName]
  );
  return rows.length > 0;
}

async function dropFkIfExists(pool, tableName, constraintName) {
  if (await fkExists(pool, tableName, constraintName)) {
    await pool.query(`ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${constraintName}\``);
  }
}

async function dropAllSingleColFksForColumn(pool, tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT kcu.CONSTRAINT_NAME
     FROM information_schema.KEY_COLUMN_USAGE kcu
     WHERE kcu.TABLE_SCHEMA = DATABASE()
       AND LOWER(kcu.TABLE_NAME) = LOWER(?)
       AND LOWER(kcu.COLUMN_NAME) = LOWER(?)
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
    [tableName, columnName]
  );
  for (const r of rows) {
    // Verifica quantas colunas compõem essa FK
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND CONSTRAINT_NAME = ?`,
      [tableName, r.CONSTRAINT_NAME]
    );
    if (cols.length === 1) {
      await pool.query(`ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${r.CONSTRAINT_NAME}\``);
    }
  }
}

async function dropIndexIfExists(pool, tableName, indexName) {
  if (await indexExists(pool, tableName, indexName)) {
    await pool.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
  }
}

async function ensureIndex(pool, tableName, indexName, columnsSql, unique = false) {
  if (!(await indexExists(pool, tableName, indexName))) {
    const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
    await pool.query(`ALTER TABLE \`${tableName}\` ADD ${kind} \`${indexName}\` (${columnsSql})`);
  }
}

async function ensureForeignKey(pool, tableName, constraintName, fkColumnsSql, refTable, refColumnsSql, onDelete = 'RESTRICT', onUpdate = 'CASCADE') {
  if (!(await fkExists(pool, tableName, constraintName))) {
    await pool.query(
      `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${constraintName}\` FOREIGN KEY (${fkColumnsSql}) REFERENCES \`${refTable}\` (${refColumnsSql}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
    );
  }
}

/**
 * Garante que uma empresa possua os perfis básicos e vínculos com o catálogo global de funções.
 */
export async function ensureCompanyProfilesAndPermissions(pool, empresaId) {
  const [funcoes] = await pool.query(`SELECT id, codigo FROM funcoes`);
  const defaultProfiles = [
    { nome: 'Administrador', descricao: 'Acesso completo aos recursos da empresa', sistema: 1, all: true },
    { nome: 'Comercial', descricao: 'Acesso a clientes, contratos, orçamentos e propostas', sistema: 1, prefixes: ['DASHBOARD_', 'CLIENTES_', 'CONTRATOS_', 'ORCAMENTOS_', 'PROJETOS_LEITURA', 'PRODUTOS_LEITURA'] },
    { nome: 'Engenharia / Projetos', descricao: 'Acesso a projetos, materiais e serviços', sistema: 1, prefixes: ['DASHBOARD_', 'PROJETOS_', 'PRODUTOS_', 'SERVICOS_', 'ORCAMENTOS_LEITURA'] },
    { nome: 'Produção', descricao: 'Acesso a ordens de serviço, apontamentos e revisão técnica', sistema: 1, prefixes: ['DASHBOARD_', 'PRODUCAO_', 'PROJETOS_LEITURA'] },
    { nome: 'Financeiro', descricao: 'Acesso a parâmetros financeiros, formas de pagamento e recebimentos', sistema: 1, prefixes: ['DASHBOARD_', 'FINANCEIRO_', 'CONTRATOS_LEITURA', 'ORCAMENTOS_LEITURA', 'CLIENTES_LEITURA'] }
  ];

  let adminPerfilId = null;

  for (const p of defaultProfiles) {
    const [existing] = await pool.query(
      `SELECT id FROM perfis WHERE empresa_id = ? AND nome = ? LIMIT 1`,
      [empresaId, p.nome]
    );
    let perfilId;
    if (existing.length > 0) {
      perfilId = existing[0].id;
    } else {
      const [ins] = await pool.query(
        `INSERT INTO perfis (empresa_id, nome, descricao, ativo, sistema) VALUES (?, ?, ?, 1, ?)`,
        [empresaId, p.nome, p.descricao, p.sistema]
      );
      perfilId = ins.insertId;
    }
    if (p.nome === 'Administrador') {
      adminPerfilId = perfilId;
    }

    for (const f of funcoes) {
      const allowed = p.all || (p.prefixes && p.prefixes.some(pref => f.codigo.startsWith(pref)));
      if (allowed) {
        await pool.query(
          `INSERT IGNORE INTO perfil_funcoes (empresa_id, perfil_id, funcao_id, permissao) VALUES (?, ?, ?, 'TOTAL')`,
          [empresaId, perfilId, f.id]
        );
      }
    }
  }

  return adminPerfilId;
}

/**
 * Pré-checagem do estado do banco antes de aplicar restrições destrutivas ou NOT NULL.
 * Detecta órfãos, múltiplos cadastros de empresa sem mapeamento explícito e conflitos entre empresas.
 */
export async function precheckMultiTenantState(pool, options = {}) {
  const report = {
    timestamp: new Date().toISOString(),
    empresasCount: 0,
    unassignedCounts: {},
    orphanForeignKeys: [],
    crossTenantConflicts: [],
    duplicateKeysWithinTargetCompany: [],
    canAutoMigrateToSingleCompany: true,
    conflictReasons: []
  };

  const hasEmpresas = await tableExists(pool, 'empresas');
  if (hasEmpresas) {
    const [[cnt]] = await pool.query(`SELECT COUNT(*) as total FROM empresas`);
    report.empresasCount = Number(cnt?.total || 0);
  }

  // Inspeciona linhas sem empresa_id em cada tabela de negócio existente
  for (const table of TABLE_CLASSIFICATION.TENANT_TABLES) {
    if (!(await tableExists(pool, table))) continue;
    const col = await columnExists(pool, table, 'empresa_id');
    if (!col) {
      const [[cnt]] = await pool.query(`SELECT COUNT(*) as total FROM \`${table}\``);
      const count = Number(cnt?.total || 0);
      if (count > 0) {
        report.unassignedCounts[table] = count;
      }
    } else {
      const [[cnt]] = await pool.query(`SELECT COUNT(*) as total FROM \`${table}\` WHERE empresa_id IS NULL OR empresa_id <= 0`);
      const count = Number(cnt?.total || 0);
      if (count > 0) {
        report.unassignedCounts[table] = count;
      }
    }
  }

  const hasUnassigned = Object.keys(report.unassignedCounts).length > 0;

  // Se houver mais de 1 empresa cadastrada e registros órfãos de empresa_id sem options.defaultEmpresaId explícito, para!
  if (hasUnassigned && report.empresasCount > 1 && !options.defaultEmpresaId) {
    report.canAutoMigrateToSingleCompany = false;
    report.conflictReasons.push(
      `Existem ${report.empresasCount} empresas cadastradas e registros sem empresa_id (${JSON.stringify(report.unassignedCounts)}), mas nenhum defaultEmpresaId explícito foi informado para resolução.`
    );
  }

  // Verifica órfãos e divergências de empresa_id entre tabelas pai e filha
  const parentChildChecks = [
    { child: 'contratos', childFk: 'cliente_id', parent: 'clientes', parentPk: 'id' },
    { child: 'orcamentos', childFk: 'cliente_id', parent: 'clientes', parentPk: 'id' },
    { child: 'orcamentos', childFk: 'parametro_financeiro_id', parent: 'Parametro_Financeiro', parentPk: 'id', nullable: true },
    { child: 'projetos', childFk: 'orcamento_numero', parent: 'orcamentos', parentPk: 'numero', nullable: true },
    { child: 'ProjetoItem', childFk: 'ProjetoID', parent: 'projetos', parentPk: 'id' },
    { child: 'ProjetoItem', childFk: 'MaterialReferencia', parent: 'Material', parentPk: 'MaterialReferencia' },
    { child: 'arquivos_importados', childFk: 'projeto_id', parent: 'projetos', parentPk: 'id', nullable: true },
    { child: 'Projeto_Materiais', childFk: 'projeto_id', parent: 'projetos', parentPk: 'id' },
    { child: 'projeto_anexos', childFk: 'projeto_id', parent: 'projetos', parentPk: 'id' },
    { child: 'Projeto_Modulo', childFk: 'projeto_id', parent: 'projetos', parentPk: 'id' },
    { child: 'Projeto_Chapa', childFk: 'projeto_id', parent: 'projetos', parentPk: 'id' },
    { child: 'Projeto_Pecas', childFk: 'projeto_id', parent: 'projetos', parentPk: 'id' },
    { child: 'condicoes_pagamento', childFk: 'forma_pagamento_id', parent: 'formas_pagamento', parentPk: 'id' },
    { child: 'configuracoes_financeiras', childFk: 'parametro_id', parent: 'Parametro_Financeiro', parentPk: 'id' },
    { child: 'propostas', childFk: 'orcamento_numero', parent: 'orcamentos', parentPk: 'numero' },
    { child: 'proposta_compartilhamentos', childFk: 'orcamento_numero', parent: 'orcamentos', parentPk: 'numero' },
    { child: 'FluxoRecebimento', childFk: 'orcamento_numero', parent: 'orcamentos', parentPk: 'numero' }
  ];

  for (const rel of parentChildChecks) {
    if (!(await tableExists(pool, rel.child)) || !(await tableExists(pool, rel.parent))) continue;

    // 1. Checa registros filhos apontando para pai inexistente
    const [orphans] = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM \`${rel.child}\` c
       LEFT JOIN \`${rel.parent}\` p ON c.\`${rel.childFk}\` = p.\`${rel.parentPk}\`
       WHERE c.\`${rel.childFk}\` IS NOT NULL AND p.\`${rel.parentPk}\` IS NULL`
    );
    if (Number(orphans[0]?.cnt || 0) > 0) {
      report.orphanForeignKeys.push({
        relation: `${rel.child}.${rel.childFk} -> ${rel.parent}.${rel.parentPk}`,
        count: Number(orphans[0].cnt),
        nullable: Boolean(rel.nullable)
      });
    }

    // 2. Se ambas já têm empresa_id, checa se há vínculo entre empresas diferentes
    const childHasEmp = await columnExists(pool, rel.child, 'empresa_id');
    const parentHasEmp = await columnExists(pool, rel.parent, 'empresa_id');
    if (childHasEmp && parentHasEmp) {
      const [conflicts] = await pool.query(
        `SELECT COUNT(*) as cnt
         FROM \`${rel.child}\` c
         INNER JOIN \`${rel.parent}\` p ON c.\`${rel.childFk}\` = p.\`${rel.parentPk}\`
         WHERE c.empresa_id IS NOT NULL AND p.empresa_id IS NOT NULL AND c.empresa_id <> p.empresa_id`
      );
      if (Number(conflicts[0]?.cnt || 0) > 0) {
        report.canAutoMigrateToSingleCompany = false;
        const msg = `Conflito entre empresas em ${rel.child}.${rel.childFk} -> ${rel.parent}.${rel.parentPk}: ${conflicts[0].cnt} registro(s) com empresa_id divergente.`;
        report.crossTenantConflicts.push(msg);
        report.conflictReasons.push(msg);
      }
    }
  }

  return report;
}

/**
 * Executa a migração versionada para arquitetura multiempresa (V2026_10_28_MULTITENANT_V1).
 */
export async function runMultiTenantMigrations(pool, options = {}) {
  const MIGRATION_VERSION = 'V2026_10_28_MULTITENANT_V1';

  // 1. Cria tabela interna de controle de migrações
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      description VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL,
      report LONGTEXT DEFAULT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 2. Cria tabela de controle de empresas (Tenants)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      razao_social VARCHAR(255) NOT NULL,
      nome_fantasia VARCHAR(255) DEFAULT NULL,
      cnpj VARCHAR(30) DEFAULT NULL,
      email VARCHAR(255) DEFAULT NULL,
      telefone VARCHAR(50) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Ativo',
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      config_integracoes LONGTEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX uk_empresas_cnpj (cnpj)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 3. Cria catálogo global de funções do sistema (deliberadamente compartilhado, somente leitura para empresas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funcoes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      codigo VARCHAR(80) NOT NULL,
      nome VARCHAR(150) NOT NULL,
      modulo VARCHAR(80) NOT NULL,
      descricao VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE INDEX uk_funcoes_codigo (codigo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const f of GLOBAL_FUNCOES_SEED) {
    await pool.query(
      `INSERT INTO funcoes (codigo, nome, modulo, descricao)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nome = VALUES(nome), modulo = VALUES(modulo), descricao = VALUES(descricao)`,
      [f.codigo, f.nome, f.modulo, f.descricao]
    );
  }

  // 4. Cria tabelas de perfis por empresa e vínculo perfil_funcoes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS perfis (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa_id INT NOT NULL,
      nome VARCHAR(100) NOT NULL,
      descricao VARCHAR(255) DEFAULT NULL,
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      sistema TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE INDEX uk_perfis_empresa_id (empresa_id, id),
      UNIQUE INDEX uk_perfis_empresa_nome (empresa_id, nome),
      CONSTRAINT fk_perfis_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS perfil_funcoes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa_id INT NOT NULL,
      perfil_id INT NOT NULL,
      funcao_id INT NOT NULL,
      permissao VARCHAR(30) NOT NULL DEFAULT 'TOTAL',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE INDEX uk_pf_empresa_perfil_funcao (empresa_id, perfil_id, funcao_id),
      CONSTRAINT fk_pf_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_pf_perfil FOREIGN KEY (empresa_id, perfil_id) REFERENCES perfis(empresa_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_pf_funcao FOREIGN KEY (funcao_id) REFERENCES funcoes(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 5. Cria tabela de auditoria de operações sensíveis e segurança
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      empresa_id INT DEFAULT NULL,
      usuario_id INT DEFAULT NULL,
      acao VARCHAR(100) NOT NULL,
      recurso VARCHAR(100) NOT NULL,
      recurso_id VARCHAR(100) DEFAULT NULL,
      detalhes TEXT DEFAULT NULL,
      request_id VARCHAR(64) DEFAULT NULL,
      ip VARCHAR(64) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_empresa_created (empresa_id, created_at),
      INDEX idx_audit_empresa_recurso (empresa_id, recurso, recurso_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 6. Executa pré-checagem do estado do banco antes de alterações destrutivas
  const precheck = await precheckMultiTenantState(pool, options);
  if (!precheck.canAutoMigrateToSingleCompany) {
    await pool.query(
      `INSERT INTO schema_migrations (version, description, status, report)
       VALUES (?, ?, 'CONFLICT_DETECTED', ?)
       ON DUPLICATE KEY UPDATE status = 'CONFLICT_DETECTED', report = VALUES(report), applied_at = CURRENT_TIMESTAMP`,
      [MIGRATION_VERSION, 'Isolamento Multiempresa por empresa_id', JSON.stringify(precheck, null, 2)]
    );
    throw new MigrationConflictError(
      `Migração interrompida por conflitos de dados multiempresa: ${precheck.conflictReasons.join('; ')}`,
      precheck
    );
  }

  // 7. Garante que a empresa padrão (id = 1 ou options.defaultEmpresaId) exista
  let defaultEmpresaId = Number(options.defaultEmpresaId || 1);
  const [existingEmpresas] = await pool.query(`SELECT id FROM empresas ORDER BY id ASC`);
  if (existingEmpresas.length === 0) {
    let razaoSocial = 'Marcenaria Chão de Fábrica Ltda';
    let nomeFantasia = 'Chão de Fábrica ERP';
    let cnpj = '00.000.000/0001-00';

    if (await tableExists(pool, 'parametros_empresa')) {
      const [params] = await pool.query(`SELECT chave, conteudo FROM parametros_empresa`);
      for (const p of params) {
        const k = String(p.chave || '').toUpperCase();
        if (k === 'RAZAO_SOC' && p.conteudo) razaoSocial = p.conteudo.trim();
        if (k === 'NOME_FANTASIA' && p.conteudo) nomeFantasia = p.conteudo.trim();
        if (k === 'CNPJ' && p.conteudo) cnpj = p.conteudo.trim();
      }
    }

    const [ins] = await pool.query(
      `INSERT INTO empresas (id, razao_social, nome_fantasia, cnpj, status, ativo) VALUES (1, ?, ?, ?, 'Ativo', 1)`,
      [razaoSocial, nomeFantasia, cnpj]
    );
    defaultEmpresaId = ins.insertId || 1;
  } else if (!options.defaultEmpresaId) {
    defaultEmpresaId = existingEmpresas[0].id;
  }

  const adminPerfilId = await ensureCompanyProfilesAndPermissions(pool, defaultEmpresaId);

  // 8. Adiciona colunas de governança e empresa_id (inicialmente NULLABLE para backfill controlado)
  const tenantTablesToMigrate = [
    'usuarios',
    'clientes',
    'contratos',
    'servicos',
    'Material',
    'Parametro_Financeiro',
    'configuracoes_financeiras',
    'orcamentos',
    'projetos',
    'ProjetoItem',
    'arquivos_importados',
    'Projeto_Materiais',
    'projeto_anexos',
    'Projeto_Modulo',
    'Projeto_Chapa',
    'Projeto_Pecas',
    'Ordem_Servico',
    'ordem_servico_checklist',
    'formas_pagamento',
    'condicoes_pagamento',
    'propostas',
    'proposta_compartilhamentos',
    'parametros_empresa',
    'FluxoRecebimento'
  ];

  for (const table of tenantTablesToMigrate) {
    if (!(await tableExists(pool, table))) continue;
    const col = await columnExists(pool, table, 'empresa_id');
    if (!col) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`empresa_id\` INT DEFAULT NULL FIRST`);
    }
  }

  // Colunas extras para RBAC e rastreamento de proprietário de arquivos
  if (!(await columnExists(pool, 'usuarios', 'ativo'))) {
    await pool.query(`ALTER TABLE \`usuarios\` ADD COLUMN \`ativo\` TINYINT(1) NOT NULL DEFAULT 1`);
  }
  if (!(await columnExists(pool, 'usuarios', 'perfil_id'))) {
    await pool.query(`ALTER TABLE \`usuarios\` ADD COLUMN \`perfil_id\` INT DEFAULT NULL`);
  }
  if (!(await columnExists(pool, 'arquivos_importados', 'criado_por'))) {
    await pool.query(`ALTER TABLE \`arquivos_importados\` ADD COLUMN \`criado_por\` INT DEFAULT NULL`);
  }
  if (!(await columnExists(pool, 'projeto_anexos', 'criado_por'))) {
    await pool.query(`ALTER TABLE \`projeto_anexos\` ADD COLUMN \`criado_por\` INT DEFAULT NULL`);
  }

  // 9. Backfill seguro de empresa_id nos registros existentes de base monoempresa
  for (const table of tenantTablesToMigrate) {
    if (!(await tableExists(pool, table))) continue;
    await pool.query(
      `UPDATE \`${table}\` SET \`empresa_id\` = ? WHERE \`empresa_id\` IS NULL OR \`empresa_id\` <= 0`,
      [defaultEmpresaId]
    );
  }

  // Vincula usuários administradores existentes ao perfil Administrador da própria empresa
  if (adminPerfilId) {
    await pool.query(
      `UPDATE \`usuarios\` SET \`perfil_id\` = ? WHERE \`empresa_id\` = ? AND \`perfil_id\` IS NULL AND LOWER(\`role\`) = 'admin'`,
      [adminPerfilId, defaultEmpresaId]
    );
  }

  // Saneamento de referências órfãs legadas antes de criar FKs compostas
  await pool.query(`
    UPDATE orcamentos o
    LEFT JOIN Parametro_Financeiro pf ON o.empresa_id = pf.empresa_id AND o.parametro_financeiro_id = pf.id
    SET o.parametro_financeiro_id = NULL
    WHERE o.parametro_financeiro_id IS NOT NULL AND pf.id IS NULL
  `);
  await pool.query(`
    UPDATE projetos p
    LEFT JOIN orcamentos o ON p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
    SET p.orcamento_numero = NULL
    WHERE p.orcamento_numero IS NOT NULL AND o.numero IS NULL
  `);
  await pool.query(`
    UPDATE arquivos_importados ai
    LEFT JOIN projetos p ON ai.empresa_id = p.empresa_id AND ai.projeto_id = p.id
    SET ai.projeto_id = NULL
    WHERE ai.projeto_id IS NOT NULL AND p.id IS NULL
  `);
  await pool.query(`
    DELETE osc FROM ordem_servico_checklist osc
    LEFT JOIN Ordem_Servico os ON osc.empresa_id = os.empresa_id AND osc.numero = os.Numero AND osc.projeto_id = os.ProjetoID
    WHERE os.Numero IS NULL
  `);
  await pool.query(`
    DELETE fr FROM FluxoRecebimento fr
    LEFT JOIN orcamentos o ON fr.empresa_id = o.empresa_id AND fr.orcamento_numero = o.numero
    WHERE o.numero IS NULL
  `);

  // 10. Valida que NENHUM registro ficou com empresa_id NULL antes de aplicar NOT NULL
  for (const table of tenantTablesToMigrate) {
    if (!(await tableExists(pool, table))) continue;
    const [[nullRow]] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${table}\` WHERE \`empresa_id\` IS NULL`);
    if (Number(nullRow?.cnt || 0) > 0) {
      throw new Error(`Falha de validação pós-backfill: tabela ${table} ainda possui ${nullRow.cnt} registro(s) com empresa_id NULL.`);
    }
    // Torna empresa_id NOT NULL SEM DEFAULT implícito para impedir gravações sem contexto de empresa
    await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`empresa_id\` INT NOT NULL`);
  }

  // 11. Atualização de chaves primárias e restrições de unicidade por empresa
  // 11.1 Material: PK passa a ser (empresa_id, MaterialReferencia)
  await dropAllSingleColFksForColumn(pool, 'ProjetoItem', 'MaterialReferencia');
  await dropFkIfExists(pool, 'ProjetoItem', 'fk_projetoitem_material');
  const [matPkCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'material' AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`
  );
  const matPkNames = matPkCols.map(c => c.COLUMN_NAME.toLowerCase());
  if (matPkNames.length !== 2 || matPkNames[0] !== 'empresa_id') {
    await pool.query(`ALTER TABLE \`Material\` DROP PRIMARY KEY, ADD PRIMARY KEY (\`empresa_id\`, \`MaterialReferencia\`)`);
  }

  // 11.2 ProjetoItem: PK passa a ser (empresa_id, ProjetoID, ProjetoItemID)
  await dropAllSingleColFksForColumn(pool, 'ProjetoItem', 'ProjetoID');
  await dropFkIfExists(pool, 'ProjetoItem', 'fk_projetoitem_projeto');
  const [piPkCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'projetoitem' AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`
  );
  const piPkNames = piPkCols.map(c => c.COLUMN_NAME.toLowerCase());
  if (piPkNames.length !== 3 || piPkNames[0] !== 'empresa_id') {
    await pool.query(`ALTER TABLE \`ProjetoItem\` DROP PRIMARY KEY, ADD PRIMARY KEY (\`empresa_id\`, \`ProjetoID\`, \`ProjetoItemID\`)`);
  }

  // 11.3 Ordem_Servico: PK passa a ser (empresa_id, Numero, ProjetoID) e tipos harmonizados com ordem_servico_checklist
  await dropFkIfExists(pool, 'ordem_servico_checklist', 'fk_os_checklist_os');
  await dropFkIfExists(pool, 'ordem_servico_checklist', 'fk_os_checklist_empresa_os');
  await pool.query(`ALTER TABLE \`Ordem_Servico\` MODIFY COLUMN \`Numero\` BIGINT NOT NULL, MODIFY COLUMN \`ProjetoID\` INT NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE \`ordem_servico_checklist\` MODIFY COLUMN \`numero\` BIGINT NOT NULL, MODIFY COLUMN \`projeto_id\` INT NOT NULL DEFAULT 1`);
  const [osPkCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'ordem_servico' AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`
  );
  const osPkNames = osPkCols.map(c => c.COLUMN_NAME.toLowerCase());
  if (osPkNames.length !== 3 || osPkNames[0] !== 'empresa_id') {
    await pool.query(`ALTER TABLE \`Ordem_Servico\` DROP PRIMARY KEY, ADD PRIMARY KEY (\`empresa_id\`, \`Numero\`, \`ProjetoID\`)`);
  }

  // 11.4 contratos: substitui UNIQUE(numero) global por UNIQUE(empresa_id, numero)
  await dropIndexIfExists(pool, 'contratos', 'numero');
  await ensureIndex(pool, 'contratos', 'uk_contratos_empresa_numero', '`empresa_id`, `numero`', true);

  // 11.5 parametros_empresa: substitui UNIQUE(chave) global por UNIQUE(empresa_id, chave)
  await dropIndexIfExists(pool, 'parametros_empresa', 'chave');
  await ensureIndex(pool, 'parametros_empresa', 'uk_param_empresa_chave', '`empresa_id`, `chave`', true);

  // 11.6 configuracoes_financeiras: garante UNIQUE(empresa_id, parametro_id) antes de remover índice antigo
  await dropAllSingleColFksForColumn(pool, 'configuracoes_financeiras', 'parametro_id');
  await ensureIndex(pool, 'configuracoes_financeiras', 'uk_config_fin_empresa_param', '`empresa_id`, `parametro_id`', true);
  await dropIndexIfExists(pool, 'configuracoes_financeiras', 'parametro_id');

  // 11.7 ordem_servico_checklist: substitui uk_os_tarefa(numero, projeto_id, tarefa_key) por (empresa_id, numero, projeto_id, tarefa_key)
  await dropIndexIfExists(pool, 'ordem_servico_checklist', 'uk_os_tarefa');
  await ensureIndex(pool, 'ordem_servico_checklist', 'uk_os_checklist_empresa_tarefa', '`empresa_id`, `numero`, `projeto_id`, `tarefa_key`', true);

  // 12. Chaves únicas compostas (empresa_id, id) nas tabelas pai para suportar FKs compostas
  const parentCompositeUniqueTables = [
    { table: 'usuarios', pk: 'id', uk: 'uk_usuarios_empresa_id' },
    { table: 'clientes', pk: 'id', uk: 'uk_clientes_empresa_id' },
    { table: 'contratos', pk: 'id', uk: 'uk_contratos_empresa_id' },
    { table: 'servicos', pk: 'id', uk: 'uk_servicos_empresa_id' },
    { table: 'Parametro_Financeiro', pk: 'id', uk: 'uk_param_fin_empresa_id' },
    { table: 'orcamentos', pk: 'numero', uk: 'uk_orcamentos_empresa_numero' },
    { table: 'projetos', pk: 'id', uk: 'uk_projetos_empresa_id' },
    { table: 'formas_pagamento', pk: 'id', uk: 'uk_formas_pag_empresa_id' },
    { table: 'condicoes_pagamento', pk: 'id', uk: 'uk_cond_pag_empresa_id' },
    { table: 'propostas', pk: 'id', uk: 'uk_propostas_empresa_id' },
    { table: 'proposta_compartilhamentos', pk: 'id', uk: 'uk_prop_comp_empresa_id' },
    { table: 'parametros_empresa', pk: 'id', uk: 'uk_param_emp_empresa_id' },
    { table: 'FluxoRecebimento', pk: 'id', uk: 'uk_fluxo_rec_empresa_id' },
    { table: 'arquivos_importados', pk: 'id', uk: 'uk_arq_imp_empresa_id' },
    { table: 'projeto_anexos', pk: 'id', uk: 'uk_proj_anexos_empresa_id' }
  ];

  for (const item of parentCompositeUniqueTables) {
    await ensureIndex(pool, item.table, item.uk, `\`empresa_id\`, \`${item.pk}\``, true);
  }

  // 13. Índices compostos iniciados por empresa_id voltados aos padrões reais de busca, filtro e ordenação
  const queryIndexes = [
    { table: 'usuarios', name: 'idx_usuarios_empresa_ativo', cols: '`empresa_id`, `ativo`' },
    { table: 'clientes', name: 'idx_clientes_empresa_status', cols: '`empresa_id`, `status`' },
    { table: 'clientes', name: 'idx_clientes_empresa_nome', cols: '`empresa_id`, `nome`' },
    { table: 'contratos', name: 'idx_contratos_empresa_cliente', cols: '`empresa_id`, `cliente_id`' },
    { table: 'contratos', name: 'idx_contratos_empresa_status', cols: '`empresa_id`, `status`' },
    { table: 'servicos', name: 'idx_servicos_empresa_seq', cols: '`empresa_id`, `sequencia`' },
    { table: 'Material', name: 'idx_material_empresa_tipo', cols: '`empresa_id`, `MaterialTipo`' },
    { table: 'Parametro_Financeiro', name: 'idx_param_fin_empresa_sit', cols: '`empresa_id`, `situacao`' },
    { table: 'orcamentos', name: 'idx_orcamentos_empresa_cliente', cols: '`empresa_id`, `cliente_id`' },
    { table: 'orcamentos', name: 'idx_orcamentos_empresa_situacao', cols: '`empresa_id`, `situacao`(50)' },
    { table: 'projetos', name: 'idx_projetos_empresa_orcamento', cols: '`empresa_id`, `orcamento_numero`' },
    { table: 'arquivos_importados', name: 'idx_arq_imp_empresa_projeto', cols: '`empresa_id`, `projeto_id`' },
    { table: 'Projeto_Materiais', name: 'idx_proj_mat_empresa_proj', cols: '`empresa_id`, `projeto_id`' },
    { table: 'projeto_anexos', name: 'idx_proj_anexos_empresa_proj', cols: '`empresa_id`, `projeto_id`' },
    { table: 'Projeto_Modulo', name: 'idx_proj_mod_empresa_proj', cols: '`empresa_id`, `projeto_id`' },
    { table: 'Projeto_Chapa', name: 'idx_proj_chapa_empresa_proj', cols: '`empresa_id`, `projeto_id`' },
    { table: 'Projeto_Pecas', name: 'idx_proj_pecas_empresa_proj', cols: '`empresa_id`, `projeto_id`' },
    { table: 'Ordem_Servico', name: 'idx_os_empresa_projeto', cols: '`empresa_id`, `ProjetoID`' },
    { table: 'Ordem_Servico', name: 'idx_os_empresa_situacao', cols: '`empresa_id`, `Situacao`' },
    { table: 'formas_pagamento', name: 'idx_formas_pag_empresa_ativo', cols: '`empresa_id`, `ativo`, `ordem`' },
    { table: 'condicoes_pagamento', name: 'idx_cond_pag_empresa_forma', cols: '`empresa_id`, `forma_pagamento_id`' },
    { table: 'propostas', name: 'idx_propostas_empresa_orc', cols: '`empresa_id`, `orcamento_numero`' },
    { table: 'proposta_compartilhamentos', name: 'idx_prop_comp_empresa_orc', cols: '`empresa_id`, `orcamento_numero`' },
    { table: 'FluxoRecebimento', name: 'idx_fluxo_rec_empresa_orc', cols: '`empresa_id`, `orcamento_numero`' },
    { table: 'FluxoRecebimento', name: 'idx_fluxo_rec_empresa_status_venc', cols: '`empresa_id`, `status`, `data_vencimento`' }
  ];

  for (const idx of queryIndexes) {
    await ensureIndex(pool, idx.table, idx.name, idx.cols, false);
  }

  // 14. Chaves estrangeiras para empresas(id) em todas as tabelas de negócio
  for (const table of tenantTablesToMigrate) {
    const fkName = `fk_${table.toLowerCase()}_empresa`;
    await ensureForeignKey(pool, table, fkName, '`empresa_id`', 'empresas', '`id`', 'RESTRICT', 'CASCADE');
  }

  // 15. Substituição de FKs simples por FKs compostas (empresa_id, fk_col) -> pai(empresa_id, pk_col)
  // Impede em nível de banco de dados qualquer relacionamento entre registros de empresas diferentes!
  const compositeFks = [
    {
      table: 'usuarios',
      oldCol: 'perfil_id',
      name: 'fk_usuarios_empresa_perfil',
      cols: '`empresa_id`, `perfil_id`',
      refTable: 'perfis',
      refCols: '`empresa_id`, `id`',
      onDelete: 'RESTRICT'
    },
    {
      table: 'contratos',
      oldCol: 'cliente_id',
      name: 'fk_contratos_empresa_cliente',
      cols: '`empresa_id`, `cliente_id`',
      refTable: 'clientes',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'configuracoes_financeiras',
      oldCol: 'parametro_id',
      name: 'fk_config_fin_empresa_param',
      cols: '`empresa_id`, `parametro_id`',
      refTable: 'Parametro_Financeiro',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'orcamentos',
      oldCol: 'cliente_id',
      name: 'fk_orcamentos_empresa_cliente',
      cols: '`empresa_id`, `cliente_id`',
      refTable: 'clientes',
      refCols: '`empresa_id`, `id`',
      onDelete: 'RESTRICT'
    },
    {
      table: 'orcamentos',
      oldCol: 'parametro_financeiro_id',
      name: 'fk_orcamentos_empresa_param',
      cols: '`empresa_id`, `parametro_financeiro_id`',
      refTable: 'Parametro_Financeiro',
      refCols: '`empresa_id`, `id`',
      onDelete: 'RESTRICT'
    },
    {
      table: 'projetos',
      oldCol: 'orcamento_numero',
      name: 'fk_projetos_empresa_orcamento',
      cols: '`empresa_id`, `orcamento_numero`',
      refTable: 'orcamentos',
      refCols: '`empresa_id`, `numero`',
      onDelete: 'RESTRICT'
    },
    {
      table: 'ProjetoItem',
      oldCol: 'ProjetoID',
      name: 'fk_projetoitem_empresa_projeto',
      cols: '`empresa_id`, `ProjetoID`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'ProjetoItem',
      oldCol: 'MaterialReferencia',
      name: 'fk_projetoitem_empresa_material',
      cols: '`empresa_id`, `MaterialReferencia`',
      refTable: 'Material',
      refCols: '`empresa_id`, `MaterialReferencia`',
      onDelete: 'RESTRICT'
    },
    {
      table: 'arquivos_importados',
      oldCol: 'projeto_id',
      name: 'fk_arq_imp_empresa_projeto',
      cols: '`empresa_id`, `projeto_id`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'RESTRICT'
    },
    {
      table: 'Projeto_Materiais',
      oldCol: 'projeto_id',
      name: 'fk_proj_mat_empresa_projeto',
      cols: '`empresa_id`, `projeto_id`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'projeto_anexos',
      oldCol: 'projeto_id',
      name: 'fk_proj_anexos_empresa_projeto',
      cols: '`empresa_id`, `projeto_id`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'Projeto_Modulo',
      oldCol: 'projeto_id',
      name: 'fk_proj_mod_empresa_projeto',
      cols: '`empresa_id`, `projeto_id`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'Projeto_Chapa',
      oldCol: 'projeto_id',
      name: 'fk_proj_chapa_empresa_projeto',
      cols: '`empresa_id`, `projeto_id`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'Projeto_Pecas',
      oldCol: 'projeto_id',
      name: 'fk_proj_pecas_empresa_projeto',
      cols: '`empresa_id`, `projeto_id`',
      refTable: 'projetos',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'ordem_servico_checklist',
      oldCol: null,
      name: 'fk_os_checklist_empresa_os',
      cols: '`empresa_id`, `numero`, `projeto_id`',
      refTable: 'Ordem_Servico',
      refCols: '`empresa_id`, `Numero`, `ProjetoID`',
      onDelete: 'CASCADE'
    },
    {
      table: 'condicoes_pagamento',
      oldCol: 'forma_pagamento_id',
      name: 'fk_cond_pag_empresa_forma',
      cols: '`empresa_id`, `forma_pagamento_id`',
      refTable: 'formas_pagamento',
      refCols: '`empresa_id`, `id`',
      onDelete: 'CASCADE'
    },
    {
      table: 'propostas',
      oldCol: 'orcamento_numero',
      name: 'fk_propostas_empresa_orcamento',
      cols: '`empresa_id`, `orcamento_numero`',
      refTable: 'orcamentos',
      refCols: '`empresa_id`, `numero`',
      onDelete: 'CASCADE'
    },
    {
      table: 'proposta_compartilhamentos',
      oldCol: 'orcamento_numero',
      name: 'fk_prop_comp_empresa_orcamento',
      cols: '`empresa_id`, `orcamento_numero`',
      refTable: 'orcamentos',
      refCols: '`empresa_id`, `numero`',
      onDelete: 'CASCADE'
    },
    {
      table: 'FluxoRecebimento',
      oldCol: 'orcamento_numero',
      name: 'fk_fluxo_rec_empresa_orcamento',
      cols: '`empresa_id`, `orcamento_numero`',
      refTable: 'orcamentos',
      refCols: '`empresa_id`, `numero`',
      onDelete: 'CASCADE'
    }
  ];

  for (const fk of compositeFks) {
    if (fk.oldCol) {
      await dropAllSingleColFksForColumn(pool, fk.table, fk.oldCol);
    }
    await ensureForeignKey(pool, fk.table, fk.name, fk.cols, fk.refTable, fk.refCols, fk.onDelete, 'CASCADE');
  }

  // 16. Registra versão da migração concluída com sucesso
  await pool.query(
    `INSERT INTO schema_migrations (version, description, status, report)
     VALUES (?, ?, 'APPLIED', ?)
     ON DUPLICATE KEY UPDATE status = 'APPLIED', report = VALUES(report), applied_at = CURRENT_TIMESTAMP`,
    [MIGRATION_VERSION, 'Isolamento Multiempresa por empresa_id, FKs compostas, RBAC e Auditoria', JSON.stringify({ defaultEmpresaId, precheck }, null, 2)]
  );

  return { version: MIGRATION_VERSION, defaultEmpresaId, precheck };
}
