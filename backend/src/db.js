import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const rawDbPath = process.env.DATABASE_PATH || './database/erp.db';
const dbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(process.cwd(), rawDbPath);
const dbDir = path.dirname(dbPath);

// Ensure database directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export async function initDb() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.get('PRAGMA foreign_keys = ON');

  // Drop tables for schema migrations cleanly
  // Comentado para habilitar persistência de dados.
  /*
  try {
    await db.run('PRAGMA foreign_keys = OFF');
    await db.exec('DROP TABLE IF EXISTS OS_ChapasPecas');
    await db.exec('DROP TABLE IF EXISTS OS_Chapas');
    await db.exec('DROP TABLE IF EXISTS os_pecas');
    await db.exec('DROP TABLE IF EXISTS os_servicos');
    await db.exec('DROP TABLE IF EXISTS ordens_servico');
    await db.exec('DROP TABLE IF EXISTS servicos');
    await db.exec('DROP TABLE IF EXISTS Material');
    await db.exec('DROP TABLE IF EXISTS Projeto_Pecas');
    await db.exec('DROP TABLE IF EXISTS Projeto_Chapa');
    await db.exec('DROP TABLE IF EXISTS Projeto_Modulo');
    await db.exec('DROP TABLE IF EXISTS Projeto_Materiais');
    await db.exec('DROP TABLE IF EXISTS ProjetoItem');
    await db.exec('DROP TABLE IF EXISTS arquivos_importados');
    await db.exec('DROP TABLE IF EXISTS projetos');
    await db.exec('DROP TABLE IF EXISTS orcamentos');
    await db.run('PRAGMA foreign_keys = ON');
    console.log('Migration drop tables successful.');
  } catch (err) {
    console.error('Migration drop tables error:', err);
  }
  */

  // Create Users Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Clients Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      documento TEXT,
      email TEXT,
      telefone TEXT,
      status TEXT NOT NULL DEFAULT 'Ativo',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    const tableInfo = await db.all('PRAGMA table_info(clientes)');
    const colNames = tableInfo.map(c => c.name);
    if (!colNames.includes('rg')) await db.exec("ALTER TABLE clientes ADD COLUMN rg TEXT");
    if (!colNames.includes('endereco')) await db.exec("ALTER TABLE clientes ADD COLUMN endereco TEXT");
    if (!colNames.includes('numero')) await db.exec("ALTER TABLE clientes ADD COLUMN numero TEXT");
    if (!colNames.includes('complemento')) await db.exec("ALTER TABLE clientes ADD COLUMN complemento TEXT");
    if (!colNames.includes('bairro')) await db.exec("ALTER TABLE clientes ADD COLUMN bairro TEXT");
    if (!colNames.includes('cidade')) await db.exec("ALTER TABLE clientes ADD COLUMN cidade TEXT");
    if (!colNames.includes('uf')) await db.exec("ALTER TABLE clientes ADD COLUMN uf TEXT");
    if (!colNames.includes('cep')) await db.exec("ALTER TABLE clientes ADD COLUMN cep TEXT");
    if (!colNames.includes('entrega_endereco')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_endereco TEXT");
    if (!colNames.includes('entrega_numero')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_numero TEXT");
    if (!colNames.includes('entrega_complemento')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_complemento TEXT");
    if (!colNames.includes('entrega_bairro')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_bairro TEXT");
    if (!colNames.includes('entrega_cidade')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_cidade TEXT");
    if (!colNames.includes('entrega_uf')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_uf TEXT");
    if (!colNames.includes('entrega_cep')) await db.exec("ALTER TABLE clientes ADD COLUMN entrega_cep TEXT");

    const docCol = tableInfo.find(c => c.name === 'documento');
    const emailCol = tableInfo.find(c => c.name === 'email');
    if ((docCol && docCol.notnull === 1) || (emailCol && emailCol.notnull === 1)) {
      await db.exec('PRAGMA foreign_keys=OFF;');
      await db.exec(`
        CREATE TABLE clientes_temp_migration (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nome TEXT NOT NULL,
          documento TEXT,
          email TEXT,
          telefone TEXT,
          status TEXT NOT NULL DEFAULT 'Ativo',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          rg TEXT,
          endereco TEXT,
          numero TEXT,
          complemento TEXT,
          bairro TEXT,
          cidade TEXT,
          uf TEXT,
          cep TEXT,
          entrega_endereco TEXT,
          entrega_numero TEXT,
          entrega_complemento TEXT,
          entrega_bairro TEXT,
          entrega_cidade TEXT,
          entrega_uf TEXT,
          entrega_cep TEXT
        );
        INSERT INTO clientes_temp_migration (id, nome, documento, email, telefone, status, created_at, rg, endereco, numero, complemento, bairro, cidade, uf, cep, entrega_endereco, entrega_numero, entrega_complemento, entrega_bairro, entrega_cidade, entrega_uf, entrega_cep)
          SELECT id, nome, documento, email, telefone, status, created_at, rg, endereco, numero, complemento, bairro, cidade, uf, cep, entrega_endereco, entrega_numero, entrega_complemento, entrega_bairro, entrega_cidade, entrega_uf, entrega_cep FROM clientes;
        DROP TABLE clientes;
        ALTER TABLE clientes_temp_migration RENAME TO clientes;
      `);
      await db.exec('PRAGMA foreign_keys=ON;');
      console.log('Database migration: Relaxed constraints on clientes table.');
    }
  } catch (err) {
    console.error('Migration clientes error:', err);
  }

  // Create Contracts Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      numero TEXT NOT NULL UNIQUE,
      valor REAL NOT NULL,
      data_inicio TEXT NOT NULL,
      data_fim TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Ativo',
      drive_file_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
    )
  `);

  // Create Services Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS servicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      unidade INTEGER NOT NULL DEFAULT 1,
      tempo INTEGER NOT NULL,
      sequencia INTEGER DEFAULT 0
    )
  `);

  // Migration for existing tables: add column if not exists
  try {
    await db.exec('ALTER TABLE servicos ADD COLUMN sequencia INTEGER DEFAULT 0');
    console.log('Database migration: Added "sequencia" column to "servicos" table.');
  } catch (err) {
    // Column might already exist
  }

  try {
    await db.exec('ALTER TABLE ordens_servico ADD COLUMN cronograma TEXT DEFAULT NULL');
    console.log('Database migration: Added "cronograma" column to "ordens_servico" table.');
  } catch (err) {
    // Column might already exist
  }

  try {
    await db.exec("ALTER TABLE Material ADD COLUMN ExibirNaProposta TEXT DEFAULT 'Nao'");
    console.log('Database migration: Added "ExibirNaProposta" column to "Material" table.');
  } catch (err) {
    // Column might already exist
  }

  try {
    await db.exec('ALTER TABLE projetos ADD COLUMN ProjetoURL TEXT DEFAULT NULL');
    console.log('Database migration: Added "ProjetoURL" column to "projetos" table.');
  } catch (err) {
    // Column might already exist
  }

  try {
    await db.exec('ALTER TABLE projetos ADD COLUMN ProjetoQtdPecas INTEGER DEFAULT 0');
    console.log('Database migration: Added "ProjetoQtdPecas" column to "projetos" table.');
  } catch (err) {
    // Column might already exist
  }

  try {
    // Migra e sincroniza ProjetoQtdPecas a partir de registros legados de FAB.QTD.PCA
    await db.exec(`
      UPDATE projetos 
      SET ProjetoQtdPecas = COALESCE((
        SELECT CAST(qtd AS INTEGER) FROM Projeto_Materiais 
        WHERE Projeto_Materiais.projeto_id = projetos.id AND Projeto_Materiais.referencia = 'FAB.QTD.PCA'
      ), (
        SELECT CAST(ProjetoItemQtd AS INTEGER) FROM ProjetoItem 
        WHERE ProjetoItem.ProjetoID = projetos.id AND ProjetoItem.MaterialReferencia = 'FAB.QTD.PCA'
      ), 0)
      WHERE (ProjetoQtdPecas IS NULL OR ProjetoQtdPecas = 0)
    `);
    await db.exec("DELETE FROM ProjetoItem WHERE MaterialReferencia = 'FAB.QTD.PCA'");
    await db.exec("DELETE FROM Projeto_Materiais WHERE referencia = 'FAB.QTD.PCA'");
  } catch (err) {
    // Ignora se tabelas ainda não existirem no primeiro boot
  }

  try {
    await db.exec('ALTER TABLE orcamentos ADD COLUMN parametro_financeiro_id INTEGER DEFAULT 1');
    console.log('Database migration: Added "parametro_financeiro_id" column to "orcamentos" table.');
  } catch (err) {
    // Column might already exist
  }

  try {
    // Migra parametro_financeiro_id dos projetos para o orçamento se ainda for nulo
    await db.exec(`
      UPDATE orcamentos 
      SET parametro_financeiro_id = COALESCE((
        SELECT parametro_financeiro_id FROM projetos 
        WHERE projetos.orcamento_numero = orcamentos.numero AND projetos.parametro_financeiro_id IS NOT NULL 
        LIMIT 1
      ), 1)
      WHERE parametro_financeiro_id IS NULL OR parametro_financeiro_id = 0
    `);
  } catch (err) {
    // Ignore if not present
  }

  // Create Work Orders Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ordens_servico (
      numero INTEGER PRIMARY KEY,
      data_abertura DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_fechamento DATETIME DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'Aberta',
      ambiente TEXT DEFAULT NULL,
      cliente TEXT DEFAULT NULL,
      qtd_pecas INTEGER DEFAULT 0,
      qtd_chapas INTEGER DEFAULT 0,
      qtd_especiais INTEGER DEFAULT 0,
      qtd_caixa INTEGER DEFAULT 0,
      tempo_previsto INTEGER DEFAULT 0,
      tempo_real INTEGER DEFAULT 0,
      cronograma TEXT DEFAULT NULL,
      data_inicio DATETIME DEFAULT NULL,
      data_fim DATETIME DEFAULT NULL
    )
  `);

  // Create Work Order Items Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS os_servicos (
      os_numero INTEGER NOT NULL,
      servico_id INTEGER NOT NULL,
      quantidade INTEGER NOT NULL,
      tempo_previsto INTEGER NOT NULL,
      data_inicio DATETIME DEFAULT NULL,
      data_fim DATETIME DEFAULT NULL,
      tempo_real INTEGER DEFAULT NULL,
      PRIMARY KEY (os_numero, servico_id),
      FOREIGN KEY (os_numero) REFERENCES ordens_servico(numero) ON DELETE CASCADE,
      FOREIGN KEY (servico_id) REFERENCES servicos(id) ON DELETE RESTRICT
    )
  `);

  // Create Work Order Pieces Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS os_pecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      os_numero INTEGER NOT NULL,
      modulo TEXT,
      chapa TEXT,
      posicao TEXT,
      dimensoes TEXT,
      descricao TEXT NOT NULL,
      codigo TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (os_numero) REFERENCES ordens_servico(numero) ON DELETE CASCADE
    )
  `);

  // Create OS Chapas Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS OS_Chapas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      os_numero INTEGER NOT NULL,
      cliente TEXT,
      projeto TEXT,
      chapa TEXT,
      acabamento TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (os_numero) REFERENCES ordens_servico(numero) ON DELETE CASCADE
    )
  `);

  // Create OS Chapas Pieces Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS OS_ChapasPecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapa_id INTEGER NOT NULL,
      item TEXT,
      descricao TEXT,
      dimensao TEXT,
      descricao_pai TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chapa_id) REFERENCES OS_Chapas(id) ON DELETE CASCADE
    )
  `);

  // Create Imported Files Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS arquivos_importados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_arquivo TEXT NOT NULL,
      tamanho INTEGER NOT NULL,
      tipo_layout TEXT NOT NULL,
      caminho_arquivo TEXT NOT NULL,
      projeto_id INTEGER DEFAULT NULL,
      data_upload DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    )
  `);

  // Create Orcamento Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orcamentos (
      numero INTEGER PRIMARY KEY,
      data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
      cliente_id INTEGER NOT NULL,
      descricao TEXT,
      status TEXT DEFAULT 'Em Aberto',
      parametro_financeiro_id INTEGER DEFAULT 1,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
      FOREIGN KEY (parametro_financeiro_id) REFERENCES Parametro_Financeiro(id)
    )
  `);

  // Create Projetos Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS projetos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orcamento_numero INTEGER NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      ProjetoURL TEXT,
      ProjetoQtdPecas INTEGER DEFAULT 0,
      CustoTotal DECIMAL(15,2) DEFAULT 0.0,
      CustoMaterial DECIMAL(15,2) DEFAULT 0.0,
      CustoProducao DECIMAL(15,2) DEFAULT 0.0,
      DuracaoFabricacao INTEGER DEFAULT 0,
      DuracaoMontagem INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (orcamento_numero) REFERENCES orcamentos(numero) ON DELETE CASCADE
    )
  `);

  // Create Projeto_Materiais Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Materiais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projeto_id INTEGER NOT NULL,
      referencia TEXT NOT NULL,
      descricao TEXT NOT NULL,
      qtd REAL NOT NULL,
      un TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    )
  `);

  // Create Projeto_Anexos Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS projeto_anexos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projeto_id INTEGER NOT NULL,
      nome_original TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL,
      caminho TEXT NOT NULL,
      tipo_mime TEXT,
      tamanho INTEGER,
      exibir_na_proposta TEXT DEFAULT 'Sim',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      criado_por_nome TEXT,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    )
  `);

  // Create Projeto_Modulo Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Modulo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projeto_id INTEGER NOT NULL,
      modulo TEXT NOT NULL,
      peca TEXT NOT NULL,
      imagem TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    )
  `);

  // Create Projeto_Chapa Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Chapa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projeto_id INTEGER NOT NULL,
      chapa TEXT NOT NULL,
      acabamento TEXT NOT NULL,
      DescChapa TEXT,
      item TEXT NOT NULL,
      descricao TEXT NOT NULL,
      dimensao TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    )
  `);

  // Create Projeto_Pecas Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Projeto_Pecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projeto_id INTEGER NOT NULL,
      peca TEXT NOT NULL,
      etiqueta TEXT NOT NULL,
      dimen TEXT NOT NULL,
      chapa TEXT NOT NULL,
      modulo TEXT NOT NULL,
      cod_item TEXT NOT NULL,
      imagem TEXT,
      cor_barras TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
    )
  `);

  // Create Material Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Material (
      MaterialReferencia TEXT PRIMARY KEY,
      MaterialDescricao TEXT NOT NULL,
      MaterialUnidade TEXT CHECK(MaterialUnidade IN ('CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA')),
      MaterialValorUnitario REAL DEFAULT 0.0,
      GrupoSigla TEXT,
      ProdutoGrupo INTEGER DEFAULT 8,
      MaterialTipo TEXT DEFAULT 'Produto' CHECK(MaterialTipo IN ('Produto', 'Serviço')),
      MaterialImagem TEXT,
      MaterialTempo INTEGER DEFAULT 0,
      ExibirNaProposta TEXT DEFAULT 'Nao' CHECK(ExibirNaProposta IN ('Sim', 'Nao'))
    )
  `);

  // Create ProjetoItem Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ProjetoItem (
      ProjetoID INTEGER NOT NULL,
      ProjetoItemID INTEGER NOT NULL,
      MaterialReferencia TEXT NOT NULL,
      ProjetoItemVlrUnit DECIMAL(15,2) NOT NULL,
      ProjetoItemUnidade VARCHAR(3) NOT NULL,
      ProjetoItemQtd DECIMAL(8,2) NOT NULL,
      ProjetoItemTotal DECIMAL(15,2) NOT NULL,
      ProjetoItemTempo INTEGER DEFAULT 0,
      ProjetoItemDuracao INTEGER DEFAULT 0,
      PRIMARY KEY (ProjetoID, ProjetoItemID),
      FOREIGN KEY (ProjetoID) REFERENCES projetos(id) ON DELETE CASCADE,
      FOREIGN KEY (MaterialReferencia) REFERENCES Material(MaterialReferencia)
    )
  `);

  // Create Parametro_Financeiro Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS Parametro_Financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      situacao TEXT DEFAULT 'Ativado' CHECK(situacao IN ('Ativado', 'Desativado')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Configuracoes Financeiras Table (subordinated to Parametro_Financeiro)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS configuracoes_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parametro_id INTEGER NOT NULL UNIQUE,
      perc_imposto DECIMAL(5,2) DEFAULT 6.00,
      perc_comissao DECIMAL(5,2) DEFAULT 5.00,
      perc_custo_financeiro DECIMAL(5,2) DEFAULT 4.00,
      perc_markup_lucro DECIMAL(5,2) DEFAULT 20.00,
      perc_margem_minima DECIMAL(5,2) DEFAULT 10.00,
      metodo_calculo TEXT DEFAULT 'divisor',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parametro_id) REFERENCES Parametro_Financeiro(id) ON DELETE CASCADE
    )
  `);

  // Seed default Parametro_Financeiro and configuracoes_financeiras if not exists
  const existingParam = await db.get('SELECT * FROM Parametro_Financeiro WHERE id = 1');
  if (!existingParam) {
    await db.run(`INSERT INTO Parametro_Financeiro (id, nome, situacao) VALUES (1, 'Padrão Fábrica', 'Ativado')`);
    await db.run(`
      INSERT INTO configuracoes_financeiras (id, parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
      VALUES (1, 1, 6.00, 5.00, 4.00, 20.00, 10.00, 'divisor')
    `);
  }

  // Seed default admin user if not exists
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

  // Seed some dummy clients if empty
  const clientsCount = await db.get('SELECT COUNT(*) as count FROM clientes');
  if (clientsCount.count === 0) {
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

  // Seed some dummy contracts if empty
  const contractsCount = await db.get('SELECT COUNT(*) as count FROM contratos');
  if (contractsCount.count === 0) {
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

  // Seed some dummy services if empty
  const servicesCount = await db.get('SELECT COUNT(*) as count FROM servicos');
  if (servicesCount.count === 0) {
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', [
      'Separação',
      1,
      15,
      5
    ]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', [
      'Usinagem',
      2,
      45,
      10
    ]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', [
      'Fitagem',
      3,
      10,
      20
    ]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', [
      'Montagem de caixa',
      4,
      30,
      30
    ]);
    await db.run('INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)', [
      'Especial',
      6,
      60,
      40
    ]);
    console.log('Seeded initial mock services');
  }

  // Seed some dummy Work Orders if empty
  const osCount = await db.get('SELECT COUNT(*) as count FROM ordens_servico');
  if (osCount.count === 0) {
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

  // Seed some dummy budgets if empty
  const budgetsCount = await db.get('SELECT COUNT(*) as count FROM orcamentos');
  if (budgetsCount.count === 0) {
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

  // Seed some dummy projects if empty
  const projectsCount = await db.get('SELECT COUNT(*) as count FROM projetos');
  if (projectsCount.count === 0) {
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

  // Schema migration: add CustoMaterial, CustoProducao, DuracaoFabricacao and DuracaoMontagem columns to projetos if they don't exist
  try {
    const tableInfoProj = await db.all("PRAGMA table_info(projetos)");
    const hasCustoMaterialProj = tableInfoProj.some(col => col.name === 'CustoMaterial');
    const hasCustoProducaoProj = tableInfoProj.some(col => col.name === 'CustoProducao');
    const hasDuracaoFabricacaoProj = tableInfoProj.some(col => col.name === 'DuracaoFabricacao');
    const hasDuracaoProj = tableInfoProj.some(col => col.name === 'Duracao');
    const hasDuracaoMontagemProj = tableInfoProj.some(col => col.name === 'DuracaoMontagem');

    if (!hasCustoMaterialProj) {
      await db.exec("ALTER TABLE projetos ADD COLUMN CustoMaterial DECIMAL(15,2) DEFAULT 0.0");
      console.log("Migration: Added CustoMaterial column to projetos.");
    }
    if (!hasCustoProducaoProj) {
      await db.exec("ALTER TABLE projetos ADD COLUMN CustoProducao DECIMAL(15,2) DEFAULT 0.0");
      console.log("Migration: Added CustoProducao column to projetos.");
    }
    if (hasDuracaoProj && !hasDuracaoFabricacaoProj) {
      try {
        await db.exec("ALTER TABLE projetos RENAME COLUMN Duracao TO DuracaoFabricacao");
        console.log("Migration: Renamed Duracao to DuracaoFabricacao in projetos.");
      } catch (e) {
        await db.exec("ALTER TABLE projetos ADD COLUMN DuracaoFabricacao INTEGER DEFAULT 0");
        await db.exec("UPDATE projetos SET DuracaoFabricacao = Duracao");
        console.log("Migration: Added DuracaoFabricacao and copied from Duracao.");
      }
    } else if (!hasDuracaoFabricacaoProj) {
      await db.exec("ALTER TABLE projetos ADD COLUMN DuracaoFabricacao INTEGER DEFAULT 0");
      console.log("Migration: Added DuracaoFabricacao column to projetos.");
    }
    if (!hasDuracaoMontagemProj) {
      await db.exec("ALTER TABLE projetos ADD COLUMN DuracaoMontagem INTEGER DEFAULT 0");
      console.log("Migration: Added DuracaoMontagem column to projetos.");
    }

    const tableInfoProjCols = await db.all("PRAGMA table_info(projetos)");
    if (!tableInfoProjCols.some(col => col.name === 'perc_imposto')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN perc_imposto DECIMAL(5,2) DEFAULT NULL");
    }
    if (!tableInfoProjCols.some(col => col.name === 'perc_comissao')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN perc_comissao DECIMAL(5,2) DEFAULT NULL");
    }
    if (!tableInfoProjCols.some(col => col.name === 'perc_custo_financeiro')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN perc_custo_financeiro DECIMAL(5,2) DEFAULT NULL");
    }
    if (!tableInfoProjCols.some(col => col.name === 'perc_markup_lucro')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN perc_markup_lucro DECIMAL(5,2) DEFAULT NULL");
    }
    if (!tableInfoProjCols.some(col => col.name === 'preco_venda_sugerido')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN preco_venda_sugerido DECIMAL(15,2) DEFAULT 0.0");
    }
    if (!tableInfoProjCols.some(col => col.name === 'preco_venda_final')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN preco_venda_final DECIMAL(15,2) DEFAULT 0.0");
    }
    if (!tableInfoProjCols.some(col => col.name === 'parametro_financeiro_id')) {
      await db.exec("ALTER TABLE projetos ADD COLUMN parametro_financeiro_id INTEGER DEFAULT 1");
      console.log("Migration: Added parametro_financeiro_id column to projetos.");
    }

    // Migration for configuracoes_financeiras table structure
    const tableInfoConf = await db.all("PRAGMA table_info(configuracoes_financeiras)");
    if (!tableInfoConf.some(col => col.name === 'parametro_id')) {
      await db.exec("PRAGMA foreign_keys = OFF;");
      await db.exec("BEGIN TRANSACTION;");
      await db.exec(`
        CREATE TABLE IF NOT EXISTS Parametro_Financeiro (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nome TEXT NOT NULL,
          situacao TEXT DEFAULT 'Ativado' CHECK(situacao IN ('Ativado', 'Desativado')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const p1 = await db.get("SELECT id FROM Parametro_Financeiro WHERE id = 1");
      if (!p1) {
        await db.run("INSERT INTO Parametro_Financeiro (id, nome, situacao) VALUES (1, 'Padrão Fábrica', 'Ativado')");
      }
      await db.exec(`
        CREATE TABLE configuracoes_financeiras_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parametro_id INTEGER NOT NULL UNIQUE,
          perc_imposto DECIMAL(5,2) DEFAULT 6.00,
          perc_comissao DECIMAL(5,2) DEFAULT 5.00,
          perc_custo_financeiro DECIMAL(5,2) DEFAULT 4.00,
          perc_markup_lucro DECIMAL(5,2) DEFAULT 20.00,
          perc_margem_minima DECIMAL(5,2) DEFAULT 10.00,
          metodo_calculo TEXT DEFAULT 'divisor',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (parametro_id) REFERENCES Parametro_Financeiro(id) ON DELETE CASCADE
        );
      `);
      await db.exec(`
        INSERT INTO configuracoes_financeiras_new (id, parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo, updated_at)
        SELECT id, 1, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo, updated_at FROM configuracoes_financeiras;
      `);
      await db.exec("DROP TABLE configuracoes_financeiras;");
      await db.exec("ALTER TABLE configuracoes_financeiras_new RENAME TO configuracoes_financeiras;");
      await db.exec("COMMIT;");
      await db.exec("PRAGMA foreign_keys = ON;");
      console.log("Migration: Recreated configuracoes_financeiras table with parametro_id column.");
    }

    const tableInfoOrc = await db.all("PRAGMA table_info(orcamentos)");
    const hasCustoMaterialOrc = tableInfoOrc.some(col => col.name === 'CustoMaterial');
    const hasCustoProducaoOrc = tableInfoOrc.some(col => col.name === 'CustoProducao');

    if (hasCustoMaterialOrc) {
      await db.exec("ALTER TABLE orcamentos DROP COLUMN CustoMaterial");
      console.log("Migration: Dropped CustoMaterial column from orcamentos.");
    }
    if (hasCustoProducaoOrc) {
      await db.exec("ALTER TABLE orcamentos DROP COLUMN CustoProducao");
      console.log("Migration: Dropped CustoProducao column from orcamentos.");
    }

    const hasStatusOrc = tableInfoOrc.some(col => col.name === 'status');
    if (!hasStatusOrc) {
      await db.exec("ALTER TABLE orcamentos ADD COLUMN status TEXT DEFAULT 'Em Aberto'");
      console.log("Migration: Added status column to orcamentos.");
    }

    const tableInfoMat = await db.all("PRAGMA table_info(Material)");
    const hasMaterialTempo = tableInfoMat.some(col => col.name === 'MaterialTempo');
    if (!hasMaterialTempo) {
      await db.exec("ALTER TABLE Material ADD COLUMN MaterialTempo INTEGER DEFAULT 0");
      console.log("Migration: Added MaterialTempo column to Material table.");
    }
    const hasExibirNaProposta = tableInfoMat.some(col => col.name === 'ExibirNaProposta');
    if (!hasExibirNaProposta) {
      await db.exec("ALTER TABLE Material ADD COLUMN ExibirNaProposta TEXT DEFAULT 'Nao'");
      console.log("Migration: Added ExibirNaProposta column to Material table.");
    }

    const hasProdutoGrupo = tableInfoMat.some(col => col.name === 'ProdutoGrupo');
    if (!hasProdutoGrupo) {
      await db.exec("ALTER TABLE Material ADD COLUMN ProdutoGrupo INTEGER DEFAULT 8");
      console.log("Migration: Added ProdutoGrupo column to Material table.");
    }
    // Todos os produtos já cadastrados, atribuir o domínio Outros (8) se nulo ou não definido
    await db.exec("UPDATE Material SET ProdutoGrupo = 8 WHERE ProdutoGrupo IS NULL OR ProdutoGrupo = 0");

    const tableInfoPi = await db.all("PRAGMA table_info(ProjetoItem)");
    const hasPiTempo = tableInfoPi.some(col => col.name === 'ProjetoItemTempo');
    const hasPiDuracao = tableInfoPi.some(col => col.name === 'ProjetoItemDuracao');

    if (!hasPiTempo) {
      await db.exec("ALTER TABLE ProjetoItem ADD COLUMN ProjetoItemTempo INTEGER DEFAULT 0");
      console.log("Migration: Added ProjetoItemTempo column to ProjetoItem table.");
    }
    if (!hasPiDuracao) {
      await db.exec("ALTER TABLE ProjetoItem ADD COLUMN ProjetoItemDuracao INTEGER DEFAULT 0");
      console.log("Migration: Added ProjetoItemDuracao column to ProjetoItem table.");
    }

    if (!hasPiTempo || !hasPiDuracao) {
      await db.exec(`
        UPDATE ProjetoItem
        SET 
          ProjetoItemTempo = COALESCE((SELECT MaterialTempo FROM Material WHERE Material.MaterialReferencia = ProjetoItem.MaterialReferencia), 0),
          ProjetoItemDuracao = CAST(ROUND(COALESCE((SELECT MaterialTempo FROM Material WHERE Material.MaterialReferencia = ProjetoItem.MaterialReferencia), 0) * ProjetoItemQtd) AS INTEGER)
      `);
      console.log("Migration: Backfilled ProjetoItemTempo and ProjetoItemDuracao.");
    }

    // Migration to allow 'DIA' in Material table check constraint if needed
    const matTableSql = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='Material'");
    if (matTableSql && matTableSql.sql && !matTableSql.sql.includes("'DIA'")) {
      await db.exec("PRAGMA foreign_keys = OFF;");
      await db.exec("BEGIN TRANSACTION;");
      await db.exec(`
        CREATE TABLE Material_new (
          MaterialReferencia TEXT PRIMARY KEY,
          MaterialDescricao TEXT NOT NULL,
          MaterialUnidade TEXT CHECK(MaterialUnidade IN ('CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA')),
          MaterialValorUnitario REAL DEFAULT 0.0,
          GrupoSigla TEXT,
          ProdutoGrupo INTEGER DEFAULT 8,
          MaterialTipo TEXT DEFAULT 'Produto' CHECK(MaterialTipo IN ('Produto', 'Serviço')),
          MaterialImagem TEXT,
          MaterialTempo INTEGER DEFAULT 0,
          ExibirNaProposta TEXT DEFAULT 'Nao'
        );
      `);
      await db.exec("INSERT INTO Material_new SELECT MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, COALESCE(ProdutoGrupo, 8), MaterialTipo, MaterialImagem, MaterialTempo, COALESCE(ExibirNaProposta, 'Nao') FROM Material;");
      await db.exec("DROP TABLE Material;");
      await db.exec("ALTER TABLE Material_new RENAME TO Material;");
      await db.exec("COMMIT;");
      await db.exec("PRAGMA foreign_keys = ON;");
      console.log("Migration: Recreated Material table with 'DIA' constraint.");
    }

    // Ensure 'FAB.MON.CLI' exists in Material
    const fabMonCli = await db.get("SELECT MaterialReferencia FROM Material WHERE MaterialReferencia = 'FAB.MON.CLI'");
    if (!fabMonCli) {
      await db.run(
        `INSERT INTO Material (MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['FAB.MON.CLI', 'Montagem cliente', 'DIA', 0.0, null, 8, 'Serviço', 0]
      );
      console.log("Migration: Seeded FAB.MON.CLI in Material table.");
    }

    // Recalculate DuracaoFabricacao excluding FAB.MON.CLI and sync DuracaoMontagem for existing projects
    await db.exec(`
      UPDATE projetos
      SET 
        DuracaoFabricacao = COALESCE((
          SELECT SUM(pi.ProjetoItemDuracao)
          FROM ProjetoItem pi
          WHERE pi.ProjetoID = projetos.id AND pi.MaterialReferencia != 'FAB.MON.CLI'
        ), DuracaoFabricacao, 0),
        DuracaoMontagem = COALESCE((
          SELECT CAST(ROUND(pi.ProjetoItemQtd) AS INTEGER)
          FROM ProjetoItem pi
          WHERE pi.ProjetoID = projetos.id AND pi.MaterialReferencia = 'FAB.MON.CLI'
        ), DuracaoMontagem, 0)
    `);

    // Create Formas de Pagamento & Condicoes de Pagamento tables
    await db.exec(`
      CREATE TABLE IF NOT EXISTS formas_pagamento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        descricao TEXT,
        valor_minimo REAL DEFAULT 0.0,
        valor_maximo REAL DEFAULT 0.0,
        ativo TEXT NOT NULL DEFAULT 'Sim',
        ordem INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS condicoes_pagamento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forma_pagamento_id INTEGER NOT NULL,
        perc_entrada REAL DEFAULT 0.0,
        num_parcelas INTEGER DEFAULT 0,
        perc_desconto REAL DEFAULT 0.0,
        meio_pagamento TEXT DEFAULT '',
        descricao TEXT NOT NULL,
        ordem INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (forma_pagamento_id) REFERENCES formas_pagamento(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS proposta_compartilhamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orcamento_numero INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        criado_por INTEGER,
        criado_por_nome TEXT,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        expira_em DATETIME NOT NULL,
        acessos_count INTEGER DEFAULT 0,
        ultimo_acesso DATETIME,
        status TEXT DEFAULT 'Ativo',
        FOREIGN KEY (orcamento_numero) REFERENCES orcamentos(numero) ON DELETE CASCADE
      );
    `);

    // Seed default Formas de Pagamento if empty
    const countFormas = await db.get('SELECT COUNT(*) as cnt FROM formas_pagamento');
    if (countFormas && countFormas.cnt === 0) {
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
    // Check migration for projeto_anexos exibir_na_proposta column
    try {
      const tableInfoAnexos = await db.all("PRAGMA table_info(projeto_anexos)");
      const hasExibirNaProposta = tableInfoAnexos.some(col => col.name === 'exibir_na_proposta');
      if (!hasExibirNaProposta) {
        await db.exec("ALTER TABLE projeto_anexos ADD COLUMN exibir_na_proposta TEXT DEFAULT 'Sim'");
        console.log("Migration: Added exibir_na_proposta column to projeto_anexos table.");
      }
    } catch (e) {
      console.error("Migration check for projeto_anexos error:", e);
    }

    // Check migration for orcamentos approval and conclusion fields
    try {
      const tableInfoOrc = await db.all("PRAGMA table_info(orcamentos)");
      const colNamesOrc = tableInfoOrc.map(col => col.name);
      if (!colNamesOrc.includes('forma_pagamento_selecionada')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN forma_pagamento_selecionada TEXT");
      }
      if (!colNamesOrc.includes('anotacoes_cliente')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN anotacoes_cliente TEXT");
      }
      if (!colNamesOrc.includes('data_aprovacao')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN data_aprovacao DATETIME");
      }
      if (!colNamesOrc.includes('desconto_percentual')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN desconto_percentual DECIMAL(6,2) DEFAULT 0.0");
      }
      if (!colNamesOrc.includes('desconto_valor')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN desconto_valor DECIMAL(15,2) DEFAULT 0.0");
      }
      if (!colNamesOrc.includes('total_venda')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN total_venda DECIMAL(15,2) DEFAULT NULL");
      }
      if (!colNamesOrc.includes('anotacoes_conclusao')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN anotacoes_conclusao TEXT");
      }
      if (!colNamesOrc.includes('situacao')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN situacao TEXT DEFAULT 'Em Aberto'");
      }
      if (!colNamesOrc.includes('data_entrada')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN data_entrada TEXT");
      }
      if (!colNamesOrc.includes('fluxo_financeiro')) {
        await db.exec("ALTER TABLE orcamentos ADD COLUMN fluxo_financeiro TEXT");
      }
    } catch (e) {
      console.error("Migration check for orcamentos approval fields error:", e);
    }

    // Check migration for proposta_compartilhamentos approval fields
    try {
      const tableInfoShare = await db.all("PRAGMA table_info(proposta_compartilhamentos)");
      const colNamesShare = tableInfoShare.map(col => col.name);
      if (!colNamesShare.includes('aprovado_em')) {
        await db.exec("ALTER TABLE proposta_compartilhamentos ADD COLUMN aprovado_em DATETIME");
      }
      if (!colNamesShare.includes('forma_pagamento_selecionada')) {
        await db.exec("ALTER TABLE proposta_compartilhamentos ADD COLUMN forma_pagamento_selecionada TEXT");
      }
      if (!colNamesShare.includes('anotacoes_cliente')) {
        await db.exec("ALTER TABLE proposta_compartilhamentos ADD COLUMN anotacoes_cliente TEXT");
      }
    } catch (e) {
      console.error("Migration check for proposta_compartilhamentos approval fields error:", e);
    }

    // Create ParametrosEmpresa Table
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS parametros_empresa (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chave VARCHAR(10) NOT NULL UNIQUE,
          tipo INTEGER NOT NULL,
          conteudo VARCHAR(60),
          descricao TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const paramsCount = await db.get('SELECT COUNT(*) as count FROM parametros_empresa');
      if (paramsCount && paramsCount.count === 0) {
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
      } else {
        // Garantir migração das chaves EMP_LOGO e EMP_ASS caso o banco já exista
        const logoParam = await db.get("SELECT * FROM parametros_empresa WHERE chave = 'EMP_LOGO'");
        if (!logoParam) {
          const oldLogo = await db.get("SELECT * FROM parametros_empresa WHERE chave = 'LOGO_EMP'");
          if (oldLogo) {
            await db.run("UPDATE parametros_empresa SET chave = 'EMP_LOGO', descricao = 'Logomarca da empresa para cabeçalhos e documentos' WHERE id = ?", [oldLogo.id]);
          } else {
            await db.run("INSERT INTO parametros_empresa (chave, tipo, conteudo, descricao) VALUES ('EMP_LOGO', 7, '', 'Logomarca da empresa para cabeçalhos e documentos')");
          }
        }

        const assParam = await db.get("SELECT * FROM parametros_empresa WHERE chave = 'EMP_ASS'");
        if (!assParam) {
          await db.run("INSERT INTO parametros_empresa (chave, tipo, conteudo, descricao) VALUES ('EMP_ASS', 7, '', 'Assinatura do responsável para contratos e recibos')");
        }
      }
    } catch (e) {
      console.error("Migration check for parametros_empresa error:", e);
    }
  } catch (err) {
    console.error("Migration check failed:", err);
  }

  return db;
}
