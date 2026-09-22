import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = parseInt(process.env.DB_PORT || '3306', 10);
const dbUser = process.env.DB_USER || 'root';
const dbPassword = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_NAME || 'erp_chaodefabrica';

/**
 * Cria a conexão e abstrai as operações com a mesma interface usada pelo SQLite:
 * - db.get(sql, params) -> retorna objeto da primeira linha ou null
 * - db.all(sql, params) -> retorna array com as linhas encontradas
 * - db.run(sql, params) -> retorna { lastID: insertId, changes: affectedRows }
 * - db.exec(sql) -> executa query/queries DDL ou múltiplas instruções
 */
class MySQLDatabaseAdapter {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  async get(sql, params = []) {
    // Intercepta PRAGMA table_info para compatibilidade
    const pragmaMatch = sql.match(/PRAGMA\s+table_info\(([`"']?)(\w+)\1\)/i);
    if (pragmaMatch) {
      const tableName = pragmaMatch[2];
      try {
        const [cols] = await this.pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
        return cols.map(c => ({
          name: c.Field,
          type: c.Type,
          notnull: c.Null === 'NO' ? 1 : 0,
          dflt_value: c.Default,
          pk: c.Key === 'PRI' ? 1 : 0
        }))[0] || null;
      } catch (err) {
        return null;
      }
    }

    if (/PRAGMA\s+foreign_keys/i.test(sql)) {
      return null;
    }

    const [rows] = await this.pool.query(sql, params);
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }
    return null;
  }

  async all(sql, params = []) {
    // Intercepta PRAGMA table_info para compatibilidade
    const pragmaMatch = sql.match(/PRAGMA\s+table_info\(([`"']?)(\w+)\1\)/i);
    if (pragmaMatch) {
      const tableName = pragmaMatch[2];
      try {
        const [cols] = await this.pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
        return cols.map(c => ({
          name: c.Field,
          type: c.Type,
          notnull: c.Null === 'NO' ? 1 : 0,
          dflt_value: c.Default,
          pk: c.Key === 'PRI' ? 1 : 0
        }));
      } catch (err) {
        return [];
      }
    }

    if (/PRAGMA\s+foreign_keys/i.test(sql)) {
      return [];
    }

    const [rows] = await this.pool.query(sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  async run(sql, params = []) {
    if (/PRAGMA\s+foreign_keys/i.test(sql)) {
      return { lastID: 0, changes: 0 };
    }

    const [result] = await this.pool.query(sql, params);
    return {
      lastID: result && result.insertId ? result.insertId : 0,
      changes: result && result.affectedRows !== undefined ? result.affectedRows : 0
    };
  }

  async exec(sql) {
    if (!sql || !sql.trim()) return;

    // Filtra instruções de PRAGMA exclusivas do SQLite
    const sanitizedSql = sql
      .replace(/PRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;?/gi, '')
      .replace(/PRAGMA\s+foreign_keys\s*;?/gi, '')
      .trim();

    if (!sanitizedSql) return;

    await this.pool.query(sanitizedSql);
  }
}

/**
 * Função auxiliar para garantir que colunas existam na tabela
 */
export async function ensureColumn(db, tableName, columnName, columnDefinition) {
  try {
    const cols = await db.all(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (!cols || cols.length === 0) {
      await db.exec(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
      console.log(`Database migration: Added "${columnName}" column to "${tableName}" table.`);
    }
  } catch (err) {
    console.error(`Migration check error for ${tableName}.${columnName}:`, err.message);
  }
}

export async function initDb() {
  console.log(`Connecting to MySQL server at ${dbHost}:${dbPort}...`);

  // 1. Conecta inicialmente ao MySQL sem selecionar banco para criar a base caso não exista
  const rootConn = await mysql.createConnection({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword
  });

  await rootConn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await rootConn.end();

  // 2. Cria o pool de conexões direcionado ao banco do ERP
  const pool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true,
    decimalNumbers: true,
    dateStrings: true
  });

  const db = new MySQLDatabaseAdapter(pool);

  // 3. Criação do Schema das Tabelas no MySQL

  // Tabela: usuarios
  await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      senha VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: clientes
  await db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      documento VARCHAR(50) DEFAULT NULL,
      email VARCHAR(255) DEFAULT NULL,
      telefone VARCHAR(50) DEFAULT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Ativo',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      rg VARCHAR(50) DEFAULT NULL,
      endereco VARCHAR(255) DEFAULT NULL,
      numero VARCHAR(50) DEFAULT NULL,
      complemento VARCHAR(255) DEFAULT NULL,
      bairro VARCHAR(100) DEFAULT NULL,
      cidade VARCHAR(100) DEFAULT NULL,
      uf VARCHAR(10) DEFAULT NULL,
      cep VARCHAR(20) DEFAULT NULL,
      entrega_endereco VARCHAR(255) DEFAULT NULL,
      entrega_numero VARCHAR(50) DEFAULT NULL,
      entrega_complemento VARCHAR(255) DEFAULT NULL,
      entrega_bairro VARCHAR(100) DEFAULT NULL,
      entrega_cidade VARCHAR(100) DEFAULT NULL,
      entrega_uf VARCHAR(10) DEFAULT NULL,
      entrega_cep VARCHAR(20) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: contratos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS contratos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cliente_id INT NOT NULL,
      numero VARCHAR(100) NOT NULL UNIQUE,
      valor DECIMAL(15,2) NOT NULL,
      data_inicio VARCHAR(50) NOT NULL,
      data_fim VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Ativo',
      drive_file_id VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: servicos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS servicos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      unidade INT NOT NULL DEFAULT 1,
      tempo INT NOT NULL,
      sequencia INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: ordens_servico
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ordens_servico (
      numero BIGINT PRIMARY KEY,
      data_abertura DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_fechamento DATETIME DEFAULT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Aberta',
      ambiente VARCHAR(255) DEFAULT NULL,
      cliente VARCHAR(255) DEFAULT NULL,
      qtd_pecas INT DEFAULT 0,
      qtd_chapas INT DEFAULT 0,
      qtd_especiais INT DEFAULT 0,
      qtd_caixa INT DEFAULT 0,
      tempo_previsto INT DEFAULT 0,
      tempo_real INT DEFAULT 0,
      cronograma LONGTEXT DEFAULT NULL,
      data_inicio DATETIME DEFAULT NULL,
      data_fim DATETIME DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: os_servicos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS os_servicos (
      os_numero BIGINT NOT NULL,
      servico_id INT NOT NULL,
      quantidade INT NOT NULL,
      tempo_previsto INT NOT NULL,
      data_inicio DATETIME DEFAULT NULL,
      data_fim DATETIME DEFAULT NULL,
      tempo_real INT DEFAULT NULL,
      PRIMARY KEY (os_numero, servico_id),
      FOREIGN KEY (os_numero) REFERENCES ordens_servico(numero) ON DELETE CASCADE,
      FOREIGN KEY (servico_id) REFERENCES servicos(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: os_pecas
  await db.exec(`
    CREATE TABLE IF NOT EXISTS os_pecas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      os_numero BIGINT NOT NULL,
      modulo VARCHAR(255) DEFAULT NULL,
      chapa VARCHAR(255) DEFAULT NULL,
      posicao VARCHAR(255) DEFAULT NULL,
      dimensoes VARCHAR(255) DEFAULT NULL,
      descricao VARCHAR(255) NOT NULL,
      codigo VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (os_numero) REFERENCES ordens_servico(numero) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: OS_Chapas
  await db.exec(`
    CREATE TABLE IF NOT EXISTS OS_Chapas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      os_numero BIGINT NOT NULL,
      cliente VARCHAR(255) DEFAULT NULL,
      projeto VARCHAR(255) DEFAULT NULL,
      chapa VARCHAR(255) DEFAULT NULL,
      acabamento VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (os_numero) REFERENCES ordens_servico(numero) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: OS_ChapasPecas
  await db.exec(`
    CREATE TABLE IF NOT EXISTS OS_ChapasPecas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chapa_id INT NOT NULL,
      item VARCHAR(255) DEFAULT NULL,
      descricao TEXT DEFAULT NULL,
      dimensao VARCHAR(255) DEFAULT NULL,
      descricao_pai VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chapa_id) REFERENCES OS_Chapas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: Parametro_Financeiro
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Parametro_Financeiro (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      situacao VARCHAR(50) DEFAULT 'Ativado',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: configuracoes_financeiras
  await db.exec(`
    CREATE TABLE IF NOT EXISTS configuracoes_financeiras (
      id INT AUTO_INCREMENT PRIMARY KEY,
      parametro_id INT NOT NULL UNIQUE,
      perc_imposto DECIMAL(5,2) DEFAULT 6.00,
      perc_comissao DECIMAL(5,2) DEFAULT 5.00,
      perc_custo_financeiro DECIMAL(5,2) DEFAULT 4.00,
      perc_markup_lucro DECIMAL(5,2) DEFAULT 20.00,
      perc_margem_minima DECIMAL(5,2) DEFAULT 10.00,
      metodo_calculo VARCHAR(50) DEFAULT 'divisor',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (parametro_id) REFERENCES Parametro_Financeiro(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: orcamentos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orcamentos (
      numero BIGINT PRIMARY KEY,
      data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
      cliente_id INT NOT NULL,
      descricao TEXT,
      status VARCHAR(50) DEFAULT 'Em Aberto',
      situacao VARCHAR(50) DEFAULT 'Em Aberto',
      parametro_financeiro_id INT DEFAULT 1,
      desconto_percentual DECIMAL(6,2) DEFAULT 0.00,
      desconto_valor DECIMAL(15,2) DEFAULT 0.00,
      total_venda DECIMAL(15,2) DEFAULT NULL,
      forma_pagamento_selecionada TEXT DEFAULT NULL,
      anotacoes_cliente TEXT DEFAULT NULL,
      anotacoes_conclusao TEXT DEFAULT NULL,
      data_aprovacao DATETIME DEFAULT NULL,
      data_entrada TEXT DEFAULT NULL,
      fluxo_financeiro TEXT DEFAULT NULL,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
      FOREIGN KEY (parametro_financeiro_id) REFERENCES Parametro_Financeiro(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: projetos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS projetos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orcamento_numero BIGINT NOT NULL,
      nome VARCHAR(255) NOT NULL,
      descricao TEXT,
      ProjetoURL TEXT DEFAULT NULL,
      ProjetoQtdPecas INT DEFAULT 0,
      CustoTotal DECIMAL(15,2) DEFAULT 0.00,
      CustoMaterial DECIMAL(15,2) DEFAULT 0.00,
      CustoProducao DECIMAL(15,2) DEFAULT 0.00,
      DuracaoFabricacao INT DEFAULT 0,
      DuracaoMontagem INT DEFAULT 0,
      perc_imposto DECIMAL(5,2) DEFAULT NULL,
      perc_comissao DECIMAL(5,2) DEFAULT NULL,
      perc_custo_financeiro DECIMAL(5,2) DEFAULT NULL,
      perc_markup_lucro DECIMAL(5,2) DEFAULT NULL,
      preco_venda_sugerido DECIMAL(15,2) DEFAULT 0.00,
      preco_venda_final DECIMAL(15,2) DEFAULT 0.00,
      parametro_financeiro_id INT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (orcamento_numero) REFERENCES orcamentos(numero) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: arquivos_importados
  await db.exec(`
    CREATE TABLE IF NOT EXISTS arquivos_importados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome_arquivo VARCHAR(255) NOT NULL,
      tamanho INT NOT NULL,
      tipo_layout VARCHAR(50) NOT NULL,
      caminho_arquivo VARCHAR(500) NOT NULL,
      projeto_id INT DEFAULT NULL,
      data_upload DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: Projeto_Materiais
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Materiais (
      id INT AUTO_INCREMENT PRIMARY KEY,
      projeto_id INT NOT NULL,
      referencia VARCHAR(255) NOT NULL,
      descricao TEXT NOT NULL,
      qtd DECIMAL(15,4) NOT NULL,
      un VARCHAR(50) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: projeto_anexos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS projeto_anexos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      projeto_id INT NOT NULL,
      nome_original VARCHAR(255) NOT NULL,
      nome_arquivo VARCHAR(255) NOT NULL,
      caminho VARCHAR(500) NOT NULL,
      tipo_mime VARCHAR(100) DEFAULT NULL,
      tamanho INT DEFAULT NULL,
      exibir_na_proposta VARCHAR(10) DEFAULT 'Sim',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      criado_por_nome VARCHAR(255) DEFAULT NULL,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: Projeto_Modulo
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Modulo (
      id INT AUTO_INCREMENT PRIMARY KEY,
      projeto_id INT NOT NULL,
      modulo VARCHAR(255) NOT NULL,
      peca VARCHAR(255) NOT NULL,
      imagem LONGTEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: Projeto_Chapa
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Chapa (
      id INT AUTO_INCREMENT PRIMARY KEY,
      projeto_id INT NOT NULL,
      chapa VARCHAR(255) NOT NULL,
      acabamento VARCHAR(255) NOT NULL,
      DescChapa TEXT DEFAULT NULL,
      item VARCHAR(255) NOT NULL,
      descricao TEXT NOT NULL,
      dimensao VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: Projeto_Pecas
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Pecas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      projeto_id INT NOT NULL,
      peca VARCHAR(255) NOT NULL,
      etiqueta VARCHAR(255) NOT NULL,
      dimen VARCHAR(255) NOT NULL,
      chapa VARCHAR(255) NOT NULL,
      modulo VARCHAR(255) NOT NULL,
      cod_item VARCHAR(255) NOT NULL,
      imagem LONGTEXT DEFAULT NULL,
      cor_barras VARCHAR(100) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: Material
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Material (
      MaterialReferencia VARCHAR(100) PRIMARY KEY,
      MaterialDescricao VARCHAR(255) NOT NULL,
      MaterialUnidade VARCHAR(20) DEFAULT NULL,
      MaterialValorUnitario DECIMAL(15,4) DEFAULT 0.0000,
      GrupoSigla VARCHAR(50) DEFAULT NULL,
      ProdutoGrupo INT DEFAULT 8,
      MaterialTipo VARCHAR(50) DEFAULT 'Produto',
      MaterialImagem LONGTEXT DEFAULT NULL,
      MaterialTempo INT DEFAULT 0,
      ExibirNaProposta VARCHAR(10) DEFAULT 'Nao'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: ProjetoItem
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ProjetoItem (
      ProjetoID INT NOT NULL,
      ProjetoItemID INT NOT NULL,
      MaterialReferencia VARCHAR(100) NOT NULL,
      ProjetoItemVlrUnit DECIMAL(15,2) NOT NULL,
      ProjetoItemUnidade VARCHAR(10) NOT NULL,
      ProjetoItemQtd DECIMAL(15,4) NOT NULL,
      ProjetoItemTotal DECIMAL(15,2) NOT NULL,
      ProjetoItemTempo INT DEFAULT 0,
      ProjetoItemDuracao INT DEFAULT 0,
      PRIMARY KEY (ProjetoID, ProjetoItemID),
      FOREIGN KEY (ProjetoID) REFERENCES projetos(id) ON DELETE CASCADE,
      FOREIGN KEY (MaterialReferencia) REFERENCES Material(MaterialReferencia)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: formas_pagamento
  await db.exec(`
    CREATE TABLE IF NOT EXISTS formas_pagamento (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      descricao TEXT DEFAULT NULL,
      valor_minimo DECIMAL(15,2) DEFAULT 0.00,
      valor_maximo DECIMAL(15,2) DEFAULT 0.00,
      ativo VARCHAR(10) NOT NULL DEFAULT 'Sim',
      ordem INT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: condicoes_pagamento
  await db.exec(`
    CREATE TABLE IF NOT EXISTS condicoes_pagamento (
      id INT AUTO_INCREMENT PRIMARY KEY,
      forma_pagamento_id INT NOT NULL,
      perc_entrada DECIMAL(5,2) DEFAULT 0.00,
      num_parcelas INT DEFAULT 0,
      perc_desconto DECIMAL(5,2) DEFAULT 0.00,
      meio_pagamento VARCHAR(50) DEFAULT '',
      descricao VARCHAR(255) NOT NULL,
      ordem INT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (forma_pagamento_id) REFERENCES formas_pagamento(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: proposta_compartilhamentos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS proposta_compartilhamentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orcamento_numero BIGINT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      criado_por INT DEFAULT NULL,
      criado_por_nome VARCHAR(255) DEFAULT NULL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      expira_em DATETIME NOT NULL,
      acessos_count INT DEFAULT 0,
      ultimo_acesso DATETIME DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'Ativo',
      aprovado_em DATETIME DEFAULT NULL,
      forma_pagamento_selecionada TEXT DEFAULT NULL,
      anotacoes_cliente TEXT DEFAULT NULL,
      FOREIGN KEY (orcamento_numero) REFERENCES orcamentos(numero) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: parametros_empresa
  await db.exec(`
    CREATE TABLE IF NOT EXISTS parametros_empresa (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chave VARCHAR(50) NOT NULL UNIQUE,
      tipo INT NOT NULL,
      conteudo VARCHAR(255) DEFAULT NULL,
      descricao TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 4. Migrações automáticas de colunas adicionais
  await ensureColumn(db, 'servicos', 'sequencia', 'INT DEFAULT 0');
  await ensureColumn(db, 'ordens_servico', 'cronograma', 'LONGTEXT DEFAULT NULL');
  await ensureColumn(db, 'Material', 'ExibirNaProposta', "VARCHAR(10) DEFAULT 'Nao'");
  await ensureColumn(db, 'Material', 'ProdutoGrupo', 'INT DEFAULT 8');
  await ensureColumn(db, 'Material', 'MaterialTempo', 'INT DEFAULT 0');
  await ensureColumn(db, 'projetos', 'ProjetoURL', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'projetos', 'ProjetoQtdPecas', 'INT DEFAULT 0');
  await ensureColumn(db, 'projetos', 'CustoMaterial', 'DECIMAL(15,2) DEFAULT 0.00');
  await ensureColumn(db, 'projetos', 'CustoProducao', 'DECIMAL(15,2) DEFAULT 0.00');
  await ensureColumn(db, 'projetos', 'DuracaoFabricacao', 'INT DEFAULT 0');
  await ensureColumn(db, 'projetos', 'DuracaoMontagem', 'INT DEFAULT 0');
  await ensureColumn(db, 'projetos', 'perc_imposto', 'DECIMAL(5,2) DEFAULT NULL');
  await ensureColumn(db, 'projetos', 'perc_comissao', 'DECIMAL(5,2) DEFAULT NULL');
  await ensureColumn(db, 'projetos', 'perc_custo_financeiro', 'DECIMAL(5,2) DEFAULT NULL');
  await ensureColumn(db, 'projetos', 'perc_markup_lucro', 'DECIMAL(5,2) DEFAULT NULL');
  await ensureColumn(db, 'projetos', 'preco_venda_sugerido', 'DECIMAL(15,2) DEFAULT 0.00');
  await ensureColumn(db, 'projetos', 'preco_venda_final', 'DECIMAL(15,2) DEFAULT 0.00');
  await ensureColumn(db, 'projetos', 'parametro_financeiro_id', 'INT DEFAULT 1');

  await ensureColumn(db, 'orcamentos', 'parametro_financeiro_id', 'INT DEFAULT 1');
  await ensureColumn(db, 'orcamentos', 'desconto_percentual', 'DECIMAL(6,2) DEFAULT 0.00');
  await ensureColumn(db, 'orcamentos', 'desconto_valor', 'DECIMAL(15,2) DEFAULT 0.00');
  await ensureColumn(db, 'orcamentos', 'total_venda', 'DECIMAL(15,2) DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'forma_pagamento_selecionada', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'anotacoes_cliente', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'anotacoes_conclusao', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'data_aprovacao', 'DATETIME DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'data_entrada', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'fluxo_financeiro', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'status', "VARCHAR(50) DEFAULT 'Em Aberto'");
  await ensureColumn(db, 'orcamentos', 'situacao', "VARCHAR(50) DEFAULT 'Em Aberto'");

  await ensureColumn(db, 'projeto_anexos', 'exibir_na_proposta', "VARCHAR(10) DEFAULT 'Sim'");
  await ensureColumn(db, 'proposta_compartilhamentos', 'aprovado_em', 'DATETIME DEFAULT NULL');
  await ensureColumn(db, 'proposta_compartilhamentos', 'forma_pagamento_selecionada', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'proposta_compartilhamentos', 'anotacoes_cliente', 'TEXT DEFAULT NULL');

  // 5. Seeds padrão caso o banco esteja vazio

  // Seed default Parametro_Financeiro and configuracoes_financeiras
  const existingParam = await db.get('SELECT * FROM Parametro_Financeiro WHERE id = 1');
  if (!existingParam) {
    await db.run(`INSERT INTO Parametro_Financeiro (id, nome, situacao) VALUES (1, 'Padrão Fábrica', 'Ativado')`);
    await db.run(`
      INSERT INTO configuracoes_financeiras (id, parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
      VALUES (1, 1, 6.00, 5.00, 4.00, 20.00, 10.00, 'divisor')
    `);
  }

  // Seed default admin user
  const adminEmail = 'admin@erp.com';
  const existingAdmin = await db.get('SELECT * FROM usuarios WHERE email = ?', [adminEmail]);
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await db.run(
      'INSERT INTO usuarios (nome, email, senha, role) VALUES (?, ?, ?, ?)',
      ['Administrador', adminEmail, hashedPassword, 'admin']
    );
    console.log('Seeded default admin user: admin@erp.com / admin123');
  }

  // Seed default clients if empty
  const clientsCount = await db.get('SELECT COUNT(*) as count FROM clientes');
  if (clientsCount && (clientsCount.count === 0 || clientsCount.count === '0')) {
    await db.run('INSERT INTO clientes (nome, documento, email, telefone, status) VALUES (?, ?, ?, ?, ?)', [
      'Tech Solutions Ltda',
      '12.345.678/0001-99',
      'contato@techsolutions.com',
      '(11) 98888-7777',
      'Ativo'
    ]);
    await db.run('INSERT INTO clientes (nome, documento, email, telefone, status) VALUES (?, ?, ?, ?, ?)', [
      'Indústrias Metalúrgicas Alfa',
      '98.765.432/0001-88',
      'financeiro@indalfa.com',
      '(19) 3456-7890',
      'Ativo'
    ]);
    await db.run('INSERT INTO clientes (nome, documento, email, telefone, status) VALUES (?, ?, ?, ?, ?)', [
      'Comércio Varejista Beta',
      '45.678.901/0001-22',
      'contato@lojasbeta.com.br',
      '(21) 2233-4455',
      'Inativo'
    ]);
    console.log('Seeded initial mock clients');
  }

  // Seed default contracts if empty
  const contractsCount = await db.get('SELECT COUNT(*) as count FROM contratos');
  if (contractsCount && (contractsCount.count === 0 || contractsCount.count === '0')) {
    const client1 = await db.get('SELECT id FROM clientes WHERE nome = ?', ['Tech Solutions Ltda']);
    const client2 = await db.get('SELECT id FROM clientes WHERE nome = ?', ['Indústrias Metalúrgicas Alfa']);

    if (client1) {
      await db.run('INSERT INTO contratos (cliente_id, numero, valor, data_inicio, data_fim, status) VALUES (?, ?, ?, ?, ?, ?)', [
        client1.id,
        'CTR-2026-0001',
        15000.00,
        '2026-01-01',
        '2026-12-31',
        'Ativo'
      ]);
    }
    if (client2) {
      await db.run('INSERT INTO contratos (cliente_id, numero, valor, data_inicio, data_fim, status) VALUES (?, ?, ?, ?, ?, ?)', [
        client2.id,
        'CTR-2026-0002',
        42500.00,
        '2026-02-15',
        '2027-02-14',
        'Ativo'
      ]);
    }
    console.log('Seeded initial mock contracts');
  }

  // Seed default services if empty
  const servicesCount = await db.get('SELECT COUNT(*) as count FROM servicos');
  if (servicesCount && (servicesCount.count === 0 || servicesCount.count === '0')) {
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', ['Separação', 1, 15, 5]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', ['Usinagem', 2, 45, 10]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', ['Fitagem', 3, 10, 20]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', ['Montagem de caixa', 4, 30, 30]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', ['Especial', 6, 60, 40]);
    console.log('Seeded initial mock services');
  }

  // Seed default Work Orders if empty
  const osCount = await db.get('SELECT COUNT(*) as count FROM ordens_servico');
  if (osCount && (osCount.count === 0 || osCount.count === '0')) {
    const client = await db.get('SELECT id FROM clientes ORDER BY id ASC LIMIT 1');
    const service1 = await db.get('SELECT id, tempo FROM servicos WHERE nome = ?', ['Usinagem']);
    const service2 = await db.get('SELECT id, tempo FROM servicos WHERE nome = ?', ['Fitagem']);

    if (client && service1 && service2) {
      const osNum = 2026000001;
      await db.run(
        'INSERT INTO ordens_servico (numero, status, ambiente, cliente, qtd_pecas, qtd_chapas, qtd_especiais, qtd_caixa, tempo_previsto, tempo_real, data_inicio, data_fim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [osNum, 'Aberta', 'Planta B - Linha 2', 'Tech Solutions Ltda', 0, 5, 2, 3, 100, 0, null, null]
      );
      await db.run(
        'INSERT INTO os_servicos (os_numero, servico_id, quantidade, tempo_previsto) VALUES (?, ?, ?, ?)',
        [osNum, service1.id, 2, 90]
      );
      await db.run(
        'INSERT INTO os_servicos (os_numero, servico_id, quantidade, tempo_previsto) VALUES (?, ?, ?, ?)',
        [osNum, service2.id, 1, 10]
      );
      console.log('Seeded initial mock Work Order: 2026000001');
    }
  }

  // Seed default budgets if empty
  const budgetsCount = await db.get('SELECT COUNT(*) as count FROM orcamentos');
  if (budgetsCount && (budgetsCount.count === 0 || budgetsCount.count === '0')) {
    const client = await db.get('SELECT id FROM clientes ORDER BY id ASC LIMIT 1');
    if (client) {
      const year = new Date().getFullYear();
      await db.run(
        'INSERT INTO orcamentos (numero, cliente_id, descricao) VALUES (?, ?, ?)',
        [year * 1000000 + 1, client.id, 'Orçamento de móveis planejados para o escritório corporativo. Inclui mesas, gaveteiros e armários aéreos.']
      );
      console.log('Seeded initial mock Budget');
    }
  }

  // Seed default projects if empty
  const projectsCount = await db.get('SELECT COUNT(*) as count FROM projetos');
  if (projectsCount && (projectsCount.count === 0 || projectsCount.count === '0')) {
    const budget = await db.get('SELECT numero FROM orcamentos ORDER BY numero ASC LIMIT 1');
    if (budget) {
      await db.run(
        'INSERT INTO projetos (orcamento_numero, nome, descricao) VALUES (?, ?, ?)',
        [budget.numero, 'Cozinha Planejada Residencial', 'Projeto de armários em MDF Ultra resistente a umidade para a cozinha.']
      );
      await db.run(
        'INSERT INTO projetos (orcamento_numero, nome, descricao) VALUES (?, ?, ?)',
        [budget.numero, 'Painel de TV Sala de Estar', 'Painel ripado com iluminação LED embutida.']
      );
      console.log('Seeded initial mock Projects');
    }
  }

  // Seed FAB.MON.CLI in Material if not exists
  const fabMonCli = await db.get("SELECT MaterialReferencia FROM Material WHERE MaterialReferencia = 'FAB.MON.CLI'");
  if (!fabMonCli) {
    await db.run(
      `INSERT INTO Material (MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['FAB.MON.CLI', 'Montagem cliente', 'DIA', 0.0, null, 8, 'Serviço', 0]
    );
    console.log("Migration: Seeded FAB.MON.CLI in Material table.");
  }

  // Seed Formas de Pagamento & Condicoes de Pagamento if empty
  const countFormas = await db.get('SELECT COUNT(*) as cnt FROM formas_pagamento');
  if (countFormas && (countFormas.cnt === 0 || countFormas.cnt === '0')) {
    const resForma = await db.run(
      `INSERT INTO formas_pagamento (nome, descricao, valor_minimo, valor_maximo, ativo, ordem)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['Orçamento até 10 mil', 'Condições para orçamentos de até R$ 10.000,00', 0, 10000, 'Sim', 1]
    );
    const formaId = resForma.lastID;

    if (formaId) {
      await db.run(
        `INSERT INTO condicoes_pagamento (forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [formaId, 100, 0, 10, '', 'À vista - 10% desc', 1]
      );
      await db.run(
        `INSERT INTO condicoes_pagamento (forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [formaId, 50, 1, 5, '', 'Entrada 50% + saldo entrega', 2]
      );
      await db.run(
        `INSERT INTO condicoes_pagamento (forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [formaId, 40, 3, 0, 'C.Crédito', 'Entrada 40% + 3x C.Crédito', 3]
      );
      console.log('Database seed: Formas de Pagamento e Condições criadas com sucesso.');
    }
  }

  // Seed ParametrosEmpresa if empty
  const paramsCount = await db.get('SELECT COUNT(*) as count FROM parametros_empresa');
  if (paramsCount && (paramsCount.count === 0 || paramsCount.count === '0')) {
    const seedParams = [
      { chave: 'RAZAO_SOC', tipo: 1, conteudo: 'EZATTUS PLANEJADOS LTDA', descricao: 'Razão social oficial da empresa' },
      { chave: 'NOME_FANT', tipo: 1, conteudo: 'EZATTUS PLANEJADOS', descricao: 'Nome fantasia da marca' },
      { chave: 'CNPJ', tipo: 1, conteudo: '12.345.678/0001-90', descricao: 'CNPJ da matriz' },
      { chave: 'VAL_HORA', tipo: 2, conteudo: '85.00', descricao: 'Valor da hora técnica padrão (R$)' },
      { chave: 'DT_FUNDAC', tipo: 3, conteudo: '2015-06-10', descricao: 'Data de fundação da empresa' },
      { chave: 'DESC_MAX', tipo: 4, conteudo: '15.00', descricao: 'Percentual de desconto máximo para vendedores (%)' },
      { chave: 'MIN_PECAS', tipo: 5, conteudo: '1 UN', descricao: 'Lote mínimo padrão de peças por projeto' },
      { chave: 'HORA_INI', tipo: 6, conteudo: '08:00', descricao: 'Horário de início do expediente' },
      { chave: 'EMP_LOGO', tipo: 7, conteudo: '', descricao: 'Logomarca da empresa para cabeçalhos e documentos' },
      { chave: 'EMP_ASS', tipo: 7, conteudo: '', descricao: 'Assinatura do responsável para contratos e recibos' }
    ];

    for (const p of seedParams) {
      await db.run(
        'INSERT INTO parametros_empresa (chave, tipo, conteudo, descricao) VALUES (?, ?, ?, ?)',
        [p.chave, p.tipo, p.conteudo, p.descricao]
      );
    }
    console.log('Database seed: Parâmetros da Empresa inseridos com sucesso.');
  }

  return db;
}
