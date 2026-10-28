import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMultiTenantMigrations, runNovaContaMigration, ensureCompanyProfilesAndPermissions } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carrega variáveis de ambiente da raiz, da pasta backend ou do diretório atual
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

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

    const trimmed = (sql || '').trim().replace(/;$/, '').toUpperCase();
    if (
      trimmed === 'BEGIN TRANSACTION' ||
      trimmed === 'BEGIN' ||
      trimmed === 'START TRANSACTION' ||
      trimmed === 'COMMIT' ||
      trimmed === 'ROLLBACK'
    ) {
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

    const trimmed = sanitizedSql.replace(/;$/, '').toUpperCase();
    if (
      trimmed === 'BEGIN TRANSACTION' ||
      trimmed === 'BEGIN' ||
      trimmed === 'START TRANSACTION' ||
      trimmed === 'COMMIT' ||
      trimmed === 'ROLLBACK'
    ) {
      return;
    }

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

export async function initDb(options = {}) {
  const isPlaceholderEnv = !process.env.DB_USER || process.env.DB_USER === 'u123456_erp';
  const rawHost = isPlaceholderEnv ? '127.0.0.1' : (process.env.DB_HOST || '127.0.0.1');
  const dbHost = (rawHost === 'localhost' || rawHost === '::1') ? '127.0.0.1' : rawHost;
  const dbPort = parseInt(process.env.DB_PORT || '3306', 10);
  let dbUser = isPlaceholderEnv ? 'u510090903_admin' : process.env.DB_USER;
  let dbPassword = (isPlaceholderEnv || process.env.DB_PASSWORD === 'sua_senha_do_banco' || process.env.DB_PASSWORD === undefined)
    ? 'Erp!Db_2026#xQ7m'
    : process.env.DB_PASSWORD;
  let dbName = (isPlaceholderEnv || process.env.DB_NAME === 'u123456_erp_chaodefabrica' || !process.env.DB_NAME)
    ? 'u510090903_erp'
    : process.env.DB_NAME;

  console.log(`Connecting to MySQL server at ${dbHost}:${dbPort} (database: ${dbName})...`);

  // 1. Tenta criar a base caso não exista (em hospedagens compartilhadas como Hostinger o banco já existe e o usuário não tem permissão CREATE DATABASE)
  try {
    const rootConn = await mysql.createConnection({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      connectTimeout: 10000
    });

    await rootConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await rootConn.end();
  } catch (createDbErr) {
    // Se estiver em ambiente de desenvolvimento local e a credencial da Hostinger falhar com ER_ACCESS_DENIED_ERROR, usa o MySQL local (root / erp_chaodefabrica)
    if (createDbErr.code === 'ER_ACCESS_DENIED_ERROR' && dbHost === '127.0.0.1' && dbUser === 'u510090903_admin' && process.env.NODE_ENV !== 'production') {
      try {
        const localConn = await mysql.createConnection({
          host: '127.0.0.1',
          port: dbPort,
          user: 'root',
          password: '',
          connectTimeout: 5000
        });
        dbUser = 'root';
        dbPassword = '';
        dbName = process.env.LOCAL_DB_NAME || 'erp_chaodefabrica';
        await localConn.query(
          `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        await localConn.end();
        console.log(`[Dev Local] Conectado ao MySQL local com usuário "${dbUser}" e banco "${dbName}".`);
      } catch (localErr) {
        console.warn(`Aviso: CREATE DATABASE ignorado (${createDbErr.code || createDbErr.message}). Conectando diretamente ao banco "${dbName}"...`);
      }
    } else {
      console.warn(`Aviso: CREATE DATABASE ignorado (${createDbErr.code || createDbErr.message}). Conectando diretamente ao banco "${dbName}"...`);
    }
  }

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
    dateStrings: true,
    connectTimeout: 10000
  });

  // Valida a conexão antes de rodar migrações
  await pool.query('SELECT 1');

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
      tipo_pessoa VARCHAR(20) NOT NULL DEFAULT 'Física',
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

  // Migração: Renomear Ordem_Controle para Ordem_Servico se existir
  try {
    const tableControle = await db.all("SHOW TABLES LIKE 'Ordem_Controle'");
    const tableServico = await db.all("SHOW TABLES LIKE 'Ordem_Servico'");
    if (tableControle && tableControle.length > 0 && (!tableServico || tableServico.length === 0)) {
      await db.exec('RENAME TABLE `Ordem_Controle` TO `Ordem_Servico`');
      console.log('Tabela Ordem_Controle renomeada para Ordem_Servico com sucesso.');
    }
  } catch (renameErr) {
    console.warn('Aviso ao renomear Ordem_Controle para Ordem_Servico:', renameErr.message);
  }

  // Tabela: Ordem_Servico (PK composta: Numero, ProjetoID)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Ordem_Servico (
      Numero BIGINT NOT NULL,
      ProjetoID DECIMAL(3,0) NOT NULL DEFAULT 1,
      DataCriacao DATE DEFAULT NULL,
      DataConclusao DATE DEFAULT NULL,
      Situacao VARCHAR(20) NOT NULL DEFAULT 'Aberta',
      Responsavel VARCHAR(20) DEFAULT NULL,
      NomeProjeto VARCHAR(255) DEFAULT NULL,
      Tempo INT DEFAULT 0,
      PRIMARY KEY (Numero, ProjetoID)
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
      peca VARCHAR(255) DEFAULT NULL,
      etiqueta VARCHAR(255) DEFAULT NULL,
      dimen VARCHAR(255) DEFAULT NULL,
      chapa VARCHAR(255) DEFAULT NULL,
      modulo VARCHAR(255) DEFAULT NULL,
      cod_item VARCHAR(255) DEFAULT NULL,
      imagem LONGTEXT DEFAULT NULL,
      cor_barras LONGTEXT DEFAULT NULL,
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

  // Tabela: propostas (Versões de Proposta Comercial)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS propostas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orcamento_numero BIGINT NOT NULL,
      versao INT NOT NULL DEFAULT 1,
      codigo VARCHAR(50) DEFAULT '',
      titulo VARCHAR(255) DEFAULT '',
      descricao TEXT DEFAULT NULL,
      valor_total DECIMAL(15,2) DEFAULT 0.00,
      desconto_percentual DECIMAL(6,2) DEFAULT 0.00,
      desconto_valor DECIMAL(15,2) DEFAULT 0.00,
      valor_final DECIMAL(15,2) DEFAULT 0.00,
      forma_pagamento_selecionada TEXT DEFAULT NULL,
      dados_snapshot LONGTEXT DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'Gerada',
      observacoes TEXT DEFAULT NULL,
      criado_por INT DEFAULT NULL,
      criado_por_nome VARCHAR(255) DEFAULT NULL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_orcamento_numero (orcamento_numero),
      INDEX idx_versao (versao),
      FOREIGN KEY (orcamento_numero) REFERENCES orcamentos(numero) ON DELETE CASCADE
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

  // Tabela: FluxoRecebimento
  await db.exec(`
    CREATE TABLE IF NOT EXISTS FluxoRecebimento (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orcamento_numero BIGINT NOT NULL,
      cliente_id INT DEFAULT NULL,
      cliente_nome VARCHAR(255) DEFAULT NULL,
      descricao VARCHAR(255) NOT NULL,
      tipo VARCHAR(50) DEFAULT 'Parcela',
      numero_parcela INT DEFAULT 1,
      total_parcelas INT DEFAULT 1,
      percentual DECIMAL(6,2) DEFAULT 0.00,
      valor DECIMAL(15,2) NOT NULL,
      valor_recebido DECIMAL(15,2) DEFAULT 0.00,
      data_vencimento VARCHAR(50) NOT NULL,
      data_recebimento VARCHAR(50) DEFAULT NULL,
      meio_pagamento VARCHAR(100) DEFAULT 'PIX',
      status VARCHAR(50) NOT NULL DEFAULT 'Pendente',
      recibo_emitido VARCHAR(10) NOT NULL DEFAULT 'Nao',
      observacoes TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_orcamento_numero (orcamento_numero),
      INDEX idx_cliente_id (cliente_id),
      INDEX idx_status (status),
      INDEX idx_data_vencimento (data_vencimento)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Tabela: ordem_servico_checklist (Checklist da Revisão Técnica da Ordem de Serviço)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ordem_servico_checklist (
      id INT AUTO_INCREMENT PRIMARY KEY,
      numero BIGINT NOT NULL,
      projeto_id DECIMAL(3,0) NOT NULL DEFAULT 1,
      tarefa_key VARCHAR(50) NOT NULL,
      tarefa_texto TEXT NOT NULL,
      concluido TINYINT DEFAULT 0,
      data_conclusao DATETIME DEFAULT NULL,
      responsavel VARCHAR(255) DEFAULT NULL,
      observacao TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_os_tarefa (numero, projeto_id, tarefa_key),
      INDEX idx_os_checklist (numero, projeto_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 4. Migrações automáticas de colunas adicionais
  await ensureColumn(db, 'servicos', 'sequencia', 'INT DEFAULT 0');
  await ensureColumn(db, 'clientes', 'tipo_pessoa', "VARCHAR(20) NOT NULL DEFAULT 'Física'");

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
  await ensureColumn(db, 'orcamentos', 'fluxo_efetivado', 'TINYINT DEFAULT 0');
  await ensureColumn(db, 'orcamentos', 'status', "VARCHAR(50) DEFAULT 'Em Aberto'");
  await ensureColumn(db, 'orcamentos', 'situacao', "VARCHAR(50) DEFAULT 'Em Aberto'");
  await ensureColumn(db, 'orcamentos', 'data_assinatura', 'DATETIME DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'assinatura_responsavel', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'orcamentos', 'usuario_assinatura_nome', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumn(db, 'usuarios', 'assinatura', 'TEXT DEFAULT NULL');

  await ensureColumn(db, 'projeto_anexos', 'exibir_na_proposta', "VARCHAR(10) DEFAULT 'Sim'");
  await ensureColumn(db, 'proposta_compartilhamentos', 'aprovado_em', 'DATETIME DEFAULT NULL');
  await ensureColumn(db, 'proposta_compartilhamentos', 'forma_pagamento_selecionada', 'TEXT DEFAULT NULL');
  await ensureColumn(db, 'proposta_compartilhamentos', 'proposta_id', 'INT DEFAULT NULL');

  await ensureColumn(db, 'Ordem_Servico', 'ProjetoID', 'DECIMAL(3,0) NOT NULL DEFAULT 1');
  await ensureColumn(db, 'Ordem_Servico', 'NomeProjeto', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumn(db, 'Ordem_Servico', 'Tempo', 'INT DEFAULT 0');
  await ensureColumn(db, 'Ordem_Servico', 'DataCriacao', 'DATE DEFAULT NULL');
  await ensureColumn(db, 'Ordem_Servico', 'DataConclusao', 'DATE DEFAULT NULL');
  await ensureColumn(db, 'Ordem_Servico', 'Situacao', "VARCHAR(20) NOT NULL DEFAULT 'Aberta'");
  await ensureColumn(db, 'Ordem_Servico', 'Responsavel', 'VARCHAR(20) DEFAULT NULL');

  // Garantir PK composta (Numero, ProjetoID) em Ordem_Servico
  try {
    const pkCols = await db.all(`
      SELECT COLUMN_NAME 
      FROM information_schema.KEY_COLUMN_USAGE 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Ordem_Servico' AND CONSTRAINT_NAME = 'PRIMARY'
    `);
    const pkNames = pkCols ? pkCols.map(c => c.COLUMN_NAME) : [];
    if (!pkNames.includes('ProjetoID')) {
      await db.exec('ALTER TABLE `Ordem_Servico` DROP PRIMARY KEY, ADD PRIMARY KEY (`Numero`, `ProjetoID`)');
      console.log('PK da tabela Ordem_Servico atualizada para (Numero, ProjetoID).');
    }
  } catch (pkErr) {
    console.warn('Aviso ao atualizar PK de Ordem_Servico:', pkErr.message);
  }

  // Garantir que Projeto_Pecas.cor_barras seja LONGTEXT (para comportar base64 da imagem do código de barras)
  try {
    const colInfo = await db.get(`
      SELECT DATA_TYPE 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Projeto_Pecas' AND COLUMN_NAME = 'cor_barras'
    `);
    if (colInfo && colInfo.DATA_TYPE !== 'longtext') {
      await db.exec('ALTER TABLE `Projeto_Pecas` MODIFY COLUMN `cor_barras` LONGTEXT DEFAULT NULL');
      console.log('Coluna cor_barras da tabela Projeto_Pecas atualizada para LONGTEXT.');
    }
  } catch (err) {
    console.warn('Aviso ao verificar coluna cor_barras de Projeto_Pecas:', err.message);
  }

  // 5. Executa a migração versionada multiempresa (empresas, funcoes, perfis, perfil_funcoes, auditoria, FKs compostas e índices)
  const migrationInfo = await runMultiTenantMigrations(pool, options);
  const defaultEmpresaId = migrationInfo.defaultEmpresaId || 1;

  // 5.1 Executa a migração versionada para suporte a Nova Conta (tipo_pessoa, cpf_cnpj, login, situacao, datas, vigência e perfil Master)
  await runNovaContaMigration(pool);

  // 6. Seeds padrão para a empresa inicial caso o banco esteja vazio
  await seedCompanyDefaults(db, defaultEmpresaId);

  // Seed default admin user para a empresa inicial se não existir
  const adminEmail = 'admin@erp.com';
  const existingAdmin = await db.get('SELECT * FROM usuarios WHERE email = ?', [adminEmail]);
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const adminPerfil = await db.get(
      `SELECT id FROM perfis WHERE empresa_id = ? AND nome = 'Administrador' LIMIT 1`,
      [defaultEmpresaId]
    );
    await db.run(
      'INSERT INTO usuarios (empresa_id, perfil_id, nome, email, senha, role, ativo) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [defaultEmpresaId, adminPerfil ? adminPerfil.id : null, 'Administrador', adminEmail, hashedPassword, 'admin']
    );
    console.log('Seeded default admin user: admin@erp.com / admin123');
  }

  return db;
}

/**
 * Inicializa cadastros básicos obrigatórios para uma empresa (perfis, parâmetro financeiro, serviços, FAB.*, formas de pagamento e parâmetros institucionais).
 */
export async function seedCompanyDefaults(db, empresaId, companyInfo = {}) {
  await ensureCompanyProfilesAndPermissions(db.pool, empresaId);

  // Parâmetro Financeiro padrão da empresa
  const existingParam = await db.get(
    'SELECT * FROM Parametro_Financeiro WHERE empresa_id = ? ORDER BY id ASC LIMIT 1',
    [empresaId]
  );
  if (!existingParam) {
    const resParam = await db.run(
      `INSERT INTO Parametro_Financeiro (empresa_id, nome, situacao) VALUES (?, 'Padrão Fábrica', 'Ativado')`,
      [empresaId]
    );
    if (resParam.lastID) {
      await db.run(
        `INSERT INTO configuracoes_financeiras (empresa_id, parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
         VALUES (?, ?, 6.00, 5.00, 4.00, 20.00, 10.00, 'divisor')`,
        [empresaId, resParam.lastID]
      );
    }
  }

  // Serviços padrão da empresa
  const servicesCount = await db.get('SELECT COUNT(*) as count FROM servicos WHERE empresa_id = ?', [empresaId]);
  if (servicesCount && Number(servicesCount.count) === 0) {
    const defaultServices = [
      ['Separação', 1, 15, 5],
      ['Usinagem', 2, 45, 10],
      ['Fitagem', 3, 10, 20],
      ['Montagem de caixa', 4, 30, 30],
      ['Especial', 6, 60, 40]
    ];
    for (const [nome, unidade, tempo, sequencia] of defaultServices) {
      await db.run(
        'INSERT INTO servicos (empresa_id, nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?, ?)',
        [empresaId, nome, unidade, tempo, sequencia]
      );
    }
  }

  // Itens de fabricação padrão no catálogo Material da empresa
  const defaultFabMaterials = [
    ['FAB.USI.CHP', 'Usinagem de chapas', 'CHP', 0.0, 'FAB', 8, 'Serviço', 10],
    ['FAB.FIT.PCA', 'Fitagem', 'M', 0.0, 'FAB', 8, 'Serviço', 1],
    ['FAB.MON.CXA', 'Montagem caixa', 'UND', 0.0, 'FAB', 8, 'Serviço', 15],
    ['FAB.ESP.PCA', 'Item especial', 'UND', 0.0, 'FAB', 8, 'Serviço', 30],
    ['FAB.EMB.UND', 'Embalagem', 'UND', 0.0, 'FAB', 8, 'Serviço', 5],
    ['FAB.MON.CLI', 'Montagem cliente', 'DIA', 0.0, 'FAB', 8, 'Serviço', 0]
  ];
  for (const [ref, desc, un, vlr, sigla, grupo, tipo, tempo] of defaultFabMaterials) {
    const exists = await db.get(
      'SELECT MaterialReferencia FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?',
      [empresaId, ref]
    );
    if (!exists) {
      await db.run(
        `INSERT INTO Material (empresa_id, MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [empresaId, ref, desc, un, vlr, sigla, grupo, tipo, tempo]
      );
    }
  }

  // Formas e condições de pagamento padrão da empresa
  const countFormas = await db.get('SELECT COUNT(*) as cnt FROM formas_pagamento WHERE empresa_id = ?', [empresaId]);
  if (countFormas && Number(countFormas.cnt) === 0) {
    const resForma = await db.run(
      `INSERT INTO formas_pagamento (empresa_id, nome, descricao, valor_minimo, valor_maximo, ativo, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [empresaId, 'Orçamento até 10 mil', 'Condições para orçamentos de até R$ 10.000,00', 0, 10000, 'Sim', 1]
    );
    const formaId = resForma.lastID;
    if (formaId) {
      await db.run(
        `INSERT INTO condicoes_pagamento (empresa_id, forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [empresaId, formaId, 100, 0, 10, '', 'À vista - 10% desc', 1]
      );
      await db.run(
        `INSERT INTO condicoes_pagamento (empresa_id, forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [empresaId, formaId, 50, 1, 5, '', 'Entrada 50% + saldo entrega', 2]
      );
      await db.run(
        `INSERT INTO condicoes_pagamento (empresa_id, forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [empresaId, formaId, 40, 3, 0, 'C.Crédito', 'Entrada 40% + 3x C.Crédito', 3]
      );
    }
  }

  // Parâmetros institucionais da empresa
  const paramsCount = await db.get('SELECT COUNT(*) as count FROM parametros_empresa WHERE empresa_id = ?', [empresaId]);
  if (paramsCount && Number(paramsCount.count) === 0) {
    const seedParams = [
      { chave: 'RAZAO_SOC', tipo: 1, conteudo: companyInfo.razao_social || 'EZATTUS PLANEJADOS LTDA', descricao: 'Razão social oficial da empresa' },
      { chave: 'NOME_FANT', tipo: 1, conteudo: companyInfo.nome_fantasia || 'EZATTUS PLANEJADOS', descricao: 'Nome fantasia da marca' },
      { chave: 'CNPJ', tipo: 1, conteudo: companyInfo.cnpj || '12.345.678/0001-90', descricao: 'CNPJ da matriz' },
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
        'INSERT INTO parametros_empresa (empresa_id, chave, tipo, conteudo, descricao) VALUES (?, ?, ?, ?, ?)',
        [empresaId, p.chave, p.tipo, p.conteudo, p.descricao]
      );
    }
  }
}
