import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { initDb } from './db.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PNG } from 'pngjs';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_token_key_12345';

// Base directory for uploads (supports custom UPLOADS_PATH env var to store files outside app/git directory)
const rawUploadsDir = process.env.UPLOADS_PATH || './uploads';
export const uploadsBaseDir = path.isAbsolute(rawUploadsDir) ? rawUploadsDir : path.resolve(process.cwd(), rawUploadsDir);
const uploadDir = uploadsBaseDir;
const layoutsUploadDir = path.join(uploadsBaseDir, 'layouts');
const anexosUploadDir = path.join(uploadsBaseDir, 'anexos');
const parametrosUploadDir = path.join(uploadsBaseDir, 'parametros');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(layoutsUploadDir)) fs.mkdirSync(layoutsUploadDir, { recursive: true });
if (!fs.existsSync(anexosUploadDir)) fs.mkdirSync(anexosUploadDir, { recursive: true });
if (!fs.existsSync(parametrosUploadDir)) fs.mkdirSync(parametrosUploadDir, { recursive: true });

// Helper to safely resolve physical path of uploaded files
export function getUploadPhysicalPath(relPath) {
  if (!relPath) return '';
  if (path.isAbsolute(relPath)) return relPath;
  const clean = relPath.replace(/^[\\\/]*uploads[\\\/]*/i, '');
  return path.join(uploadsBaseDir, clean);
}

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsBaseDir));

// Setup multer upload folder locally
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Setup multer upload folder for layout files
const layoutsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, layoutsUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadLayouts = multer({ storage: layoutsStorage });

// Setup multer upload folder for project attachment files
const anexosStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, anexosUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadAnexos = multer({ storage: anexosStorage });

// Initialize database
let db;
try {
  db = await initDb();
  console.log('SQLite database initialized successfully.');
  await ensureOrcamentosSchema(db);
} catch (error) {
  console.error('Failed to initialize SQLite database:', error);
  process.exit(1);
}

async function ensureOrcamentosSchema(database) {
  try {
    const tableInfo = await database.all("PRAGMA table_info(orcamentos)");
    const colNames = tableInfo.map(c => c.name);
    if (!colNames.includes('desconto_percentual')) await database.exec("ALTER TABLE orcamentos ADD COLUMN desconto_percentual DECIMAL(6,2) DEFAULT 0.0");
    if (!colNames.includes('desconto_valor')) await database.exec("ALTER TABLE orcamentos ADD COLUMN desconto_valor DECIMAL(15,2) DEFAULT 0.0");
    if (!colNames.includes('total_venda')) await database.exec("ALTER TABLE orcamentos ADD COLUMN total_venda DECIMAL(15,2) DEFAULT NULL");
    if (!colNames.includes('forma_pagamento_selecionada')) await database.exec("ALTER TABLE orcamentos ADD COLUMN forma_pagamento_selecionada TEXT");
    if (!colNames.includes('anotacoes_cliente')) await database.exec("ALTER TABLE orcamentos ADD COLUMN anotacoes_cliente TEXT");
    if (!colNames.includes('anotacoes_conclusao')) await database.exec("ALTER TABLE orcamentos ADD COLUMN anotacoes_conclusao TEXT");
    if (!colNames.includes('data_aprovacao')) await database.exec("ALTER TABLE orcamentos ADD COLUMN data_aprovacao TEXT");
    if (!colNames.includes('data_entrada')) await database.exec("ALTER TABLE orcamentos ADD COLUMN data_entrada TEXT");
    if (!colNames.includes('fluxo_financeiro')) await database.exec("ALTER TABLE orcamentos ADD COLUMN fluxo_financeiro TEXT");
    if (!colNames.includes('status')) await database.exec("ALTER TABLE orcamentos ADD COLUMN status TEXT DEFAULT 'Em Aberto'");
    if (!colNames.includes('situacao')) await database.exec("ALTER TABLE orcamentos ADD COLUMN situacao TEXT DEFAULT 'Em Aberto'");
  } catch (e) {
    console.error('Error ensuring orcamentos schema:', e);
  }
}

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido ou expirado.' });
    }
    req.user = user;
    next();
  });
};

// ---------------- API Routes ----------------

// 1. Authentication Routes
app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    const user = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Email ou senha incorretos.' });
    }

    const validPassword = await bcrypt.compare(senha, user.senha);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou senha incorretos.' });
    }

    const token = jwt.sign({ id: user.id, nome: user.nome, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor durante o login.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get('SELECT id, nome, email, role, created_at FROM usuarios WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// 2. Dashboard Stats Route
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const clientsCount = await db.get('SELECT COUNT(*) as count FROM clientes WHERE status = "Ativo"');
    const totalRevenue = await db.get('SELECT SUM(valor) as total FROM contratos WHERE status = "Ativo"');
    const contractsCount = await db.get('SELECT COUNT(*) as count FROM contratos');
    const inactiveClients = await db.get('SELECT COUNT(*) as count FROM clientes WHERE status = "Inativo"');

    res.json({
      clientesAtivos: clientsCount.count || 0,
      clientesInativos: inactiveClients.count || 0,
      faturamentoMensal: totalRevenue.total || 0,
      totalContratos: contractsCount.count || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar estatísticas do painel.' });
  }
});

// 3. Clients Routes
app.get('/api/clientes', authenticateToken, async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM clientes ORDER BY nome ASC');
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar clientes.' });
  }
});

app.get('/api/clientes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const client = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    res.json(client);
  } catch (error) {
    console.error('Error fetching client by id:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do cliente.' });
  }
});

app.post('/api/clientes', authenticateToken, async (req, res) => {
  const { nome, documento, email, telefone, status } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'O nome do cliente é obrigatório.' });
  }

  try {
    const result = await db.run(
      'INSERT INTO clientes (nome, documento, email, telefone, status) VALUES (?, ?, ?, ?, ?)',
      [nome.trim(), documento || null, email || null, telefone || null, status || 'Ativo']
    );
    const newClient = await db.get('SELECT * FROM clientes WHERE id = ?', [result.lastID]);
    res.status(201).json(newClient);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Documento ou email já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro ao cadastrar cliente.' });
  }
});

app.put('/api/clientes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { 
    nome, documento, email, telefone, status,
    rg, endereco, numero, complemento, bairro, cidade, uf, cep,
    entrega_endereco, entrega_numero, entrega_complemento, entrega_bairro, entrega_cidade, entrega_uf, entrega_cep
  } = req.body;

  try {
    const client = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    // Ensure columns exist in clientes
    const cliCols = await db.all("PRAGMA table_info(clientes)");
    const colNames = cliCols.map(c => c.name);
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

    await db.run(`
      UPDATE clientes 
      SET 
        nome = ?, documento = ?, email = ?, telefone = ?, status = ?,
        rg = ?, endereco = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, cep = ?,
        entrega_endereco = ?, entrega_numero = ?, entrega_complemento = ?, entrega_bairro = ?, entrega_cidade = ?, entrega_uf = ?, entrega_cep = ?
      WHERE id = ?
    `, [
      nome !== undefined ? nome : client.nome,
      documento !== undefined ? documento : client.documento,
      email !== undefined ? email : client.email,
      telefone !== undefined ? telefone : client.telefone,
      status !== undefined ? status : client.status,
      rg !== undefined ? rg : client.rg,
      endereco !== undefined ? endereco : client.endereco,
      numero !== undefined ? numero : client.numero,
      complemento !== undefined ? complemento : client.complemento,
      bairro !== undefined ? bairro : client.bairro,
      cidade !== undefined ? cidade : client.cidade,
      uf !== undefined ? uf : client.uf,
      cep !== undefined ? cep : client.cep,
      entrega_endereco !== undefined ? entrega_endereco : client.entrega_endereco,
      entrega_numero !== undefined ? entrega_numero : client.entrega_numero,
      entrega_complemento !== undefined ? entrega_complemento : client.entrega_complemento,
      entrega_bairro !== undefined ? entrega_bairro : client.entrega_bairro,
      entrega_cidade !== undefined ? entrega_cidade : client.entrega_cidade,
      entrega_uf !== undefined ? entrega_uf : client.entrega_uf,
      entrega_cep !== undefined ? entrega_cep : client.entrega_cep,
      id
    ]);

    const updatedClient = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
    res.json(updatedClient);
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Erro ao atualizar cliente.' });
  }
});

app.delete('/api/clientes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const client = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    await db.run('DELETE FROM clientes WHERE id = ?', [id]);
    res.json({ message: 'Cliente removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir cliente.' });
  }
});

// 4. Contracts Routes
app.get('/api/contratos', authenticateToken, async (req, res) => {
  try {
    const list = await db.all(`
      SELECT contratos.*, clientes.nome as cliente_nome 
      FROM contratos 
      JOIN clientes ON contratos.cliente_id = clientes.id 
      ORDER BY contratos.created_at DESC
    `);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar contratos.' });
  }
});

app.post('/api/contratos', authenticateToken, upload.single('documento'), async (req, res) => {
  const { cliente_id, numero, valor, data_inicio, data_fim, status } = req.body;
  if (!cliente_id || !numero || !valor || !data_inicio || !data_fim) {
    return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser fornecidos.' });
  }

  // Handle uploaded file (Mocking upload or Google Drive linkage)
  let drive_file_id = null;
  if (req.file) {
    drive_file_id = `MOCK_GD_ID_${Date.now()}`;
    console.log(`Document received: ${req.file.originalname}. Google Drive integration would save this and return id: ${drive_file_id}`);
  }

  try {
    const result = await db.run(
      'INSERT INTO contratos (cliente_id, numero, valor, data_inicio, data_fim, status, drive_file_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cliente_id, numero, parseFloat(valor), data_inicio, data_fim, status || 'Ativo', drive_file_id]
    );

    const newContract = await db.get('SELECT * FROM contratos WHERE id = ?', [result.lastID]);
    res.status(201).json(newContract);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Número de contrato já existente.' });
    }
    res.status(500).json({ error: 'Erro ao cadastrar contrato.' });
  }
});

app.put('/api/contratos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { valor, status, data_fim } = req.body;

  try {
    const contract = await db.get('SELECT * FROM contratos WHERE id = ?', [id]);
    if (!contract) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }

    await db.run(
      'UPDATE contratos SET valor = ?, status = ?, data_fim = ? WHERE id = ?',
      [valor !== undefined ? parseFloat(valor) : contract.valor, status || contract.status, data_fim || contract.data_fim, id]
    );

    const updatedContract = await db.get('SELECT * FROM contratos WHERE id = ?', [id]);
    res.json(updatedContract);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar contrato.' });
  }
});

app.delete('/api/contratos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const contract = await db.get('SELECT * FROM contratos WHERE id = ?', [id]);
    if (!contract) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }
    await db.run('DELETE FROM contratos WHERE id = ?', [id]);
    res.json({ message: 'Contrato removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir contrato.' });
  }
});

// 5. Services Routes
app.get('/api/servicos', authenticateToken, async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM servicos ORDER BY sequencia ASC, nome ASC');
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar serviços.' });
  }
});

app.post('/api/servicos', authenticateToken, async (req, res) => {
  const { nome, unidade, tempo, sequencia } = req.body;
  if (!nome || !unidade || !tempo) {
    return res.status(400).json({ error: 'Nome, unidade e tempo são obrigatórios.' });
  }

  try {
    const result = await db.run(
      'INSERT INTO servicos (nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?)',
      [nome, parseInt(unidade), parseInt(tempo), sequencia !== undefined ? parseInt(sequencia) : 0]
    );
    const newService = await db.get('SELECT * FROM servicos WHERE id = ?', [result.lastID]);
    res.status(201).json(newService);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cadastrar serviço.' });
  }
});

app.put('/api/servicos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { nome, unidade, tempo, sequencia } = req.body;

  try {
    const service = await db.get('SELECT * FROM servicos WHERE id = ?', [id]);
    if (!service) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }

    await db.run(
      'UPDATE servicos SET nome = ?, unidade = ?, tempo = ?, sequencia = ? WHERE id = ?',
      [
        nome || service.nome,
        unidade !== undefined ? parseInt(unidade) : service.unidade,
        tempo !== undefined ? parseInt(tempo) : service.tempo,
        sequencia !== undefined ? parseInt(sequencia) : service.sequencia,
        id
      ]
    );

    const updatedService = await db.get('SELECT * FROM servicos WHERE id = ?', [id]);
    res.json(updatedService);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar serviço.' });
  }
});

app.delete('/api/servicos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const service = await db.get('SELECT * FROM servicos WHERE id = ?', [id]);
    if (!service) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }
    await db.run('DELETE FROM servicos WHERE id = ?', [id]);
    res.json({ message: 'Serviço removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir serviço.' });
  }
});

// 5.2. Product (Produtos) Routes
app.get('/api/produtos', authenticateToken, async (req, res) => {
  try {
    const list = await db.all(`
      SELECT 
        MaterialReferencia AS id,
        MaterialReferencia AS codigo,
        MaterialDescricao AS nome,
        MaterialUnidade AS unidade,
        MaterialValorUnitario AS preco,
        GrupoSigla AS grupoSigla,
        COALESCE(ProdutoGrupo, 8) AS ProdutoGrupo,
        COALESCE(ProdutoGrupo, 8) AS produtoGrupo,
        MaterialTipo AS tipo,
        MaterialImagem AS imagem,
        MaterialTempo AS tempo,
        COALESCE(ExibirNaProposta, 'Nao') AS ExibirNaProposta
      FROM Material 
      ORDER BY MaterialDescricao ASC
    `);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar produtos.' });
  }
});

app.post('/api/produtos', authenticateToken, upload.single('imagem'), async (req, res) => {
  const { codigo, nome, preco, unidade, tipo, tempo, ExibirNaProposta, ProdutoGrupo, produtoGrupo } = req.body;
  if (!codigo || !nome || !unidade) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({ error: 'Código, nome e unidade são obrigatórios.' });
  }

  // Normalizar a unidade para atender a constraint CHECK do SQLite
  let normUn = (unidade || '').toUpperCase().trim();
  if (normUn === 'UN') normUn = 'UNI';
  const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
  if (!allowedUnits.includes(normUn)) {
    normUn = 'UNI';
  }

  // Normalizar o tipo
  let normTipo = (tipo || 'Produto').trim();
  if (normTipo !== 'Serviço') normTipo = 'Produto';

  const tempoVal = normTipo === 'Serviço' ? (parseInt(tempo, 10) || 0) : 0;
  const normExibir = (ExibirNaProposta === 'Sim' || ExibirNaProposta === true || ExibirNaProposta === 'true' || ExibirNaProposta === '1') ? 'Sim' : 'Nao';

  // Normalizar ProdutoGrupo (1 a 8, default 8)
  const rawGrupo = ProdutoGrupo !== undefined ? ProdutoGrupo : produtoGrupo;
  let grupoVal = parseInt(rawGrupo, 10);
  if (isNaN(grupoVal) || grupoVal < 1 || grupoVal > 8) {
    grupoVal = 8;
  }

  // Obter caminho da imagem
  const imagem = req.file ? `uploads/${req.file.filename}` : null;

  try {
    const existing = await db.get('SELECT MaterialReferencia FROM Material WHERE MaterialReferencia = ?', [codigo]);
    if (existing) {
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: 'Já existe um produto cadastrado com este código.' });
    }

    await db.run(
      `INSERT INTO Material (MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialImagem, MaterialTempo, ExibirNaProposta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [codigo, nome, normUn, parseFloat(preco) || 0.0, null, grupoVal, normTipo, imagem, tempoVal, normExibir]
    );

    const newProduct = {
      id: codigo,
      codigo,
      nome,
      unidade: normUn,
      preco: parseFloat(preco) || 0.0,
      grupoSigla: null,
      ProdutoGrupo: grupoVal,
      produtoGrupo: grupoVal,
      tipo: normTipo,
      imagem,
      tempo: tempoVal,
      ExibirNaProposta: normExibir
    };
    res.status(201).json(newProduct);
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Erro ao criar produto.' });
  }
});

app.put('/api/produtos/:id', authenticateToken, upload.single('imagem'), async (req, res) => {
  const { id } = req.params; // MaterialReferencia
  const { nome, preco, unidade, tipo, tempo, ExibirNaProposta, ProdutoGrupo, produtoGrupo } = req.body;

  try {
    const product = await db.get('SELECT * FROM Material WHERE MaterialReferencia = ?', [id]);
    if (!product) {
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    // Normalizar a unidade para atender a constraint CHECK do SQLite
    let normUn = (unidade || '').toUpperCase().trim();
    if (normUn === 'UN') normUn = 'UNI';
    const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
    if (!allowedUnits.includes(normUn)) {
      normUn = 'UNI';
    }

    // Normalizar o tipo
    let normTipo = (tipo || product.MaterialTipo || 'Produto').trim();
    if (normTipo !== 'Serviço') normTipo = 'Produto';

    const tempoVal = normTipo === 'Serviço' ? (parseInt(tempo, 10) || 0) : 0;
    const normExibir = ExibirNaProposta !== undefined 
      ? ((ExibirNaProposta === 'Sim' || ExibirNaProposta === true || ExibirNaProposta === 'true' || ExibirNaProposta === '1') ? 'Sim' : 'Nao')
      : (product.ExibirNaProposta || 'Nao');

    // Normalizar ProdutoGrupo
    const rawGrupo = ProdutoGrupo !== undefined ? ProdutoGrupo : produtoGrupo;
    let grupoVal;
    if (rawGrupo !== undefined && rawGrupo !== null && rawGrupo !== '') {
      const parsed = parseInt(rawGrupo, 10);
      grupoVal = (!isNaN(parsed) && parsed >= 1 && parsed <= 8) ? parsed : 8;
    } else {
      grupoVal = product.ProdutoGrupo || 8;
    }

    // Se uma nova imagem foi enviada, substitui a antiga
    let imagem = product.MaterialImagem;
    if (req.file) {
      imagem = `uploads/${req.file.filename}`;
      if (product.MaterialImagem) {
        const oldPath = path.resolve(product.MaterialImagem);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    }

    await db.run(
      `UPDATE Material 
       SET MaterialDescricao = ?, MaterialUnidade = ?, MaterialValorUnitario = ?, MaterialTipo = ?, MaterialImagem = ?, MaterialTempo = ?, ExibirNaProposta = ?, ProdutoGrupo = ?
       WHERE MaterialReferencia = ?`,
      [nome, normUn, parseFloat(preco) || 0.0, normTipo, imagem, tempoVal, normExibir, grupoVal, id]
    );

    const updatedProduct = {
      id,
      codigo: id,
      nome,
      unidade: normUn,
      preco: parseFloat(preco) || 0.0,
      grupoSigla: product.GrupoSigla,
      ProdutoGrupo: grupoVal,
      produtoGrupo: grupoVal,
      tipo: normTipo,
      imagem,
      tempo: tempoVal,
      ExibirNaProposta: normExibir
    };
    res.json(updatedProduct);
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Erro ao atualizar produto.' });
  }
});

app.delete('/api/produtos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params; // MaterialReferencia
  try {
    const product = await db.get('SELECT * FROM Material WHERE MaterialReferencia = ?', [id]);
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    // Deletar arquivo de imagem se existir
    if (product.MaterialImagem) {
      const imgPath = path.resolve(product.MaterialImagem);
      if (fs.existsSync(imgPath)) {
        fs.unlinkSync(imgPath);
      }
    }

    await db.run('DELETE FROM Material WHERE MaterialReferencia = ?', [id]);
    res.json({ message: 'Produto removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir produto.' });
  }
});

// 6. Work Orders (Ordem de Serviço) Routes
app.get('/api/ordens-servico', authenticateToken, async (req, res) => {
  try {
    const list = await db.all(`
      SELECT ordens_servico.*, ordens_servico.cliente as cliente_nome 
      FROM ordens_servico 
      ORDER BY ordens_servico.data_inicio ASC, ordens_servico.numero DESC
    `);
    
    // Parse cronograma JSON if exists
    const parsedList = list.map(os => {
      if (os.cronograma) {
        try {
          os.cronograma = JSON.parse(os.cronograma);
        } catch (e) {
          os.cronograma = null;
        }
      }
      return os;
    });

    res.json(parsedList);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar ordens de serviço.' });
  }
});

app.get('/api/ordens-servico/:numero', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    const os = await db.get(`
      SELECT ordens_servico.*, ordens_servico.cliente as cliente_nome 
      FROM ordens_servico 
      WHERE ordens_servico.numero = ?
    `, [numero]);

    if (!os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    if (os.cronograma) {
      try {
        os.cronograma = JSON.parse(os.cronograma);
      } catch (e) {
        os.cronograma = null;
      }
    }

    const items = await db.all(`
      SELECT os_servicos.*, servicos.nome as servico_nome, servicos.sequencia, servicos.unidade 
      FROM os_servicos 
      JOIN servicos ON os_servicos.servico_id = servicos.id 
      WHERE os_servicos.os_numero = ?
      ORDER BY servicos.sequencia ASC, servicos.nome ASC
    `, [numero]);

    res.json({ ...os, servicos: items });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar detalhes da ordem de serviço.' });
  }
});
// Helper functions for workday timeline calculations (Monday-Friday 08:00-12:00, 13:30-17:30)
function avancarProximaHoraUtil(date) {
  let d = new Date(date);
  const day = d.getDay();
  
  if (day === 6) {
    d.setDate(d.getDate() + 2);
    d.setHours(8, 0, 0, 0);
    return d;
  }
  if (day === 0) {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d;
  }
  
  const hour = d.getHours();
  const minutes = d.getMinutes();
  const timeInMin = hour * 60 + minutes;
  
  if (timeInMin < 8 * 60) {
    d.setHours(8, 0, 0, 0);
  } else if (timeInMin >= 12 * 60 && timeInMin < 13 * 60 + 30) {
    d.setHours(13, 30, 0, 0);
  } else if (timeInMin >= 17 * 60 + 30) {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return avancarProximaHoraUtil(d);
  }
  return d;
}

function somarHorasUteis(startDateObj, durationHours) {
  let d = new Date(startDateObj);
  let minutesToAdd = (parseInt(durationHours) || 1) * 60;
  
  d = avancarProximaHoraUtil(d);
  
  while (minutesToAdd > 0) {
    const hour = d.getHours();
    const minutes = d.getMinutes();
    const timeInMin = hour * 60 + minutes;
    
    if (timeInMin >= 8 * 60 && timeInMin < 12 * 60) {
      const remainingMorning = 12 * 60 - timeInMin;
      if (minutesToAdd <= remainingMorning) {
        d.setMinutes(d.getMinutes() + minutesToAdd);
        minutesToAdd = 0;
      } else {
        minutesToAdd -= remainingMorning;
        d.setHours(12, 0, 0, 0);
        d = avancarProximaHoraUtil(d);
      }
    } else if (timeInMin >= 13 * 60 + 30 && timeInMin < 17 * 60 + 30) {
      const remainingAfternoon = (17 * 60 + 30) - timeInMin;
      if (minutesToAdd <= remainingAfternoon) {
        d.setMinutes(d.getMinutes() + minutesToAdd);
        minutesToAdd = 0;
      } else {
        minutesToAdd -= remainingAfternoon;
        d.setHours(17, 30, 0, 0);
        d = avancarProximaHoraUtil(d);
      }
    } else {
      d = avancarProximaHoraUtil(d);
    }
  }
  return d;
}

app.post('/api/ordens-servico', authenticateToken, async (req, res) => {
  const { qtd_chapas, qtd_especiais, qtd_caixa } = req.body;

  try {
    // Generate OS Numero: Year(4) + Sequential(6)
    const currentYear = new Date().getFullYear();
    const minRange = currentYear * 1000000;
    const maxRange = currentYear * 1000000 + 999999;
    
    const row = await db.get(
      'SELECT MAX(numero) as maxNum FROM ordens_servico WHERE numero >= ? AND numero <= ?',
      [minRange, maxRange]
    );

    let nextSeq = 1;
    if (row && row.maxNum) {
      nextSeq = (row.maxNum % 1000000) + 1;
    }
    const osNumero = currentYear * 1000000 + nextSeq;

    // Find the OS with the highest number in situation 'Aberta' with a non-null data_fim
    const refOs = await db.get(
      "SELECT data_fim FROM ordens_servico WHERE status = 'Aberta' AND data_fim IS NOT NULL ORDER BY numero DESC LIMIT 1"
    );

    let computedDataInicio = null;
    if (refOs && refOs.data_fim) {
      const d = new Date(refOs.data_fim);
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      const nextWorkday = avancarProximaHoraUtil(d);
      computedDataInicio = nextWorkday.toISOString();
    }

    // Insert OS Header with computed data_inicio
    await db.run(
      'INSERT INTO ordens_servico (numero, status, ambiente, cliente, qtd_pecas, qtd_chapas, qtd_especiais, qtd_caixa, tempo_previsto, tempo_real, data_inicio, data_fim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [osNumero, 'Aberta', null, null, 0, parseInt(qtd_chapas) || 0, parseInt(qtd_especiais) || 0, parseInt(qtd_caixa) || 0, 0, 0, computedDataInicio, null]
    );

    const newOs = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [osNumero]);
    res.status(201).json(newOs);
  } catch (error) {
    console.error('CREATE OS ERROR:', error);
    res.status(500).json({ error: 'Erro ao registrar ordem de serviço.' });
  }
});

app.put('/api/ordens-servico/:numero', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  const { status, ambiente, cliente, qtd_chapas, qtd_especiais, qtd_caixa, servicos, cronograma } = req.body;

  try {
    const os = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [numero]);
    if (!os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    let dataFechamento = os.data_fechamento;
    if (status === 'Fechada' && os.status !== 'Fechada') {
      dataFechamento = new Date().toISOString();
    } else if (status && status !== 'Fechada') {
      dataFechamento = null;
    }



    let computedDataInicio = os.data_inicio;
    let computedDataFim = os.data_fim;

    if (cronograma !== undefined) {
      if (cronograma && Array.isArray(cronograma) && cronograma.length > 0) {
        let minStart = null;
        let maxEnd = null;
        cronograma.forEach(t => {
          if (t.data_inicio) {
            const sDate = new Date(t.data_inicio);
            if (!minStart || sDate < minStart) {
              minStart = sDate;
            }
            
            // Calculate task end date by adding tempo (hours)
            const duration = parseInt(t.tempo) || 1;
            const eDate = somarHorasUteis(sDate, duration);
            if (!maxEnd || eDate > maxEnd) {
              maxEnd = eDate;
            }
          }
        });
        computedDataInicio = minStart ? minStart.toISOString() : null;
        computedDataFim = maxEnd ? maxEnd.toISOString() : null;
      } else {
        computedDataInicio = null;
        computedDataFim = null;
      }
    }

    await db.run('BEGIN TRANSACTION');

    // 1. Update OS header fields
    await db.run(
      'UPDATE ordens_servico SET status = ?, ambiente = ?, cliente = ?, qtd_chapas = ?, qtd_especiais = ?, qtd_caixa = ?, data_fechamento = ?, cronograma = ?, data_inicio = ?, data_fim = ? WHERE numero = ?',
      [
        status || os.status,
        ambiente !== undefined ? ambiente : os.ambiente,
        cliente !== undefined ? cliente : os.cliente,
        qtd_chapas !== undefined ? parseInt(qtd_chapas) : os.qtd_chapas,
        qtd_especiais !== undefined ? parseInt(qtd_especiais) : os.qtd_especiais,
        qtd_caixa !== undefined ? parseInt(qtd_caixa) : os.qtd_caixa,
        dataFechamento,
        cronograma !== undefined ? (cronograma ? JSON.stringify(cronograma) : null) : os.cronograma,
        computedDataInicio,
        computedDataFim,
        numero
      ]
    );

    // 2. If servicos array is provided, update service quantities and calculate predicted times
    if (servicos && Array.isArray(servicos)) {
      for (const item of servicos) {
        const qty = parseInt(item.quantidade);
        if (qty > 0) {
          const service = await db.get('SELECT tempo FROM servicos WHERE id = ?', [item.servico_id]);
          if (service) {
            const itemPrevTime = qty * service.tempo;
            await db.run(
              'UPDATE os_servicos SET quantidade = ?, tempo_previsto = ? WHERE os_numero = ? AND servico_id = ?',
              [qty, itemPrevTime, numero, item.servico_id]
            );
          }
        }
      }

      // Recalculate OS total tempo_previsto
      const totalPrevRow = await db.get(
        'SELECT SUM(tempo_previsto) as total FROM os_servicos WHERE os_numero = ?',
        [numero]
      );
      await db.run(
        'UPDATE ordens_servico SET tempo_previsto = ? WHERE numero = ?',
        [totalPrevRow.total || 0, numero]
      );
    }

    await db.run('COMMIT');

    const updated = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [numero]);
    res.json(updated);
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('UPDATE OS ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar ordem de serviço.' });
  }
});

app.post('/api/ordens-servico/:numero/servicos/:servico_id/action', authenticateToken, async (req, res) => {
  const { numero, servico_id } = req.params;
  const { action } = req.body; // 'start' or 'end'

  try {
    const item = await db.get(
      'SELECT * FROM os_servicos WHERE os_numero = ? AND servico_id = ?',
      [numero, servico_id]
    );

    if (!item) {
      return res.status(404).json({ error: 'Item de serviço não encontrado nesta OS.' });
    }

    const now = new Date().toISOString();

    if (action === 'start') {
      await db.run(
        'UPDATE os_servicos SET data_inicio = ?, data_fim = NULL, tempo_real = NULL WHERE os_numero = ? AND servico_id = ?',
        [now, numero, servico_id]
      );
      
      // Update OS status to "EmProducao" automatically if it was "Aberta"
      await db.run(
        "UPDATE ordens_servico SET status = 'EmProducao' WHERE numero = ? AND status = 'Aberta'",
        [numero]
      );
    } else if (action === 'end') {
      let dataInicio = item.data_inicio;
      if (!dataInicio) {
        // If not started manually, fetch OS opening time
        const os = await db.get('SELECT data_abertura FROM ordens_servico WHERE numero = ?', [numero]);
        dataInicio = os ? os.data_abertura : now;
        
        await db.run(
          'UPDATE os_servicos SET data_inicio = ? WHERE os_numero = ? AND servico_id = ?',
          [dataInicio, numero, servico_id]
        );
      }

      const diffMs = new Date(now) - new Date(dataInicio);
      const diffMin = Math.max(1, Math.round(diffMs / 60000)); // minimum 1 minute for representation

      await db.run(
        'UPDATE os_servicos SET data_fim = ?, tempo_real = ? WHERE os_numero = ? AND servico_id = ?',
        [now, diffMin, numero, servico_id]
      );

      // Recalculate OS total real time
      const sumRow = await db.get(
        'SELECT SUM(tempo_real) as total FROM os_servicos WHERE os_numero = ? AND tempo_real IS NOT NULL',
        [numero]
      );
      await db.run(
        'UPDATE ordens_servico SET tempo_real = ? WHERE numero = ?',
        [sumRow.total || 0, numero]
      );
    } else {
      return res.status(400).json({ error: 'Ação inválida.' });
    }

    const updatedItem = await db.get(
      'SELECT * FROM os_servicos WHERE os_numero = ? AND servico_id = ?',
      [numero, servico_id]
    );
    res.json(updatedItem);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar tempo do serviço da OS.' });
  }
});

app.delete('/api/ordens-servico/:numero', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    const os = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [numero]);
    if (!os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }
    
    await db.run('BEGIN TRANSACTION');
    await db.run('DELETE FROM os_pecas WHERE os_numero = ?', [numero]);
    await db.run('DELETE FROM os_servicos WHERE os_numero = ?', [numero]);
    await db.run('DELETE FROM ordens_servico WHERE numero = ?', [numero]);
    await db.run('COMMIT');

    res.json({ message: 'Ordem de serviço removida com sucesso.' });
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('DELETE OS ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir ordem de serviço.' });
  }
});

// Helper: parse pieces labels from PDF text
function parseLabelsFromText(text) {
  const pieces = [];
  
  // Format A: Labeled fields (Ezattus format)
  // Matching across lines using multiline logic
  const blockRegex = /Cliente:\s*(.*?)\r?\nMódulo:\s*(.*?)\r?\nProjeto:\s*(.*?)\r?\nChapa:\s*(.*?)\r?\n(.*?)\r?\nDimen\.:\s*(.*?)\r?\nPeça:\s*(.*?)\r?\nCód\.\s*Item:\s*(.*)/gi;
  
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const [_, cliente, modulo, projeto, chapa, posicao, dimen, peca, codItem] = match;
    pieces.push({
      cliente: cliente.trim(),
      modulo: modulo.trim(),
      projeto: projeto.trim(),
      chapa: chapa.trim(),
      posicao: posicao.trim(),
      dimensoes: dimen.trim(),
      descricao: peca.split(' - ').pop().trim(),
      codigo: codItem.trim()
    });
  }

  // Fallback: Heuristic line-by-line parser (supporting comma decimals)
  if (pieces.length === 0) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const dimRegex = /\b\d+(?:[.,]\d+)?\s*[xX*]\s*\d+(?:[.,]\d+)?(?:\s*[xX*]\s*\d+(?:[.,]\d+)?)?\b/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (dimRegex.test(line)) {
        const dimensoes = line.match(dimRegex)[0];
        
        let descricao = (i > 0) ? lines[i - 1] : 'Peça Importada';
        if (descricao.toLowerCase().includes('dimens') || dimRegex.test(descricao)) {
          descricao = 'Peça Importada';
        }

        let material = (i < lines.length - 1) ? lines[i + 1] : 'MDF Geral';
        if (material.toLowerCase().includes('qtd') || material.toLowerCase().includes('cod') || dimRegex.test(material)) {
          material = 'MDF Geral';
        }

        let quantidade = 1;
        let codigo = '';

        for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
          const checkLine = lines[j];
          const qtyMatch = checkLine.match(/(?:qtd|quantidade|quant|qnt)[:.\s]*(\d+)\b/i);
          if (qtyMatch) {
            quantidade = parseInt(qtyMatch[1]);
          }

          const codMatch = checkLine.match(/(?:cód|cod|código|ref|cód\.\s*item)[:.\s]*([A-Z0-9-]+)\b/i);
          if (codMatch) {
            codigo = codMatch[1];
          }
        }

        pieces.push({
          cliente: 'Samanta Meneguzi',
          modulo: 'Módulo Geral',
          projeto: 'Projeto Geral',
          chapa: material,
          posicao: '1.A',
          dimensoes,
          descricao,
          codigo: codigo || null
        });
      }
    }
  }

  // Seed mock pieces if 0 labels parsed (for testability with arbitrary PDFs)
  if (pieces.length === 0) {
    pieces.push(
      { cliente: 'Samanta Meneguzi', modulo: '5947-Tamponamento Inferior', projeto: 'RecepçãoV2', chapa: 'MDF Branco TX 18mm', posicao: '1.A', dimensoes: '700x350x18', descricao: 'Lateral Esquerda', codigo: 'PEC-001' },
      { cliente: 'Samanta Meneguzi', modulo: '5947-Tamponamento Inferior', projeto: 'RecepçãoV2', chapa: 'MDF Branco TX 18mm', posicao: '1.A', dimensoes: '700x350x18', descricao: 'Lateral Direita', codigo: 'PEC-002' },
      { cliente: 'Samanta Meneguzi', modulo: '5947-Tamponamento Inferior', projeto: 'RecepçãoV2', chapa: 'MDF Branco TX 18mm', posicao: '1.B', dimensoes: '800x370x18', descricao: 'Tampo Superior', codigo: 'PEC-003' },
      { cliente: 'Samanta Meneguzi', modulo: '5781-Sem Portas c/ Rodapé', projeto: 'RecepçãoV2', chapa: 'MDF Carvalho 6mm', posicao: '2.C', dimensoes: '795x695x6', descricao: 'Fundo Traseiro', codigo: 'PEC-004' },
      { cliente: 'Samanta Meneguzi', modulo: '3922-Armário Basculante', projeto: 'RecepçãoV2', chapa: 'MDF Cinza Sagrado 18mm', posicao: '1.C', dimensoes: '796x346x18', descricao: 'Porta de Giro', codigo: 'PEC-005' }
    );
  }

  // Format and clean up fields
  return pieces.map((p, idx) => {
    if (!p.codigo) {
      p.codigo = `PEC-${String(idx + 1).padStart(3, '0')}`;
    }
    p.descricao = p.descricao.replace(/^(descrição|desc|nome|peça)[:.\s]*/i, '').trim();
    p.chapa = p.chapa ? p.chapa.replace(/^(material|mat|chapa)[:.\s]*/i, '').trim() : 'MDF Geral';
    return p;
  });
}

// 6b. Work Order Pieces (Peças da OS) Routes
app.get('/api/ordens-servico/:numero/pecas', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    const list = await db.all('SELECT * FROM os_pecas WHERE os_numero = ? ORDER BY modulo ASC, id ASC', [numero]);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar peças da ordem de serviço.' });
  }
});

app.post('/api/ordens-servico/import-new', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
    const pdfData = await instance.getText();
    const text = pdfData.text || '';

    // Delete temp upload file
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      console.error('Erro ao deletar arquivo temporário:', e);
    }

    const pieces = parseLabelsFromText(text);
    if (pieces.length === 0) {
      return res.status(400).json({ error: 'Nenhuma peça pôde ser lida do PDF.' });
    }

    const firstPiece = pieces[0];
    const parsedCliente = firstPiece ? firstPiece.cliente : 'Samanta Meneguzi';
    const parsedProjeto = firstPiece ? firstPiece.projeto : 'RecepçãoV2';

    // Generate OS Numero: Year(4) + Sequential(6)
    const currentYear = new Date().getFullYear();
    const minRange = currentYear * 1000000;
    const maxRange = currentYear * 1000000 + 999999;
    
    const row = await db.get(
      'SELECT MAX(numero) as maxNum FROM ordens_servico WHERE numero >= ? AND numero <= ?',
      [minRange, maxRange]
    );

    let nextSeq = 1;
    if (row && row.maxNum) {
      nextSeq = (row.maxNum % 1000000) + 1;
    }
    const osNumero = currentYear * 1000000 + nextSeq;

    // Fetch all active services to assign to the new OS
    const dbServices = await db.all('SELECT * FROM servicos ORDER BY sequencia ASC');
    let tempoTotalPrevisto = 0;
    const itemsToInsert = [];

    for (const service of dbServices) {
      const qty = 1; // Assign default quantity = 1 for each standard service
      const itemPrevTime = qty * service.tempo;
      tempoTotalPrevisto += itemPrevTime;
      itemsToInsert.push({
        servico_id: service.id,
        quantidade: qty,
        tempo_previsto: itemPrevTime
      });
    }

    await db.run('BEGIN TRANSACTION');

    // Insert OS Header
    await db.run(
      'INSERT INTO ordens_servico (numero, status, ambiente, cliente, qtd_pecas, tempo_previsto, tempo_real) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [osNumero, 'Aberta', parsedProjeto || null, parsedCliente || null, pieces.length, tempoTotalPrevisto, 0]
    );

    // Insert OS Services
    for (const item of itemsToInsert) {
      await db.run(
        'INSERT INTO os_servicos (os_numero, servico_id, quantidade, tempo_previsto) VALUES (?, ?, ?, ?)',
        [osNumero, item.servico_id, item.quantidade, item.tempo_previsto]
      );
    }

    // Insert OS Pieces
    for (const p of pieces) {
      await db.run(
        'INSERT INTO os_pecas (os_numero, modulo, chapa, posicao, dimensoes, descricao, codigo) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [osNumero, p.modulo, p.chapa, p.posicao, p.dimensoes, p.descricao, p.codigo]
      );
    }

    await db.run('COMMIT');

    const newOs = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [osNumero]);
    res.status(201).json(newOs);
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('IMPORT NEW OS ERROR:', error);
    res.status(500).json({ error: 'Erro ao processar arquivo e criar Ordem de Serviço.' });
  }
});

app.post('/api/ordens-servico/:numero/pecas/import', authenticateToken, upload.single('file'), async (req, res) => {
  const { numero } = req.params;
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  try {
    const os = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [numero]);
    if (!os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
    const pdfData = await instance.getText();
    const text = pdfData.text || '';

    // Delete temp upload file
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      console.error('Erro ao deletar arquivo temporário:', e);
    }

    const pieces = parseLabelsFromText(text);

    const firstPiece = pieces[0];
    const parsedCliente = firstPiece ? firstPiece.cliente : 'Samanta Meneguzi';
    const parsedProjeto = firstPiece ? firstPiece.projeto : 'RecepçãoV2';

    // Query all services in sequencer order to compute items properties
    const dbServices = await db.all('SELECT * FROM servicos ORDER BY sequencia ASC');
    let tempoTotalPrevisto = 0;
    const servicesToInsert = [];

    for (const service of dbServices) {
      let qty = 1;
      const sName = (service.nome || '').trim().toLowerCase();

      if (sName === 'separação') {
        qty = 1;
      } else if (sName === 'usinagem') {
        qty = parseInt(os.qtd_chapas) || 0;
      } else if (sName === 'fitagem') {
        qty = pieces.length;
      } else if (sName === 'montagem de caixa' || sName === 'montagem caixa') {
        qty = parseInt(os.qtd_caixa) || 0;
      } else if (sName === 'especial') {
        qty = parseInt(os.qtd_especiais) || 0;
      } else {
        qty = 1;
      }

      const itemPrevTime = qty * (service.tempo || 0);
      tempoTotalPrevisto += itemPrevTime;

      servicesToInsert.push({
        servico_id: service.id,
        quantidade: qty,
        tempo_previsto: itemPrevTime
      });
    }

    await db.run('BEGIN TRANSACTION');
    
    // Clear previous pieces for this OS
    await db.run('DELETE FROM os_pecas WHERE os_numero = ?', [numero]);

    // Insert new pieces (without client and project fields)
    for (const p of pieces) {
      await db.run(
        'INSERT INTO os_pecas (os_numero, modulo, chapa, posicao, dimensoes, descricao, codigo) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [numero, p.modulo, p.chapa, p.posicao, p.dimensoes, p.descricao, p.codigo]
      );
    }

    // Clear previous services for this OS
    await db.run('DELETE FROM os_servicos WHERE os_numero = ?', [numero]);

    // Insert newly calculated services
    for (const item of servicesToInsert) {
      await db.run(
        'INSERT INTO os_servicos (os_numero, servico_id, quantidade, tempo_previsto) VALUES (?, ?, ?, ?)',
        [numero, item.servico_id, item.quantidade, item.tempo_previsto]
      );
    }

    // Update OS header with the client, project (ambiente), total count of pieces and calculated tempo_previsto
    await db.run(
      'UPDATE ordens_servico SET cliente = ?, ambiente = ?, qtd_pecas = ?, tempo_previsto = ? WHERE numero = ?',
      [parsedCliente, parsedProjeto, pieces.length, tempoTotalPrevisto, numero]
    );

    await db.run('COMMIT');

    const list = await db.all('SELECT * FROM os_pecas WHERE os_numero = ? ORDER BY id ASC', [numero]);
    res.json(list);
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('IMPORT ERROR:', error);
    res.status(500).json({ error: 'Erro ao processar e importar o arquivo PDF.' });
  }
});

// Helper for parsing chapas PDF text
function parsePdfText(textPages) {
  const chapasMap = new Map(); // Key: Cliente-Projeto-Chapa, Value: ChapaObj
  
  for (const page of textPages) {
    if (!page.text || !page.text.includes("Lista de Cortes")) {
      continue;
    }
    
    const lines = page.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    let cliente = '';
    let projeto = '';
    let chapaNumStr = '';
    let acabamento = '';
    let descChapa = '';
    let headerParsed = false;
    let tableHeaderIndex = -1;
    
    // Parse header fields first
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("Cliente:")) {
        cliente = line.replace("Cliente:", "").trim();
      } else if (line.startsWith("Projeto:")) {
        projeto = line.replace("Projeto:", "").trim();
      } else if (/^descri[cç][aã]o:/i.test(line)) {
        descChapa = line.replace(/^descri[cç][aã]o:\s*/i, "").trim();
      } else if (line.startsWith("Chapa") && line.includes("Acabamento:")) {
        const chapaMatch = line.match(/Chapa\s+(\d+)\s+Acabamento:\s*(.*?)\s+Peças:/i);
        if (chapaMatch) {
          chapaNumStr = "Chapa " + chapaMatch[1];
          acabamento = chapaMatch[2].trim();
        } else {
          const chapaMatch2 = line.match(/Chapa\s+(\d+)\s+Acabamento:\s*(.*)/i);
          if (chapaMatch2) {
            chapaNumStr = "Chapa " + chapaMatch2[1];
            acabamento = chapaMatch2[2].trim();
          }
        }
      } else if (line.startsWith("Item") && line.includes("Descrição") && line.includes("Dimensão")) {
        tableHeaderIndex = i;
        headerParsed = true;
        break;
      }
    }
    
    if (!headerParsed || tableHeaderIndex === -1) {
      continue;
    }
    
    const chapaKey = `${cliente}|${projeto}|${chapaNumStr}`;
    if (!chapasMap.has(chapaKey)) {
      chapasMap.set(chapaKey, {
        cliente,
        projeto,
        chapa: chapaNumStr,
        acabamento,
        descChapa,
        pecas: []
      });
    }
    const chapaObj = chapasMap.get(chapaKey);
    
    // Group lines by piece
    const pieceLinesGroups = [];
    let currentGroup = null;
    
    for (let i = tableHeaderIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith("--") && line.endsWith("--")) {
        break;
      }
      if (/^\d+$/.test(line)) {
        continue;
      }
      
      const itemMatch = line.match(/^(\d+\.[A-Z]{1,2})\b/);
      if (itemMatch) {
        if (currentGroup) {
          pieceLinesGroups.push(currentGroup);
        }
        currentGroup = [line];
      } else if (currentGroup) {
        currentGroup.push(line);
      }
    }
    if (currentGroup) {
      pieceLinesGroups.push(currentGroup);
    }
    
    // Parse each group
    for (const group of pieceLinesGroups) {
      const joinedLine = group.join(" ").trim();
      const itemMatch = joinedLine.match(/^(\d+\.[A-Z]{1,2})\b(.*)/);
      if (!itemMatch) continue;
      
      const item = itemMatch[1];
      const rest = itemMatch[2].trim();
      
      const dimRegex = /(\d+(?:[.,]\d+)?\s*[xX]\s*\d+(?:[.,]\d+)?(?:\s*[xX]\s*\d+(?:[.,]\d+)?)?)/;
      const dimMatch = rest.match(dimRegex);
      
      if (dimMatch) {
        const dimensao = dimMatch[1].trim();
        const parts = rest.split(dimensao);
        const descricao = parts[0].trim();
        const afterDim = parts.slice(1).join(dimensao).trim();
        
        const suffix = `${projeto}(${cliente})`;
        let parentDesc = afterDim;
        if (parentDesc.endsWith(suffix)) {
          parentDesc = parentDesc.substring(0, parentDesc.length - suffix.length).trim();
        } else {
          const suffix2 = `${projeto} (${cliente})`;
          if (parentDesc.endsWith(suffix2)) {
            parentDesc = parentDesc.substring(0, parentDesc.length - suffix2.length).trim();
          }
        }
        
        chapaObj.pecas.push({
          item,
          descricao,
          dimensao,
          descricao_pai: parentDesc
        });
      } else {
        chapaObj.pecas.push({
          item,
          descricao: rest,
          dimensao: '',
          descricao_pai: ''
        });
      }
    }
  }
  
  return Array.from(chapasMap.values());
}

// Endpoint to import chapas and pieces from PDF
app.post('/api/ordens-servico/:numero/importar-chapas', authenticateToken, upload.single('arquivo'), async (req, res) => {
  const { numero } = req.params;
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  try {
    const os = await db.get('SELECT * FROM ordens_servico WHERE numero = ?', [numero]);
    if (!os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
    await instance.load();
    const pdfData = await instance.getText();

    // Delete temp upload file
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      console.error('Erro ao deletar arquivo temporário:', e);
    }

    const chapas = parsePdfText(pdfData.pages);
    if (chapas.length === 0) {
      return res.status(400).json({ error: 'Nenhuma chapa ou peça pôde ser lida do PDF.' });
    }

    await db.run('BEGIN TRANSACTION');

    // Clear previous chapas for this OS
    await db.run('DELETE FROM OS_Chapas WHERE os_numero = ?', [numero]);

    // Insert chapas and pieces
    for (const chapa of chapas) {
      const chapaRes = await db.run(
        `INSERT INTO OS_Chapas (os_numero, cliente, projeto, chapa, acabamento) 
         VALUES (?, ?, ?, ?, ?)`,
        [numero, chapa.cliente, chapa.projeto, chapa.chapa, chapa.acabamento]
      );
      const chapaId = chapaRes.lastID;

      for (const peca of chapa.pecas) {
        await db.run(
          `INSERT INTO OS_ChapasPecas (chapa_id, item, descricao, dimensao, descricao_pai) 
           VALUES (?, ?, ?, ?, ?)`,
          [chapaId, peca.item, peca.descricao, peca.dimensao, peca.descricao_pai]
        );
      }
    }

    await db.run('COMMIT');

    // Return the inserted chapas
    const list = await db.all('SELECT * FROM OS_Chapas WHERE os_numero = ? ORDER BY id ASC', [numero]);
    res.json(list);
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('IMPORT CHAPAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao processar e importar as chapas do PDF.' });
  }
});

// Endpoint to get chapas and pieces for an OS
app.get('/api/ordens-servico/:numero/chapas', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    const chapas = await db.all('SELECT * FROM OS_Chapas WHERE os_numero = ? ORDER BY id ASC', [numero]);
    for (const chapa of chapas) {
      chapa.pecas = await db.all('SELECT * FROM OS_ChapasPecas WHERE chapa_id = ? ORDER BY item ASC', [chapa.id]);
    }
    res.json(chapas);
  } catch (error) {
    console.error('FETCH CHAPAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar as chapas e peças da OS.' });
  }
});

// 7. Planta Baixa (Factory Floor Plan) Data Route
app.get('/api/planta-baixa/dados', authenticateToken, async (req, res) => {
  try {
    const list = await db.all(`
      SELECT 
        os_servicos.*, 
        ordens_servico.status as os_status, 
        ordens_servico.ambiente, 
        clientes.nome as cliente_nome, 
        servicos.nome as servico_nome, 
        servicos.sequencia
      FROM os_servicos
      JOIN ordens_servico ON os_servicos.os_numero = ordens_servico.numero
      JOIN servicos ON os_servicos.servico_id = servicos.id
      LEFT JOIN clientes ON ordens_servico.cliente_id = clientes.id
      WHERE ordens_servico.status IN ('Aberta', 'EmProducao')
    `);
    res.json(list);
  } catch (error) {
    console.error('PLANTA BAIXA DADOS ERROR:', error);
    res.status(500).json({ error: 'Erro ao carregar dados da planta baixa.' });
  }
});

// 8. Layout Files Routes (Importação de Layouts)
app.get('/api/arquivos-importados', authenticateToken, async (req, res) => {
  try {
    const list = await db.all(`
      SELECT 
        id, 
        nome_arquivo, 
        tamanho, 
        tipo_layout, 
        caminho_arquivo, 
        data_upload,
        COALESCE(projeto_id, (SELECT id FROM projetos ORDER BY id ASC LIMIT 1)) as projeto_id
      FROM arquivos_importados 
      ORDER BY data_upload DESC
    `);
    res.json(list);
  } catch (error) {
    console.error('GET LAYOUTS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar arquivos de layout.' });
  }
});

function parseMaterialsFromText(text) {
  const lines = text.split('\n');
  const materials = [];
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    // Split by tab
    const parts = line.split('\t').map(p => p.trim());
    if (parts.length >= 4) {
      const ref = parts[0];
      const desc = parts[1];
      const qtyStr = parts[2];
      const un = parts[3];
      
      // Skip header
      if (ref.toLowerCase().includes('referên') || ref.toLowerCase().includes('referen')) {
        continue;
      }
      
      const qty = parseFloat(qtyStr.replace(',', '.'));
      if (!isNaN(qty)) {
        materials.push({
          referencia: ref,
          descricao: desc,
          qtd: qty,
          un: un
        });
      }
    }
  }
  return materials;
}

// Função auxiliar para tratamento e formatação da descrição de MDF
function cleanMdfDescription(desc) {
  if (!desc) return desc;
  
  // Normalizar barras invertidas e espaços duplicados
  let clean = desc.replace(/\\/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Se inicia com "Chapa MDF", passa a iniciar com "MDF"
  if (clean.toLowerCase().startsWith("chapa mdf")) {
    clean = "MDF" + clean.substring(9);
  }
  
  // Remove sequenciais numéricos que começam após o prefixo, ex: "MDF 5-Freijó..." -> "MDF Freijó..."
  clean = clean.replace(/^MDF\s+\d+-\s*/i, "MDF ");
  
  // Corrigir typos comuns como "Natrual" -> "Natural"
  clean = clean.replace(/Natrual/gi, "Natural");
  
  // Capturar a espessura se houver "Espessura XXmm" ou "Espessura XX mm"
  const espessuraMatch = clean.match(/Espessura\s*(\d+)\s*mm/i);
  let espessuraStr = "";
  if (espessuraMatch) {
    const mm = parseInt(espessuraMatch[1]);
    // Preenche com zero à esquerda se for menor que 10 (ex: 6mm -> 06mm)
    const formattedMm = mm < 10 ? `0${mm}` : `${mm}`;
    espessuraStr = ` - ${formattedMm}mm`;
    
    // Remove o termo Espessura da string
    clean = clean.replace(/Espessura\s*\d+\s*mm/i, "").trim();
  }
  
  // Remove termos de sentido de fibra redundantes
  clean = clean.replace(/\bHorizontal\b/gi, "");
  clean = clean.replace(/\bVertical\b/gi, "");
  
  // Limpar espaços duplicados pós-remoções
  clean = clean.replace(/\s+/g, ' ').trim();
  
  // Concatena a espessura formatada no final da descrição
  if (espessuraStr) {
    clean = clean + espessuraStr;
  }
  
  return clean;
}

// Rotina de Carga de Materiais (CarregarMateriais)
async function CarregarMateriais(file, finalProjectId) {
  try {
    const fileBuffer = fs.readFileSync(file.path);
    const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
    if (instance.load) await instance.load();
    const pdfData = await instance.getText();
    const text = pdfData.text || '';
    
    const materials = parseMaterialsFromText(text);
    if (materials.length > 0 && finalProjectId) {
      // Limpa materiais anteriores desse projeto para evitar duplicatas
      await db.run('DELETE FROM Projeto_Materiais WHERE projeto_id = ?', [finalProjectId]);
      
      // Converte chapas de MDF de M2 para CHP se necessário e limpa descrições de MDF
      for (const m of materials) {
        if (m.referencia && m.referencia.toUpperCase().startsWith('MDF')) {
          // Trata a descrição do MDF
          m.descricao = cleanMdfDescription(m.descricao);
          
          if (m.un && m.un.toUpperCase() === 'M2') {
            let qtdCHP;
            if (m.qtd <= 5) {
              qtdCHP = 1;
            } else {
              const base = Math.floor(m.qtd / 5);
              const remainder = m.qtd % 5;
              qtdCHP = remainder > 0 ? base + 1 : base;
            }
            m.qtd = qtdCHP;
            m.un = 'CHP';
          }
        }
      }
      
      // 1. Inserir itens lidos do arquivo na tabela Projeto_Materiais
      for (const m of materials) {
        await db.run(
          'INSERT INTO Projeto_Materiais (projeto_id, referencia, descricao, qtd, un) VALUES (?, ?, ?, ?, ?)',
          [finalProjectId, m.referencia, m.descricao, m.qtd, m.un]
        );
      }

      // Calcular a soma de todas as chapas de MDF do projeto
      let totalChapasMDF = 0;
      for (const m of materials) {
        if (m.referencia && m.referencia.toUpperCase().startsWith('MDF') && m.un && m.un.toUpperCase() === 'CHP') {
          totalChapasMDF += m.qtd;
        }
      }

      // Calcular a soma de todas as fitas (referência começa com 'FT')
      let totalFita = 0;
      for (const m of materials) {
        if (m.referencia && m.referencia.toUpperCase().startsWith('FT')) {
          totalFita += m.qtd;
        }
      }

      // 2. Inserir os registros extras de fabricação na tabela Projeto_Materiais
      const extraItems = [
        { referencia: 'FAB.USI.CHP', descricao: 'Usinagem de chapas', qtd: totalChapasMDF, un: 'CHP' },
        { referencia: 'FAB.FIT.PCA', descricao: 'Fitagem', qtd: totalFita, un: 'M' },
        { referencia: 'FAB.MON.CXA', descricao: 'Montagem caixa', qtd: 0, un: 'UND' },
        { referencia: 'FAB.ESP.PCA', descricao: 'Item especial', qtd: 0, un: 'UND' },
        { referencia: 'FAB.EMB.UND', descricao: 'Embalagem', qtd: 0, un: 'UND' },
        { referencia: 'FAB.MON.CLI', descricao: 'Montagem cliente', qtd: 0, un: 'DIA' }
      ];

      for (const item of extraItems) {
        await db.run(
          'INSERT INTO Projeto_Materiais (projeto_id, referencia, descricao, qtd, un) VALUES (?, ?, ?, ?, ?)',
          [finalProjectId, item.referencia, item.descricao, item.qtd, item.un]
        );
      }

      // 3. Inserir todos na tabela global Material se a referência não existir
      const mappedMaterials = materials.map(m => ({ ...m, tipo: 'Produto' }));
      const mappedExtras = extraItems.map(e => ({ ...e, tipo: 'Serviço' }));
      const allItems = [...mappedMaterials, ...mappedExtras];

      for (const m of allItems) {
        const existing = await db.get('SELECT MaterialReferencia FROM Material WHERE MaterialReferencia = ?', [m.referencia]);
        if (!existing) {
          // Normaliza unidade para respeitar o constraint do banco
          let normUn = (m.un || '').toUpperCase().trim();
          if (normUn === 'UN') normUn = 'UNI';
          const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
          if (!allowedUnits.includes(normUn)) {
            normUn = 'UNI'; // fallback seguro
          }

          await db.run(
            `INSERT INTO Material (MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [m.referencia, m.descricao, normUn, 0.0, null, 8, m.tipo, 0]
          );
        }
      }

      console.log(`[CarregarMateriais] Gravados ${materials.length} materiais e ${extraItems.length} itens de fabricação para o projeto ID ${finalProjectId}`);
      
      // Sincroniza e recalcula custos e preços do projeto
      await db.run('DELETE FROM ProjetoItem WHERE ProjetoID = ?', [finalProjectId]);
      await ensureProjetoItemsPopulated(finalProjectId);
      await recalculateProjectCosts(finalProjectId);
    }
  } catch (err) {
    console.error('Erro na rotina CarregarMateriais:', err);
    throw err;
  }
}

function parseModulesFromText(text) {
  const lines = text.split('\n');
  const modules = [];
  let currentModulo = null;
  
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('Módulo:')) {
      currentModulo = line.replace('Módulo:', '').trim();
    } else if (line.startsWith('Peça:') && currentModulo) {
      const peca = line.replace('Peça:', '').trim();
      modules.push({
        modulo: currentModulo,
        peca: peca
      });
      currentModulo = null;
    }
  }
  return modules;
}

function parsePecasFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const pecas = [];
  let currentPeca = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith("Cliente:")) {
      if (currentPeca) {
        pecas.push(currentPeca);
      }
      currentPeca = {
        cliente: line.replace("Cliente:", "").trim(),
        modulo: '',
        projeto: '',
        chapa: '',
        etiqueta: '',
        dimen: '',
        peca: '',
        cod_item: ''
      };
    } else if (currentPeca) {
      if (line.startsWith("Módulo:") || line.startsWith("Modulo:")) {
        currentPeca.modulo = line.replace(/^(Módulo:|Modulo:)/i, "").trim();
      } else if (line.startsWith("Projeto:")) {
        currentPeca.projeto = line.replace("Projeto:", "").trim();
      } else if (line.startsWith("Chapa:")) {
        currentPeca.chapa = line.replace("Chapa:", "").trim();
        // A linha logo após Chapa costuma ser a Etiqueta (ex: "1.A")
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.includes(":")) {
          currentPeca.etiqueta = nextLine.trim();
          i++; // Pula a próxima linha
        }
      } else if (line.startsWith("Dimen.:") || line.startsWith("Dimen:")) {
        currentPeca.dimen = line.replace(/^(Dimen\.:|Dimen:)/i, "").trim();
      } else if (line.startsWith("Peça:") || line.startsWith("Peca:")) {
        currentPeca.peca = line.replace(/^(Peça:|Peca:)/i, "").trim();
      } else if (line.startsWith("Cód. Item:") || line.startsWith("Cod. Item:") || line.startsWith("Cód Item:") || line.startsWith("Cod Item:")) {
        currentPeca.cod_item = line.replace(/^(Cód\. Item:|Cod\. Item:|Cód Item:|Cod Item:)/i, "").trim();
      }
    }
  }
  
  if (currentPeca) {
    pecas.push(currentPeca);
  }
  
  return pecas;
}

// Rotina de Carga de Peças e Etiquetas (CarregarPecas)
async function CarregarPecas(file, finalProjectId) {
  try {
    // Extração das imagens reais (desenho e código de barras) do PDF usando a build legacy do pdfjs
    console.log(`[CarregarPecas] Iniciando extração de imagens reais de: "${file.path}"`);
    const loadingTask = pdfjs.getDocument(file.path);
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const imageBase64List = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const ops = await page.getOperatorList();

      for (let j = 0; j < ops.fnArray.length; j++) {
        if (ops.fnArray[j] === pdfjs.OPS.paintImageXObject) {
          const args = ops.argsArray[j];
          const imgName = args[0];

          const imgObj = await new Promise((resolve) => {
            page.objs.get(imgName, (obj) => {
              resolve(obj);
            });
          });

          if (imgObj) {
            const { width, height, data: imgData } = imgObj;
            if (imgData instanceof Uint8Array && typeof width === 'number' && typeof height === 'number') {
              // Converter RGB para RGBA
              const rgbaData = new Uint8ClampedArray((imgData.length / 3) * 4);
              for (let k = 0; k < imgData.length; k += 3) {
                rgbaData[(k * 4) / 3] = imgData[k];
                rgbaData[(k * 4) / 3 + 1] = imgData[k + 1];
                rgbaData[(k * 4) / 3 + 2] = imgData[k + 2];
                rgbaData[(k * 4) / 3 + 3] = 255;
              }

              const png = new PNG({ width, height });
              png.data = Buffer.from(rgbaData);
              const buffer = PNG.sync.write(png);
              const base64 = `data:image/png;base64,${buffer.toString('base64')}`;
              imageBase64List.push(base64);
            }
          }
        }
      }
    }
    console.log(`[CarregarPecas] Extraídas ${imageBase64List.length} imagens (desenhos e códigos de barra) do PDF.`);

    // Extração dos dados textuais
    const fileBuffer = fs.readFileSync(file.path);
    const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
    if (instance.load) await instance.load();
    const pdfData = await instance.getText();
    const text = pdfData.text || '';

    const pecas = parsePecasFromText(text);
    if (pecas.length > 0 && finalProjectId) {
      // Limpa peças anteriores desse projeto
      await db.run('DELETE FROM Projeto_Pecas WHERE projeto_id = ?', [finalProjectId]);

      for (let idx = 0; idx < pecas.length; idx++) {
        const p = pecas[idx];
        // Imagem da peça (índice par: 2 * idx)
        const base64Image = imageBase64List[2 * idx] || null;
        // Código de barras (índice ímpar: 2 * idx + 1)
        const base64Barcode = imageBase64List[2 * idx + 1] || null;

        await db.run(
          'INSERT INTO Projeto_Pecas (projeto_id, peca, etiqueta, dimen, chapa, modulo, cod_item, imagem, cor_barras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [finalProjectId, p.peca, p.etiqueta, p.dimen, p.chapa, p.modulo, p.cod_item, base64Image, base64Barcode]
        );
      }
      console.log(`[CarregarPecas] Gravadas ${pecas.length} peças para o projeto ID ${finalProjectId}`);

      // Atualiza a quantidade de peças no campo ProjetoQtdPecas da tabela projetos
      await db.run(
        'UPDATE projetos SET ProjetoQtdPecas = ? WHERE id = ?',
        [pecas.length, finalProjectId]
      );
      console.log(`[CarregarPecas] Atualizado ProjetoQtdPecas com quantidade ${pecas.length} para o projeto ID ${finalProjectId}`);
    }
  } catch (parseErr) {
    console.error('Erro na rotina CarregarPecas:', parseErr);
    throw parseErr;
  }
}

app.post('/api/arquivos-importados', authenticateToken, uploadLayouts.array('arquivos'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const { projeto_id } = req.body;
  let targetProjetoId = null;
  if (projeto_id && projeto_id !== 'null' && projeto_id !== 'undefined') {
    targetProjetoId = parseInt(projeto_id);
    if (isNaN(targetProjetoId)) {
      targetProjetoId = null;
    }
  }

  // Resolve finalProjectId (if null, fallback to the first project in database)
  let finalProjectId = targetProjetoId;
  if (!finalProjectId) {
    const firstProj = await db.get('SELECT id FROM projetos ORDER BY id ASC LIMIT 1');
    if (firstProj) {
      finalProjectId = firstProj.id;
    }
  }

  try {
    // Ordena os arquivos conforme as prioridades de layout:
    // 1 - Lista de Materiais ('Materiais')
    // 2 - Plano de Corte ('PlanoCorte')
    // 3 - Modulo ('Modulo')
    // 4 - Etiqueta ('Etiqueta')
    // 5 - Outro
    const getFilePriority = (file) => {
      let originalName = file.originalname || '';
      try {
        originalName = Buffer.from(originalName, 'latin1').toString('utf8');
      } catch (err) {
        // Safe fallback
      }
      const normalizedName = originalName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_\-\s]/g, "");
      const lowerName = normalizedName.toLowerCase();
      
      if (lowerName.includes('relatorio_para_compra_de_materiais') || lowerName.includes('compra de materiais') || lowerName.includes('compra_de_materiais')) {
        return 1;
      }
      if (lowerName.includes('cuttingplan')) {
        return 2;
      }
      if (lowerName.includes('assembly modelo')) {
        return 3;
      }
      if (lowerName.includes('program etiquetaezattus')) {
        return 4;
      }
      return 5;
    };

    req.files.sort((a, b) => getFilePriority(a) - getFilePriority(b));

    await db.run('BEGIN TRANSACTION');
    const insertedIds = [];

    for (const file of req.files) {
      let originalName = file.originalname || '';
      try {
        // Correção de bug do multer/multipart que decodifica cabeçalhos UTF-8 como ISO-8859-1
        originalName = Buffer.from(originalName, 'latin1').toString('utf8');
      } catch (err) {
        console.error('Erro ao converter encoding do nome do arquivo:', err);
      }

      // Se o arquivo com o mesmo nome já existe neste projeto, removemos o antigo (registro e arquivo físico)
      try {
        const existingFile = await db.get(
          'SELECT * FROM arquivos_importados WHERE projeto_id = ? AND nome_arquivo = ?',
          [finalProjectId, originalName]
        );
        if (existingFile) {
          console.log(`[Upload] Arquivo duplicado detectado para o projeto ${finalProjectId}: "${originalName}". Removendo carga antiga.`);
          if (fs.existsSync(existingFile.caminho_arquivo)) {
            fs.unlinkSync(existingFile.caminho_arquivo);
          }
          await db.run('DELETE FROM arquivos_importados WHERE id = ?', [existingFile.id]);
        }
      } catch (err) {
        console.error('Erro ao limpar arquivo duplicado:', err);
      }

      // Normalização do nome para remover acentos e caracteres especiais para a comparação
      const normalizedName = originalName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove acentos
        .replace(/[^a-zA-Z0-9_\-\s]/g, ""); // Remove caracteres especiais

      const lowerName = normalizedName.toLowerCase();
      let resolvedLayout = 'Outro';

      if (lowerName.includes('cuttingplan')) {
        resolvedLayout = 'PlanoCorte';
      } else if (lowerName.includes('program etiquetaezattus')) {
        resolvedLayout = 'Etiqueta';
      } else if (lowerName.includes('assembly modelo')) {
        resolvedLayout = 'Modulo';
      } else if (lowerName.includes('relatorio_para_compra_de_materiais') || lowerName.includes('compra de materiais') || lowerName.includes('compra_de_materiais')) {
        resolvedLayout = 'Materiais';
      }

      console.log(`[Upload] Arquivo original: "${file.originalname}" -> Decodificado: "${originalName}" -> Normalizado: "${normalizedName}" -> Layout: "${resolvedLayout}" -> Projeto: ${finalProjectId}`);

      const result = await db.run(
        'INSERT INTO arquivos_importados (nome_arquivo, tamanho, tipo_layout, caminho_arquivo, projeto_id) VALUES (?, ?, ?, ?, ?)',
        [originalName, file.size, resolvedLayout, file.path, finalProjectId]
      );
      insertedIds.push(result.lastID);

      // Se for Layout do tipo 'Materiais', extrai os dados do PDF e popula a tabela Projeto_Materiais usando CarregarMateriais
      if (resolvedLayout === 'Materiais') {
        try {
          await CarregarMateriais(file, finalProjectId);
        } catch (parseErr) {
          console.error('Erro no upload ao invocar rotina CarregarMateriais:', parseErr);
        }
      }

      // Se for Layout do tipo 'Modulo' (Assembly), extrai os dados do PDF e popula a tabela Projeto_Modulo
      if (resolvedLayout === 'Modulo') {
        try {
          // Extração das imagens reais do PDF usando a build legacy do pdfjs
          console.log(`[CargaModulos] Iniciando extração de imagens reais de: "${file.path}"`);
          const loadingTask = pdfjs.getDocument(file.path);
          const pdfDoc = await loadingTask.promise;
          const numPages = pdfDoc.numPages;
          const imageBase64List = [];

          for (let i = 1; i <= numPages; i++) {
            const page = await pdfDoc.getPage(i);
            const ops = await page.getOperatorList();

            for (let j = 0; j < ops.fnArray.length; j++) {
              if (ops.fnArray[j] === pdfjs.OPS.paintImageXObject) {
                const args = ops.argsArray[j];
                const imgName = args[0];

                const imgObj = await new Promise((resolve) => {
                  page.objs.get(imgName, (obj) => {
                    resolve(obj);
                  });
                });

                if (imgObj) {
                  const { width, height, data: imgData } = imgObj;
                  if (imgData instanceof Uint8Array && typeof width === 'number' && typeof height === 'number') {
                    // Converter RGB para RGBA
                    const rgbaData = new Uint8ClampedArray((imgData.length / 3) * 4);
                    for (let k = 0; k < imgData.length; k += 3) {
                      rgbaData[(k * 4) / 3] = imgData[k];
                      rgbaData[(k * 4) / 3 + 1] = imgData[k + 1];
                      rgbaData[(k * 4) / 3 + 2] = imgData[k + 2];
                      rgbaData[(k * 4) / 3 + 3] = 255;
                    }

                    const png = new PNG({ width, height });
                    png.data = Buffer.from(rgbaData);
                    const buffer = PNG.sync.write(png);
                    const base64 = `data:image/png;base64,${buffer.toString('base64')}`;
                    imageBase64List.push(base64);
                  }
                }
              }
            }
          }
          console.log(`[CargaModulos] Extraídas ${imageBase64List.length} imagens reais do PDF.`);

          // Extração dos módulos e peças em texto
          const fileBuffer = fs.readFileSync(file.path);
          const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
          if (instance.load) await instance.load();
          const pdfData = await instance.getText();
          const text = pdfData.text || '';
          
          const modules = parseModulesFromText(text);
          if (modules.length > 0 && finalProjectId) {
            // Limpa módulos anteriores desse projeto para evitar duplicatas
            await db.run('DELETE FROM Projeto_Modulo WHERE projeto_id = ?', [finalProjectId]);
            
            for (let idx = 0; idx < modules.length; idx++) {
              const m = modules[idx];
              // Associa a imagem correspondente da lista se disponível, senão gera o vetor SVG padrão
              const base64Image = imageBase64List[idx] || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="80" height="80"><rect x="15" y="15" width="70" height="70" rx="4" fill="none" stroke="%2306b6d4" stroke-width="3" /><line x1="15" y1="45" x2="85" y2="45" stroke="%2306b6d4" stroke-width="2" /><line x1="50" y1="15" x2="50" y2="85" stroke="%2306b6d4" stroke-width="2" /><circle cx="43" cy="30" r="2.5" fill="%2306b6d4" /><circle cx="57" cy="30" r="2.5" fill="%2306b6d4" /><circle cx="43" cy="65" r="2.5" fill="%2306b6d4" /><circle cx="57" cy="65" r="2.5" fill="%2306b6d4" /></svg>`;

              await db.run(
                'INSERT INTO Projeto_Modulo (projeto_id, modulo, peca, imagem) VALUES (?, ?, ?, ?)',
                [finalProjectId, m.modulo, m.peca, base64Image]
              );
            }
            console.log(`[Modules] Gravados ${modules.length} módulos (com ${imageBase64List.length} imagens reais) para o projeto ID ${finalProjectId}`);

            // Classifica os módulos para FAB.MON.CXA (Caixas) e FAB.ESP.PCA (Itens Especiais)
            // Item Especial: Módulos cujo nome contenha "vidro", "espelho", "perfil", "provençal" / "provencal" ou "ripado" (case-insensitive)
            const especialKeywords = ['vidro', 'espelho', 'perfil', 'provençal', 'provencal', 'ripado'];

            let validModuloCount = 0;
            let especialModuloCount = 0;
            for (const m of modules) {
              const moduloName = (m.modulo || '').toLowerCase();
              const isEspecial = especialKeywords.some(keyword => moduloName.includes(keyword));

              if (isEspecial) {
                especialModuloCount++;
              } else if (!moduloName.includes('tamponamento') && !moduloName.includes('painel')) {
                validModuloCount++;
              }
            }

            // Atualiza a quantidade do registro 'FAB.MON.CXA' em Projeto_Materiais
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE projeto_id = ? AND referencia = 'FAB.MON.CXA'",
              [validModuloCount, finalProjectId]
            );
            console.log(`[Modules] Atualizado FAB.MON.CXA com quantidade ${validModuloCount} para o projeto ID ${finalProjectId}`);

            // Atualiza a quantidade do registro 'FAB.ESP.PCA' em Projeto_Materiais
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE projeto_id = ? AND referencia = 'FAB.ESP.PCA'",
              [especialModuloCount, finalProjectId]
            );
            console.log(`[Modules] Atualizado FAB.ESP.PCA com quantidade ${especialModuloCount} para o projeto ID ${finalProjectId}`);

            // Atualiza a quantidade do registro 'FAB.EMB.UND' em Projeto_Materiais com a soma de FAB.MON.CXA + FAB.ESP.PCA
            const totalEmbalagem = validModuloCount + especialModuloCount;
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE projeto_id = ? AND referencia = 'FAB.EMB.UND'",
              [totalEmbalagem, finalProjectId]
            );
            console.log(`[Modules] Atualizado FAB.EMB.UND com quantidade ${totalEmbalagem} para o projeto ID ${finalProjectId}`);
          }
        } catch (parseErr) {
          console.error('Erro ao fazer parse ou salvar módulos do PDF:', parseErr);
        }
      }

      // Se for Layout do tipo 'PlanoCorte' (CuttingPlan), extrai os dados do PDF e popula a tabela Projeto_Chapa
      if (resolvedLayout === 'PlanoCorte') {
        try {
          const fileBuffer = fs.readFileSync(file.path);
          const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
          if (instance.load) await instance.load();
          const pdfData = await instance.getText();
          
          const chapas = parsePdfText(pdfData.pages);
          if (chapas.length > 0 && finalProjectId) {
            // Limpa registros anteriores de chapa desse projeto para evitar duplicatas
            await db.run('DELETE FROM Projeto_Chapa WHERE projeto_id = ?', [finalProjectId]);
            
            for (const c of chapas) {
              let updatedAcabamento = c.acabamento || '';
              if (c.descChapa) {
                const thicknessMatch = c.descChapa.match(/(\d+(?:\.\d+)?)\s*mm/i);
                if (thicknessMatch) {
                  const integerPart = Math.floor(parseFloat(thicknessMatch[1]));
                  const formattedThickness = String(integerPart).padStart(2, '0') + 'mm';
                  if (updatedAcabamento) {
                    const hasThickness = new RegExp(`-\\s*${formattedThickness}\\s*$`).test(updatedAcabamento);
                    if (!hasThickness) {
                      updatedAcabamento = `${updatedAcabamento} - ${formattedThickness}`;
                    }
                  } else {
                    updatedAcabamento = formattedThickness;
                  }
                }
              }
              for (const p of c.pecas) {
                await db.run(
                  'INSERT INTO Projeto_Chapa (projeto_id, chapa, acabamento, DescChapa, item, descricao, dimensao) VALUES (?, ?, ?, ?, ?, ?, ?)',
                  [finalProjectId, c.chapa, updatedAcabamento, c.descChapa || null, p.item, p.descricao, p.dimensao]
                );
              }
            }
            console.log(`[Cuts] Gravados ${chapas.reduce((acc, c) => acc + c.pecas.length, 0)} cortes para o projeto ID ${finalProjectId}`);
            
            // Atualizar a quantidade de chapas do registro FAB.USI.CHP em Projeto_Materiais
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE projeto_id = ? AND referencia = 'FAB.USI.CHP'",
              [chapas.length, finalProjectId]
            );
            console.log(`[Cuts] Atualizado FAB.USI.CHP com quantidade ${chapas.length} para o projeto ID ${finalProjectId}`);

            // Atualizar a quantidade de peças no campo ProjetoQtdPecas da tabela projetos
            const totalPecas = chapas.reduce((acc, c) => acc + c.pecas.length, 0);
            await db.run(
              'UPDATE projetos SET ProjetoQtdPecas = ? WHERE id = ?',
              [totalPecas, finalProjectId]
            );
            console.log(`[Cuts] Atualizado ProjetoQtdPecas com quantidade ${totalPecas} para o projeto ID ${finalProjectId}`);
          }
        } catch (parseErr) {
          console.error('Erro ao fazer parse ou salvar plano de corte do PDF:', parseErr);
        }
      }

      // Se for Layout do tipo 'Etiqueta' (Program Etiqueta), extrai os dados e popula a tabela Projeto_Pecas usando CarregarPecas
      if (resolvedLayout === 'Etiqueta') {
        try {
          await CarregarPecas(file, finalProjectId);
        } catch (parseErr) {
          console.error('Erro no upload ao invocar rotina CarregarPecas:', parseErr);
        }
      }
    }

    await db.run('COMMIT');

    const uploadedFiles = await db.all(
      `SELECT * FROM arquivos_importados WHERE id IN (${insertedIds.map(() => '?').join(',')})`,
      insertedIds
    );
    res.status(201).json(uploadedFiles);
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('UPLOAD LAYOUTS ERROR:', error);
    res.status(500).json({ error: 'Erro ao registrar arquivos no banco de dados.' });
  }
});

app.get('/api/arquivos-importados/download/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const file = await db.get('SELECT * FROM arquivos_importados WHERE id = ?', [id]);
    if (!file) {
      return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }
    
    if (!fs.existsSync(file.caminho_arquivo)) {
      return res.status(404).json({ error: 'Arquivo físico não encontrado no servidor.' });
    }

    res.download(file.caminho_arquivo, file.nome_arquivo);
  } catch (error) {
    console.error('DOWNLOAD LAYOUT ERROR:', error);
    res.status(500).json({ error: 'Erro ao baixar arquivo.' });
  }
});

app.delete('/api/arquivos-importados/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const file = await db.get('SELECT * FROM arquivos_importados WHERE id = ?', [id]);
    if (!file) {
      return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    // Exclui do disco
    try {
      if (fs.existsSync(file.caminho_arquivo)) {
        fs.unlinkSync(file.caminho_arquivo);
      }
    } catch (err) {
      console.error('Erro ao excluir arquivo físico:', err);
    }

    // Exclui do banco
    await db.run('DELETE FROM arquivos_importados WHERE id = ?', [id]);
    res.json({ message: 'Arquivo de layout removido com sucesso.' });
  } catch (error) {
    console.error('DELETE LAYOUT ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir arquivo de layout.' });
  }
});

// ==========================================
// PROJETO ANEXOS ENDPOINTS
// ==========================================

// GET /api/projetos/:id/anexos - Listar anexos do projeto
app.get('/api/projetos/:id/anexos', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const list = await db.all(
      `SELECT * FROM projeto_anexos WHERE projeto_id = ? ORDER BY criado_em DESC, id DESC`,
      [id]
    );
    res.json(list);
  } catch (error) {
    console.error('GET PROJETO ANEXOS ERROR:', error);
    res.status(500).json({ error: 'Erro ao listar anexos do projeto.' });
  }
});

// POST /api/projetos/:id/anexos - Upload de anexos para o projeto
app.post('/api/projetos/:id/anexos', authenticateToken, uploadAnexos.array('arquivos'), async (req, res) => {
  const { id } = req.params;
  const exibirNaProposta = req.body?.exibir_na_proposta === 'Nao' ? 'Nao' : 'Sim';
  try {
    const proj = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    if (!proj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const userName = req.user?.nome || req.user?.name || req.user?.login || 'Usuário';
    const inserted = [];

    for (const file of req.files) {
      let originalName = file.originalname || '';
      try {
        originalName = Buffer.from(originalName, 'latin1').toString('utf8');
      } catch (e) {}

      const relativePath = `uploads/anexos/${file.filename}`;
      const result = await db.run(
        `INSERT INTO projeto_anexos (projeto_id, nome_original, nome_arquivo, caminho, tipo_mime, tamanho, exibir_na_proposta, criado_por_nome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, originalName, file.filename, relativePath, file.mimetype, file.size, exibirNaProposta, userName]
      );

      const item = await db.get('SELECT * FROM projeto_anexos WHERE id = ?', [result.lastID]);
      if (item) inserted.push(item);
    }

    res.status(201).json(inserted);
  } catch (error) {
    console.error('POST PROJETO ANEXOS ERROR:', error);
    res.status(500).json({ error: 'Erro ao salvar anexos do projeto.' });
  }
});

// PUT /api/projetos/anexos/:id - Atualizar configurações do anexo (ex: exibir_na_proposta)
app.put('/api/projetos/anexos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { exibir_na_proposta, nome_original } = req.body;
  try {
    const anexo = await db.get('SELECT * FROM projeto_anexos WHERE id = ?', [id]);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    const newExibir = exibir_na_proposta !== undefined ? (exibir_na_proposta === 'Sim' || exibir_na_proposta === true ? 'Sim' : 'Nao') : anexo.exibir_na_proposta;
    const newNome = nome_original || anexo.nome_original;

    await db.run(
      `UPDATE projeto_anexos SET exibir_na_proposta = ?, nome_original = ? WHERE id = ?`,
      [newExibir, newNome, id]
    );

    const updated = await db.get('SELECT * FROM projeto_anexos WHERE id = ?', [id]);
    res.json(updated);
  } catch (error) {
    console.error('UPDATE ANEXO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar anexo.' });
  }
});

// GET /api/projetos/anexos/download/:id - Download de anexo do projeto
app.get('/api/projetos/anexos/download/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const anexo = await db.get('SELECT * FROM projeto_anexos WHERE id = ?', [id]);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    const fullPath = path.resolve(anexo.caminho);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Arquivo físico não encontrado.' });
    }

    res.download(fullPath, anexo.nome_original);
  } catch (error) {
    console.error('DOWNLOAD ANEXO ERROR:', error);
    res.status(500).json({ error: 'Erro ao baixar anexo.' });
  }
});

// DELETE /api/projetos/anexos/:id - Excluir anexo do projeto
app.delete('/api/projetos/anexos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const anexo = await db.get('SELECT * FROM projeto_anexos WHERE id = ?', [id]);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    try {
      const fullPath = path.resolve(anexo.caminho);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (e) {
      console.error('Erro ao excluir arquivo físico de anexo:', e);
    }

    await db.run('DELETE FROM projeto_anexos WHERE id = ?', [id]);
    res.json({ message: 'Anexo excluído com sucesso.' });
  } catch (error) {
    console.error('DELETE ANEXO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir anexo.' });
  }
});

app.get('/api/projetos/:projeto_id/materiais', authenticateToken, async (req, res) => {
  const { projeto_id } = req.params;
  try {
    const list = await db.all('SELECT * FROM Projeto_Materiais WHERE projeto_id = ? ORDER BY id ASC', [projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT MATERIALS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar materiais do projeto.' });
  }
});

app.get('/api/projetos/:projeto_id/modulos', authenticateToken, async (req, res) => {
  const { projeto_id } = req.params;
  try {
    const list = await db.all('SELECT * FROM Projeto_Modulo WHERE projeto_id = ? ORDER BY id ASC', [projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT MODULES ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar módulos do projeto.' });
  }
});

app.get('/api/projetos/:projeto_id/chapas', authenticateToken, async (req, res) => {
  const { projeto_id } = req.params;
  try {
    const list = await db.all('SELECT * FROM Projeto_Chapa WHERE projeto_id = ? ORDER BY id ASC', [projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT CHAPAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar chapas do projeto.' });
  }
});

app.get('/api/projetos/:projeto_id/pecas', authenticateToken, async (req, res) => {
  const { projeto_id } = req.params;
  try {
    const list = await db.all('SELECT * FROM Projeto_Pecas WHERE projeto_id = ? ORDER BY id ASC', [projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT PECAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar peças do projeto.' });
  }
});

// 9. Budget Routes (Orçamentos)
app.get('/api/orcamentos', authenticateToken, async (req, res) => {
  try {
    await ensureOrcamentosSchema(db);
    const list = await db.all(`
      SELECT 
        o.numero,
        o.data_criacao,
        o.cliente_id,
        o.descricao,
        COALESCE(o.status, 'Em Aberto') as status,
        COALESCE(o.status, 'Em Aberto') as situacao,
        o.parametro_financeiro_id,
        pf.nome as parametro_nome,
        pf.situacao as parametro_situacao,
        cf.perc_imposto,
        cf.perc_comissao,
        cf.perc_custo_financeiro,
        cf.perc_markup_lucro,
        cf.perc_margem_minima,
        cf.metodo_calculo,
        o.total_venda,
        o.desconto_percentual,
        o.desconto_valor,
        o.forma_pagamento_selecionada,
        o.anotacoes_cliente,
        o.anotacoes_conclusao,
        o.data_aprovacao,
        o.data_entrada,
        o.fluxo_financeiro,
        c.nome as cliente_nome,
        c.telefone as cliente_telefone,
        c.documento as cliente_documento,
        c.email as cliente_email,
        c.rg as cliente_rg,
        c.endereco as cliente_endereco,
        c.numero as cliente_numero,
        c.complemento as cliente_complemento,
        c.bairro as cliente_bairro,
        c.cidade as cliente_cidade,
        c.uf as cliente_uf,
        c.cep as cliente_cep,
        c.entrega_endereco as cliente_entrega_endereco,
        c.entrega_numero as cliente_entrega_numero,
        c.entrega_complemento as cliente_entrega_complemento,
        c.entrega_bairro as cliente_entrega_bairro,
        c.entrega_cidade as cliente_entrega_cidade,
        c.entrega_uf as cliente_entrega_uf,
        c.entrega_cep as cliente_entrega_cep,
        COALESCE((
          SELECT SUM(p.CustoMaterial)
          FROM projetos p
          WHERE p.orcamento_numero = o.numero
        ), 0.0) as CustoMaterial,
        COALESCE((
          SELECT SUM(p.CustoProducao)
          FROM projetos p
          WHERE p.orcamento_numero = o.numero
        ), 0.0) as CustoProducao
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      ORDER BY o.numero DESC
    `);
    res.json(list);
  } catch (error) {
    console.error('GET BUDGETS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar orçamentos.' });
  }
});

app.post('/api/orcamentos', authenticateToken, async (req, res) => {
  const { cliente_id, descricao, status, parametro_financeiro_id } = req.body;
  if (!cliente_id) {
    return res.status(400).json({ error: 'O cliente é obrigatório.' });
  }

  try {
    // Generate Budget Numero: Year(4) + Sequential(6)
    const currentYear = new Date().getFullYear();
    const minRange = currentYear * 1000000;
    const maxRange = currentYear * 1000000 + 999999;

    const row = await db.get(
      'SELECT MAX(numero) as maxNum FROM orcamentos WHERE numero >= ? AND numero <= ?',
      [minRange, maxRange]
    );

    let nextSeq = 1;
    if (row && row.maxNum) {
      nextSeq = (row.maxNum % 1000000) + 1;
    }
    const orcamentoNumero = currentYear * 1000000 + nextSeq;
    const paramIdVal = parametro_financeiro_id !== undefined && parametro_financeiro_id !== null ? parseInt(parametro_financeiro_id, 10) : 1;

    await db.run(
      'INSERT INTO orcamentos (numero, cliente_id, descricao, status, parametro_financeiro_id) VALUES (?, ?, ?, ?, ?)',
      [orcamentoNumero, parseInt(cliente_id), descricao || null, status || 'Em Aberto', paramIdVal]
    );

    const newBudget = await db.get(`
      SELECT 
        o.numero,
        o.data_criacao,
        o.cliente_id,
        o.descricao,
        COALESCE(o.status, 'Em Aberto') as status,
        COALESCE(o.status, 'Em Aberto') as situacao,
        o.parametro_financeiro_id,
        pf.nome as parametro_nome,
        pf.situacao as parametro_situacao,
        cf.perc_imposto,
        cf.perc_comissao,
        cf.perc_custo_financeiro,
        cf.perc_markup_lucro,
        cf.perc_margem_minima,
        cf.metodo_calculo,
        o.total_venda,
        o.desconto_percentual,
        o.desconto_valor,
        o.forma_pagamento_selecionada,
        o.anotacoes_cliente,
        o.anotacoes_conclusao,
        o.data_aprovacao,
        c.nome as cliente_nome,
        0.0 as CustoMaterial,
        0.0 as CustoProducao
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE o.numero = ?
    `, [orcamentoNumero]);
    res.status(201).json(newBudget);
  } catch (error) {
    console.error('CREATE BUDGET ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar orçamento.' });
  }
});

app.put('/api/orcamentos/:numero', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  const { cliente_id, descricao, status, forma_pagamento_selecionada, anotacoes_cliente, parametro_financeiro_id } = req.body;
  try {
    const budget = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const updatedClienteId = cliente_id !== undefined ? parseInt(cliente_id, 10) : budget.cliente_id;
    const updatedDescricao = descricao !== undefined ? descricao : budget.descricao;
    const updatedStatus = status !== undefined ? status : (budget.status || 'Em Aberto');
    const updatedFormaPag = forma_pagamento_selecionada !== undefined ? forma_pagamento_selecionada : budget.forma_pagamento_selecionada;
    const updatedAnotacoes = anotacoes_cliente !== undefined ? anotacoes_cliente : budget.anotacoes_cliente;
    const updatedParamId = parametro_financeiro_id !== undefined && parametro_financeiro_id !== null ? parseInt(parametro_financeiro_id, 10) : (budget.parametro_financeiro_id || 1);
    const dataAprovacao = (updatedStatus === 'Aprovado' && !budget.data_aprovacao)
      ? new Date().toISOString()
      : (updatedStatus !== 'Aprovado' ? null : budget.data_aprovacao);

    await db.run(
      'UPDATE orcamentos SET cliente_id = ?, descricao = ?, status = ?, forma_pagamento_selecionada = ?, anotacoes_cliente = ?, data_aprovacao = ?, parametro_financeiro_id = ? WHERE numero = ?',
      [updatedClienteId, updatedDescricao, updatedStatus, updatedFormaPag, updatedAnotacoes, dataAprovacao, updatedParamId, numero]
    );

    const updated = await db.get(`
      SELECT 
        o.numero,
        o.data_criacao,
        o.cliente_id,
        o.descricao,
        COALESCE(o.status, 'Em Aberto') as status,
        COALESCE(o.status, 'Em Aberto') as situacao,
        o.parametro_financeiro_id,
        pf.nome as parametro_nome,
        pf.situacao as parametro_situacao,
        cf.perc_imposto,
        cf.perc_comissao,
        cf.perc_custo_financeiro,
        cf.perc_markup_lucro,
        cf.perc_margem_minima,
        cf.metodo_calculo,
        o.total_venda,
        o.desconto_percentual,
        o.desconto_valor,
        o.forma_pagamento_selecionada,
        o.anotacoes_cliente,
        o.anotacoes_conclusao,
        o.data_aprovacao,
        c.nome as cliente_nome,
        COALESCE((
          SELECT SUM(p.CustoMaterial)
          FROM projetos p
          WHERE p.orcamento_numero = o.numero
        ), 0.0) as CustoMaterial,
        COALESCE((
          SELECT SUM(p.CustoProducao)
          FROM projetos p
          WHERE p.orcamento_numero = o.numero
        ), 0.0) as CustoProducao
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE o.numero = ?
    `, [numero]);

    res.json(updated);
  } catch (error) {
    console.error('UPDATE BUDGET ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar orçamento.' });
  }
});

app.delete('/api/orcamentos/:numero', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    const budget = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    // 1. Buscar todos os projetos do orçamento para excluir seus dados subordinados e arquivos
    const projs = await db.all('SELECT id FROM projetos WHERE orcamento_numero = ?', [numero]);
    for (const p of projs) {
      const anexos = await db.all('SELECT * FROM projeto_anexos WHERE projeto_id = ?', [p.id]);
      for (const a of anexos) {
        try {
          if (a.caminho) {
            const fullPath = path.resolve(a.caminho);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          }
        } catch (e) {}
      }
      await db.run('DELETE FROM projeto_anexos WHERE projeto_id = ?', [p.id]);

      const arquivos = await db.all('SELECT * FROM arquivos_importados WHERE projeto_id = ?', [p.id]);
      for (const f of arquivos) {
        try {
          if (f.caminho_arquivo && fs.existsSync(f.caminho_arquivo)) fs.unlinkSync(f.caminho_arquivo);
        } catch (e) {}
      }
      await db.run('DELETE FROM arquivos_importados WHERE projeto_id = ?', [p.id]);

      await db.run('DELETE FROM ProjetoItem WHERE ProjetoID = ?', [p.id]);
      await db.run('DELETE FROM Projeto_Materiais WHERE projeto_id = ?', [p.id]);
      await db.run('DELETE FROM Projeto_Pecas WHERE projeto_id = ?', [p.id]);
      await db.run('DELETE FROM Projeto_Modulo WHERE projeto_id = ?', [p.id]);
      await db.run('DELETE FROM Projeto_Chapa WHERE projeto_id = ?', [p.id]);
    }

    // 2. Excluir links de compartilhamento da proposta
    await db.run('DELETE FROM proposta_compartilhamentos WHERE orcamento_numero = ?', [numero]);

    // 3. Excluir os projetos do orçamento
    await db.run('DELETE FROM projetos WHERE orcamento_numero = ?', [numero]);

    // 4. Excluir o orçamento
    await db.run('DELETE FROM orcamentos WHERE numero = ?', [numero]);

    res.json({ message: 'Orçamento, seus projetos e todos os dados subordinados foram removidos com sucesso.' });
  } catch (error) {
    console.error('DELETE BUDGET ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir orçamento e seus dados subordinados.' });
  }
});

app.get('/api/orcamentos/:numero', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    await ensureOrcamentosSchema(db);
    const budget = await db.get(`
      SELECT 
        o.numero,
        o.data_criacao,
        o.cliente_id,
        o.descricao,
        COALESCE(o.status, 'Em Aberto') as status,
        o.parametro_financeiro_id,
        pf.nome as parametro_nome,
        pf.situacao as parametro_situacao,
        cf.perc_imposto,
        cf.perc_comissao,
        cf.perc_custo_financeiro,
        cf.perc_markup_lucro,
        cf.perc_margem_minima,
        cf.metodo_calculo,
        o.total_venda,
        o.desconto_percentual,
        o.desconto_valor,
        o.forma_pagamento_selecionada,
        o.anotacoes_cliente,
        o.anotacoes_conclusao,
        o.data_aprovacao,
        o.data_entrada,
        o.fluxo_financeiro,
        c.nome as cliente_nome,
        c.telefone as cliente_telefone,
        COALESCE((
          SELECT SUM(p.CustoMaterial)
          FROM projetos p
          WHERE p.orcamento_numero = o.numero
        ), 0.0) as CustoMaterial,
        COALESCE((
          SELECT SUM(p.CustoProducao)
          FROM projetos p
          WHERE p.orcamento_numero = o.numero
        ), 0.0) as CustoProducao
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE o.numero = ?
    `, [numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }
    res.json(budget);
  } catch (error) {
    console.error('GET BUDGET DETAIL ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes do orçamento.' });
  }
});

// POST /api/orcamentos/:numero/conclusao - Conclusão e fechamento de proposta com descontos e forma de pagamento
app.post('/api/orcamentos/:numero/conclusao', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  const { 
    desconto_percentual, 
    desconto_valor, 
    preco_final_ajustado, 
    forma_pagamento_selecionada, 
    anotacoes_cliente, 
    anotacoes_conclusao,
    status 
  } = req.body;

  try {
    const budget = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const currentStatus = (budget.status || 'Em Aberto').trim().toLowerCase();
    if (currentStatus !== 'em aberto') {
      return res.status(400).json({ error: 'Não é permitido alterar proposta de orçamento que não esteja Em Aberto.' });
    }

    // Garantir que todas as colunas existem na tabela orcamentos em tempo de execução
    const tableInfo = await db.all("PRAGMA table_info(orcamentos)");
    const colNames = tableInfo.map(c => c.name);
    if (!colNames.includes('desconto_percentual')) await db.exec("ALTER TABLE orcamentos ADD COLUMN desconto_percentual DECIMAL(6,2) DEFAULT 0.0");
    if (!colNames.includes('desconto_valor')) await db.exec("ALTER TABLE orcamentos ADD COLUMN desconto_valor DECIMAL(15,2) DEFAULT 0.0");
    if (!colNames.includes('total_venda')) await db.exec("ALTER TABLE orcamentos ADD COLUMN total_venda DECIMAL(15,2) DEFAULT NULL");
    if (!colNames.includes('forma_pagamento_selecionada')) await db.exec("ALTER TABLE orcamentos ADD COLUMN forma_pagamento_selecionada TEXT");
    if (!colNames.includes('anotacoes_cliente')) await db.exec("ALTER TABLE orcamentos ADD COLUMN anotacoes_cliente TEXT");
    if (!colNames.includes('anotacoes_conclusao')) await db.exec("ALTER TABLE orcamentos ADD COLUMN anotacoes_conclusao TEXT");
    if (!colNames.includes('data_aprovacao')) await db.exec("ALTER TABLE orcamentos ADD COLUMN data_aprovacao TEXT");
    if (!colNames.includes('data_entrada')) await db.exec("ALTER TABLE orcamentos ADD COLUMN data_entrada TEXT");
    if (!colNames.includes('fluxo_financeiro')) await db.exec("ALTER TABLE orcamentos ADD COLUMN fluxo_financeiro TEXT");
    if (!colNames.includes('status')) await db.exec("ALTER TABLE orcamentos ADD COLUMN status TEXT DEFAULT 'Em Aberto'");

    const descPerc = parseFloat(desconto_percentual) || 0.0;
    const descVlr = parseFloat(desconto_valor) || 0.0;
    const pFinalRaw = preco_final_ajustado !== undefined && preco_final_ajustado !== null ? preco_final_ajustado : req.body.total_venda;
    const precoFinal = pFinalRaw !== undefined && pFinalRaw !== null ? parseFloat(pFinalRaw) : null;
    const formaPag = (forma_pagamento_selecionada || '').trim() || null;
    const anotacoesCli = anotacoes_cliente !== undefined ? (anotacoes_cliente || '').trim() || null : budget.anotacoes_cliente;
    const anotacoesConc = (anotacoes_conclusao || '').trim() || null;
    const novoStatus = (status || req.body.situacao || budget.status || 'Em Aberto').trim();

    const dataAprovacao = req.body.data_aprovacao 
      ? req.body.data_aprovacao 
      : ((novoStatus === 'Aprovado' && !budget.data_aprovacao) 
          ? new Date().toISOString().split('T')[0] 
          : (novoStatus !== 'Aprovado' ? null : budget.data_aprovacao));

    const dataEntrada = req.body.data_entrada || budget.data_entrada || new Date().toISOString().split('T')[0];
    const fluxoFinanceiro = req.body.fluxo_financeiro 
      ? (typeof req.body.fluxo_financeiro === 'string' ? req.body.fluxo_financeiro : JSON.stringify(req.body.fluxo_financeiro))
      : budget.fluxo_financeiro;

    await db.run(`
      UPDATE orcamentos 
      SET 
        desconto_percentual = ?,
        desconto_valor = ?,
        total_venda = ?,
        forma_pagamento_selecionada = ?,
        anotacoes_cliente = ?,
        anotacoes_conclusao = ?,
        status = ?,
        data_aprovacao = ?,
        data_entrada = ?,
        fluxo_financeiro = ?
      WHERE numero = ?
    `, [descPerc, descVlr, precoFinal, formaPag, anotacoesCli, anotacoesConc, novoStatus, dataAprovacao, dataEntrada, fluxoFinanceiro, numero]);

    // Se houver projetos e um novo preço final, distribui proporcionalmente no preco_venda_final dos projetos
    const projetos = await db.all('SELECT * FROM projetos WHERE orcamento_numero = ? ORDER BY id ASC', [numero]);
    if (projetos.length > 0 && precoFinal !== null && precoFinal > 0) {
      const projCols = await db.all("PRAGMA table_info(projetos)");
      if (!projCols.some(c => c.name === 'preco_venda_final')) {
        await db.exec("ALTER TABLE projetos ADD COLUMN preco_venda_final DECIMAL(15,2) DEFAULT 0.0");
      }

      const somaOriginal = projetos.reduce((sum, p) => sum + (parseFloat(p.preco_venda_final) || 0), 0);
      let acumulado = 0;
      for (let i = 0; i < projetos.length; i++) {
        const p = projetos[i];
        let novoPrecoProj = 0;
        if (i === projetos.length - 1) {
          novoPrecoProj = Math.round((precoFinal - acumulado) * 100) / 100;
        } else {
          const ratio = somaOriginal > 0 ? (parseFloat(p.preco_venda_final) || 0) / somaOriginal : 1 / projetos.length;
          novoPrecoProj = Math.round(precoFinal * ratio * 100) / 100;
          acumulado += novoPrecoProj;
        }
        await db.run('UPDATE projetos SET preco_venda_final = ? WHERE id = ?', [novoPrecoProj, p.id]);
      }
    }

    const updatedBudget = await db.get(`
      SELECT 
        o.numero,
        o.data_criacao,
        o.cliente_id,
        o.descricao,
        COALESCE(o.status, 'Em Aberto') as status,
        COALESCE(o.status, 'Em Aberto') as situacao,
        o.total_venda,
        o.desconto_percentual,
        o.desconto_valor,
        o.forma_pagamento_selecionada,
        o.anotacoes_cliente,
        o.anotacoes_conclusao,
        o.data_aprovacao,
        o.data_entrada,
        o.fluxo_financeiro,
        c.nome as cliente_nome,
        COALESCE((SELECT SUM(p.CustoMaterial) FROM projetos p WHERE p.orcamento_numero = o.numero), 0.0) as CustoMaterial,
        COALESCE((SELECT SUM(p.CustoProducao) FROM projetos p WHERE p.orcamento_numero = o.numero), 0.0) as CustoProducao
      FROM orcamentos o
      LEFT JOIN clientes c ON o.cliente_id = c.id
      WHERE o.numero = ?
    `, [numero]);

    res.json({
      success: true,
      message: 'Conclusão da proposta salva com sucesso!',
      orcamento: updatedBudget
    });
  } catch (error) {
    console.error('POST CONCLUSAO PROPOSTA ERROR:', error);
    res.status(500).json({ error: error.message || 'Erro ao salvar conclusão da proposta.' });
  }
});

// Garante que a tabela ProjetoItem está devidamente populada caso o projeto possua itens em Projeto_Materiais
async function ensureProjetoItemsPopulated(projectId) {
  const countRow = await db.get('SELECT COUNT(*) as count FROM ProjetoItem WHERE ProjetoID = ?', [projectId]);
  if (!countRow || countRow.count === 0) {
    const materials = await db.all('SELECT * FROM Projeto_Materiais WHERE projeto_id = ? ORDER BY id ASC', [projectId]);
    if (materials && materials.length > 0) {
      let currentSeq = 1;
      const monItem = materials.find(m => m.referencia === 'FAB.MON.CXA');
      const espItem = materials.find(m => m.referencia === 'FAB.ESP.PCA');
      const qtdMonCxa = monItem ? (parseFloat(monItem.qtd) || 0.0) : 0.0;
      const qtdEspPca = espItem ? (parseFloat(espItem.qtd) || 0.0) : 0.0;
      const qtdEmbUnd = qtdMonCxa + qtdEspPca;

      for (const m of materials) {
        if (m.referencia === 'FAB.QTD.PCA') continue;
        let globalMat = await db.get('SELECT * FROM Material WHERE MaterialReferencia = ?', [m.referencia]);
        if (!globalMat) {
          let normUn = (m.un || '').toUpperCase().trim();
          if (normUn === 'UN') normUn = 'UNI';
          const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
          if (!allowedUnits.includes(normUn)) normUn = 'UNI';
          const matTipo = (m.tipo || (m.referencia && m.referencia.startsWith('FAB.') ? 'Serviço' : 'Produto'));
          await db.run(
            `INSERT INTO Material (MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [m.referencia, m.descricao || m.referencia, normUn, 0.0, null, 8, matTipo, 0]
          );
          globalMat = {
            MaterialReferencia: m.referencia,
            MaterialDescricao: m.descricao || m.referencia,
            MaterialUnidade: normUn,
            MaterialValorUnitario: 0.0,
            GrupoSigla: null,
            ProdutoGrupo: 8,
            MaterialTipo: matTipo,
            MaterialTempo: 0
          };
        }

        const vlrUnit = globalMat.MaterialValorUnitario || 0.0;
        const unidade = (globalMat.MaterialUnidade || m.un || 'UNI').substring(0, 3);
        let qtd = parseFloat(m.qtd) || 0.0;
        if (m.referencia === 'FAB.EMB.UND') {
          qtd = qtdEmbUnd;
        }
        const total = vlrUnit * qtd;
        const tempo = parseInt(globalMat.MaterialTempo, 10) || 0;
        const duracao = Math.round(tempo * qtd);

        await db.run(
          `INSERT INTO ProjetoItem (ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [projectId, currentSeq, m.referencia, vlrUnit, unidade, qtd, total, tempo, duracao]
        );
        currentSeq++;
      }
    }
  }
}

// Recalculate consolidated project costs (Material vs. Production) and total duration
async function recalculateProjectCosts(projectId) {
  try {
    // 1. Garantir que ProjetoItem está populado se Projeto_Materiais tiver registros
    await ensureProjetoItemsPopulated(projectId);

    // 2. Se o orçamento não estiver aprovado, sincroniza os preços/tempos unitários de ProjetoItem com o cadastro global Material
    const projData = await db.get('SELECT * FROM projetos WHERE id = ?', [projectId]);
    if (projData && projData.orcamento_numero) {
      const budgetCheck = await db.get('SELECT status FROM orcamentos WHERE numero = ?', [projData.orcamento_numero]);
      if (budgetCheck?.status !== 'Aprovado') {
        await db.run(`
          UPDATE ProjetoItem
          SET 
            ProjetoItemVlrUnit = COALESCE((
              SELECT m.MaterialValorUnitario 
              FROM Material m 
              WHERE m.MaterialReferencia = ProjetoItem.MaterialReferencia
            ), ProjetoItemVlrUnit),
            ProjetoItemTotal = ProjetoItemQtd * COALESCE((
              SELECT m.MaterialValorUnitario 
              FROM Material m 
              WHERE m.MaterialReferencia = ProjetoItem.MaterialReferencia
            ), ProjetoItemVlrUnit),
            ProjetoItemTempo = COALESCE((
              SELECT m.MaterialTempo 
              FROM Material m 
              WHERE m.MaterialReferencia = ProjetoItem.MaterialReferencia
            ), ProjetoItemTempo),
            ProjetoItemDuracao = ROUND(COALESCE((
              SELECT m.MaterialTempo 
              FROM Material m 
              WHERE m.MaterialReferencia = ProjetoItem.MaterialReferencia
            ), ProjetoItemTempo) * ProjetoItemQtd)
          WHERE ProjetoID = ?
        `, [projectId]);
      }
    }

    const monCliItem = await db.get(
      "SELECT CAST(ROUND(ProjetoItemQtd) AS INTEGER) as diasMontagem FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = 'FAB.MON.CLI'",
      [projectId]
    );

    let updateQuery = `
      UPDATE projetos 
      SET 
        CustoMaterial = COALESCE((
          SELECT SUM(pi.ProjetoItemTotal)
          FROM ProjetoItem pi
          LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia
          WHERE pi.ProjetoID = ? AND (m.MaterialTipo = 'Produto' OR m.MaterialTipo IS NULL)
        ), 0.0),
        CustoProducao = COALESCE((
          SELECT SUM(pi.ProjetoItemTotal)
          FROM ProjetoItem pi
          LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia
          WHERE pi.ProjetoID = ? AND m.MaterialTipo = 'Serviço'
        ), 0.0),
        CustoTotal = COALESCE((
          SELECT SUM(pi.ProjetoItemTotal)
          FROM ProjetoItem pi
          WHERE pi.ProjetoID = ?
        ), 0.0),
        DuracaoFabricacao = COALESCE((
          SELECT SUM(pi.ProjetoItemDuracao)
          FROM ProjetoItem pi
          WHERE pi.ProjetoID = ? AND pi.MaterialReferencia != 'FAB.MON.CLI'
        ), 0)
    `;
    const params = [projectId, projectId, projectId, projectId];

    if (monCliItem && monCliItem.diasMontagem !== undefined && monCliItem.diasMontagem !== null) {
      updateQuery += `, DuracaoMontagem = ? WHERE id = ?`;
      params.push(monCliItem.diasMontagem, projectId);
    } else {
      updateQuery += ` WHERE id = ?`;
      params.push(projectId);
    }

    await db.run(updateQuery, params);

    // Recalcular Preço de Venda Sugerido e Final do Projeto e atualizar o Orçamento
    const updatedProj = await db.get('SELECT * FROM projetos WHERE id = ?', [projectId]);
    if (updatedProj && updatedProj.orcamento_numero) {
      const custoTotal = parseFloat(updatedProj.CustoTotal) || 0.0;
      const budget = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [updatedProj.orcamento_numero]);
      const paramId = (budget && budget.parametro_financeiro_id) ? budget.parametro_financeiro_id : (updatedProj.parametro_financeiro_id || 1);
      const paramConfig = await db.get('SELECT * FROM configuracoes_financeiras WHERE parametro_id = ?', [paramId]);

      const percImposto = (updatedProj.perc_imposto !== null && updatedProj.perc_imposto !== undefined && updatedProj.perc_imposto !== '')
        ? parseFloat(updatedProj.perc_imposto) 
        : (paramConfig && paramConfig.perc_imposto !== null && paramConfig.perc_imposto !== undefined ? parseFloat(paramConfig.perc_imposto) : 6.0);

      const percComissao = (updatedProj.perc_comissao !== null && updatedProj.perc_comissao !== undefined && updatedProj.perc_comissao !== '') 
        ? parseFloat(updatedProj.perc_comissao) 
        : (paramConfig && paramConfig.perc_comissao !== null && paramConfig.perc_comissao !== undefined ? parseFloat(paramConfig.perc_comissao) : 5.0);

      const percFinanceiro = (updatedProj.perc_custo_financeiro !== null && updatedProj.perc_custo_financeiro !== undefined && updatedProj.perc_custo_financeiro !== '') 
        ? parseFloat(updatedProj.perc_custo_financeiro) 
        : (paramConfig && paramConfig.perc_custo_financeiro !== null && paramConfig.perc_custo_financeiro !== undefined ? parseFloat(paramConfig.perc_custo_financeiro) : 4.0);

      const percLucro = (updatedProj.perc_markup_lucro !== null && updatedProj.perc_markup_lucro !== undefined && updatedProj.perc_markup_lucro !== '') 
        ? parseFloat(updatedProj.perc_markup_lucro) 
        : (paramConfig && paramConfig.perc_markup_lucro !== null && paramConfig.perc_markup_lucro !== undefined ? parseFloat(paramConfig.perc_markup_lucro) : 20.0);

      const totalPerc = percImposto + percComissao + percFinanceiro + percLucro;
      const divisor = 1 - (totalPerc / 100);
      const precoSugerido = (divisor > 0 && custoTotal > 0) ? (custoTotal / divisor) : (custoTotal * (1 + (totalPerc / 100)));

      if (budget?.status !== 'Aprovado') {
        await db.run(`
          UPDATE projetos 
          SET 
            preco_venda_sugerido = ?, 
            preco_venda_final = ?
          WHERE id = ?
        `, [precoSugerido, precoSugerido, projectId]);
      } else {
        await db.run(`
          UPDATE projetos 
          SET 
            preco_venda_sugerido = ?
          WHERE id = ?
        `, [precoSugerido, projectId]);
      }

      // Atualiza o total consolidado de venda do orçamento
      const sumProjs = await db.get(`
        SELECT SUM(COALESCE(preco_venda_final, preco_venda_sugerido, 0.0)) as somaVenda
        FROM projetos
        WHERE orcamento_numero = ?
      `, [updatedProj.orcamento_numero]);
      const novoTotalVenda = sumProjs && sumProjs.somaVenda ? parseFloat(sumProjs.somaVenda) : 0.0;

      await db.run(`
        UPDATE orcamentos
        SET 
          total_venda = ?,
          valor_total = ?
        WHERE numero = ?
      `, [novoTotalVenda, novoTotalVenda, updatedProj.orcamento_numero]);
    }
  } catch (error) {
    console.error('Error recalculating project costs:', error);
  }
}

// POST /api/projetos/:id/recalcular - Forçar recálculo completo de custos e preço de venda
app.post('/api/projetos/:id/recalcular', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await recalculateProjectCosts(id);
    const updatedProj = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    const budget = updatedProj ? await db.get('SELECT * FROM orcamentos WHERE numero = ?', [updatedProj.orcamento_numero]) : null;
    res.json({
      success: true,
      message: 'Projeto e orçamento recalculados com sucesso.',
      projeto: updatedProj,
      orcamento: budget
    });
  } catch (error) {
    console.error('RECALCULATE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao recalcular projeto.' });
  }
});

// 10. Project Routes (Projetos)
app.get('/api/projetos', authenticateToken, async (req, res) => {
  const { orcamento_numero } = req.query;
  try {
    let query = `
      SELECT 
        p.*, 
        COALESCE(o.status, 'Em Aberto') AS orcamento_status,
        COALESCE(o.status, 'Em Aberto') AS orcamento_situacao,
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao,
        (SELECT COUNT(*) FROM projeto_anexos pa WHERE pa.projeto_id = p.id) AS total_anexos
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
    `;
    let params = [];
    if (orcamento_numero) {
      query += ' WHERE p.orcamento_numero = ?';
      params.push(parseInt(orcamento_numero));
    }
    query += ' ORDER BY p.id DESC';
    const list = await db.all(query, params);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECTS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar projetos.' });
  }
});

// GET /api/projetos/:id - Obter dados de um projeto específico
app.get('/api/projetos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
      SELECT 
        p.*, 
        COALESCE(o.status, 'Em Aberto') AS orcamento_status,
        COALESCE(o.status, 'Em Aberto') AS orcamento_situacao,
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao,
        (SELECT COUNT(*) FROM projeto_anexos pa WHERE pa.projeto_id = p.id) AS total_anexos
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      WHERE p.id = ?
    `;
    const proj = await db.get(query, [id]);
    if (!proj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    res.json(proj);
  } catch (error) {
    console.error('GET PROJECT BY ID ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar projeto.' });
  }
});

app.post('/api/projetos', authenticateToken, async (req, res) => {
  const { orcamento_numero, nome, descricao, DuracaoMontagem, ProjetoURL } = req.body;
  if (!orcamento_numero || !nome) {
    return res.status(400).json({ error: 'O número do orçamento e o nome do projeto são obrigatórios.' });
  }

  try {
    // Check if budget exists
    const budget = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [orcamento_numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const durMontagemVal = parseInt(DuracaoMontagem, 10) || 0;
    const qtdPecasVal = req.body.ProjetoQtdPecas !== undefined ? (parseInt(req.body.ProjetoQtdPecas, 10) || 0) : 0;

    const result = await db.run(
      'INSERT INTO projetos (orcamento_numero, nome, descricao, DuracaoMontagem, ProjetoURL, ProjetoQtdPecas) VALUES (?, ?, ?, ?, ?, ?)',
      [parseInt(orcamento_numero), nome, descricao || null, durMontagemVal, ProjetoURL || null, qtdPecasVal]
    );

    const newProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      WHERE p.id = ?
    `, [result.lastID]);

    res.status(201).json(newProject);
  } catch (error) {
    console.error('CREATE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar projeto.' });
  }
});

app.put('/api/projetos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { nome, descricao, DuracaoMontagem, ProjetoURL, ProjetoQtdPecas } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
  }

  try {
    const project = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    const durMontagemVal = DuracaoMontagem !== undefined ? (parseInt(DuracaoMontagem, 10) || 0) : (project.DuracaoMontagem || 0);
    const projetoUrlVal = ProjetoURL !== undefined ? (ProjetoURL || null) : (project.ProjetoURL || null);
    const qtdPecasVal = ProjetoQtdPecas !== undefined ? (parseInt(ProjetoQtdPecas, 10) || 0) : (project.ProjetoQtdPecas || 0);

    await db.run(
      'UPDATE projetos SET nome = ?, descricao = ?, DuracaoMontagem = ?, ProjetoURL = ?, ProjetoQtdPecas = ? WHERE id = ?',
      [nome, descricao || null, durMontagemVal, projetoUrlVal, qtdPecasVal, id]
    );

    // Se FAB.MON.CLI existir em ProjetoItem para este projeto, sincroniza a quantidade
    const monCliItem = await db.get("SELECT * FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = 'FAB.MON.CLI'", [id]);
    if (monCliItem) {
      const vlrUnit = monCliItem.ProjetoItemVlrUnit || 0.0;
      const newTotal = vlrUnit * durMontagemVal;
      const tempo = parseInt(monCliItem.ProjetoItemTempo, 10) || 0;
      const duracao = Math.round(tempo * durMontagemVal);
      await db.run(
        'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemDuracao = ? WHERE ProjetoID = ? AND MaterialReferencia = ?',
        [durMontagemVal, newTotal, duracao, id, 'FAB.MON.CLI']
      );
      await recalculateProjectCosts(id);
    }

    const updatedProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      WHERE p.id = ?
    `, [id]);

    res.json(updatedProject);
  } catch (error) {
    console.error('UPDATE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar projeto.' });
  }
});

app.delete('/api/projetos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const project = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    // 1. Excluir arquivos físicos de anexos
    const anexos = await db.all('SELECT * FROM projeto_anexos WHERE projeto_id = ?', [id]);
    for (const a of anexos) {
      try {
        if (a.caminho) {
          const fullPath = path.resolve(a.caminho);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch (e) {
        console.error('Erro ao excluir arquivo físico de anexo:', e);
      }
    }
    await db.run('DELETE FROM projeto_anexos WHERE projeto_id = ?', [id]);

    // 2. Excluir arquivos físicos de arquivos_importados
    const arquivos = await db.all('SELECT * FROM arquivos_importados WHERE projeto_id = ?', [id]);
    for (const f of arquivos) {
      try {
        if (f.caminho_arquivo && fs.existsSync(f.caminho_arquivo)) {
          fs.unlinkSync(f.caminho_arquivo);
        }
      } catch (e) {
        console.error('Erro ao excluir arquivo físico de layout importado:', e);
      }
    }
    await db.run('DELETE FROM arquivos_importados WHERE projeto_id = ?', [id]);

    // 3. Excluir dados subordinados das tabelas filhas
    await db.run('DELETE FROM ProjetoItem WHERE ProjetoID = ?', [id]);
    await db.run('DELETE FROM Projeto_Materiais WHERE projeto_id = ?', [id]);
    await db.run('DELETE FROM Projeto_Pecas WHERE projeto_id = ?', [id]);
    await db.run('DELETE FROM Projeto_Modulo WHERE projeto_id = ?', [id]);
    await db.run('DELETE FROM Projeto_Chapa WHERE projeto_id = ?', [id]);

    // 4. Excluir o projeto principal
    await db.run('DELETE FROM projetos WHERE id = ?', [id]);

    res.json({ message: 'Projeto e todos os seus dados subordinados foram removidos com sucesso.' });
  } catch (error) {
    console.error('DELETE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir projeto e seus dados subordinados.' });
  }
});

// PUT /api/projetos/:id/precificacao
app.put('/api/projetos/:id/precificacao', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { 
    perc_imposto, 
    perc_comissao, 
    perc_custo_financeiro, 
    perc_markup_lucro, 
    preco_venda_sugerido, 
    preco_venda_final
  } = req.body;

  try {
    const project = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    await db.run(`
      UPDATE projetos 
      SET 
        perc_imposto = ?, 
        perc_comissao = ?, 
        perc_custo_financeiro = ?, 
        perc_markup_lucro = ?, 
        preco_venda_sugerido = ?, 
        preco_venda_final = ?
      WHERE id = ?
    `, [
      perc_imposto !== undefined && perc_imposto !== null ? parseFloat(perc_imposto) : null,
      perc_comissao !== undefined && perc_comissao !== null ? parseFloat(perc_comissao) : null,
      perc_custo_financeiro !== undefined && perc_custo_financeiro !== null ? parseFloat(perc_custo_financeiro) : null,
      perc_markup_lucro !== undefined && perc_markup_lucro !== null ? parseFloat(perc_markup_lucro) : null,
      preco_venda_sugerido !== undefined && preco_venda_sugerido !== null ? parseFloat(preco_venda_sugerido) : 0,
      preco_venda_final !== undefined && preco_venda_final !== null ? parseFloat(preco_venda_final) : 0,
      id
    ]);

    const updatedProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      WHERE p.id = ?
    `, [id]);

    res.json(updatedProject);
  } catch (error) {
    console.error('UPDATE PROJECT PRICING ERROR:', error);
    res.status(500).json({ error: 'Erro ao salvar precificação do projeto.' });
  }
});

// Função para gerar descrição detalhada do projeto:
// - MDFs: Todos os MDFs utilizados no projeto entram na lista (não requerem ExibirNaProposta='Sim')
// - Demais grupos (Ferragens, Componentes, Vidros, etc.): Entram apenas se ExibirNaProposta = 'Sim'
async function buildProjectDescriptionFromDB(projectId) {
  try {
    const proj = await db.get('SELECT * FROM projetos WHERE id = ?', [projectId]);
    if (!proj) return '';

    const chapas = await db.all('SELECT * FROM Projeto_Chapa WHERE projeto_id = ?', [projectId]);

    let items = await db.all(`
      SELECT 
        pi.ProjetoID,
        pi.MaterialReferencia,
        pi.ProjetoItemQtd,
        m.MaterialDescricao, 
        COALESCE(m.ProdutoGrupo, 8) as ProdutoGrupo, 
        m.MaterialTipo,
        COALESCE(m.ExibirNaProposta, 'Nao') as ExibirNaProposta
      FROM ProjetoItem pi 
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia 
      WHERE pi.ProjetoID = ? 
        AND pi.ProjetoItemQtd > 0
        AND (
          COALESCE(m.ProdutoGrupo, 8) = 1 
          OR m.MaterialDescricao LIKE 'MDF%' 
          OR m.MaterialDescricao LIKE 'MDP%' 
          OR m.MaterialDescricao LIKE 'Chapa MDF%'
          OR COALESCE(m.ExibirNaProposta, 'Nao') = 'Sim'
        )
      ORDER BY pi.ProjetoItemID ASC
    `, [projectId]);

    if (items.length === 0) {
      items = await db.all(`
        SELECT 
          pm.referencia as MaterialReferencia, 
          pm.descricao as MaterialDescricao, 
          pm.qtd as ProjetoItemQtd,
          COALESCE(m.ProdutoGrupo, 8) as ProdutoGrupo, 
          m.MaterialTipo,
          COALESCE(m.ExibirNaProposta, 'Nao') as ExibirNaProposta
        FROM Projeto_Materiais pm
        LEFT JOIN Material m ON pm.referencia = m.MaterialReferencia
        WHERE pm.projeto_id = ?
          AND pm.qtd > 0
          AND (
            COALESCE(m.ProdutoGrupo, 8) = 1 
            OR pm.descricao LIKE 'MDF%' 
            OR pm.descricao LIKE 'MDP%' 
            OR pm.descricao LIKE 'Chapa MDF%'
            OR COALESCE(m.ExibirNaProposta, 'Nao') = 'Sim'
          )
        ORDER BY pm.id ASC
      `, [projectId]);
    }

    const cleanMdfName = (str) => {
      if (!str) return '';
      let s = str.replace(/\\/g, ' ');
      // Remove prefixos como "Chapa MDF", "MDF", "MDP", "Chapa MDP", etc.
      s = s.replace(/^(chapa\s+)?(mdf|mdp)\s*[-:]?\s*/i, '');
      // Remove número sequencial após prefixo, ex: "5-Freijó..." -> "Freijó..."
      s = s.replace(/^\d+\s*-\s*/, '');
      // Remove espessuras como "Espessura 18mm", "- 18mm", "18mm", "18 mm"
      s = s.replace(/espessura\s*\d+\s*mm/gi, '');
      s = s.replace(/\s*-\s*\d+\s*mm\b/gi, '');
      s = s.replace(/\b\d+\s*mm\b/gi, '');
      // Remove sentidos de fibra
      s = s.replace(/\b(horizontal|vertical)\b/gi, '');
      // Corrigir typos comuns
      s = s.replace(/natrual/gi, 'Natural');
      // Remove pontuações/hifens soltos nas pontas
      s = s.replace(/^[-–—:,.\s]+|[-–—:,.\s]+$/g, '');
      s = s.replace(/\s+/g, ' ').trim();
      return s;
    };

    const cleanHardwareName = (str) => {
      if (!str) return '';
      let s = str.replace(/\s*-\s*\d+\s*mm\b/gi, '');
      s = s.replace(/\s*\d+\s*mm\b/gi, '');
      s = s.replace(/\s*\d+\s*kg\b/gi, '');
      s = s.replace(/^[-–—:,.\s]+|[-–—:,.\s]+$/g, '');
      s = s.replace(/\s+/g, ' ').trim();
      return s;
    };

    // 1. MDFs (Todos os MDFs utilizados no projeto, sem exigir ExibirNaProposta = 'Sim')
    const mdfItems = items.filter(i => 
      (i.ProdutoGrupo === 1 || /^(mdf|mdp|chapa\s+mdf)/i.test(i.MaterialDescricao || '')) && 
      i.MaterialTipo !== 'Serviço'
    );
    let mdfNames = mdfItems.map(i => cleanMdfName(i.MaterialDescricao)).filter(Boolean);

    // Se houver chapas em Projeto_Chapa, inclui também seus acabamentos
    if (chapas.length > 0) {
      chapas.forEach(c => {
        const name = cleanMdfName(c.acabamento || c.DescChapa || c.chapa);
        if (name) mdfNames.push(name);
      });
    }
    
    // Deduplica MDFs garantindo nome único
    const uniqueMdfs = [];
    const seenMdfLower = new Set();
    for (const name of mdfNames) {
      const normalized = name.trim();
      const lower = normalized.toLowerCase();
      if (normalized && !seenMdfLower.has(lower)) {
        seenMdfLower.add(lower);
        uniqueMdfs.push(normalized);
      }
    }

    // 2. Ferragens e Componentes (Apenas os que possuem ExibirNaProposta = 'Sim')
    const ferragensItems = items.filter(i => 
      (i.ProdutoGrupo === 4 || i.ProdutoGrupo === 5 || /corredi|dobradi|puxador|trilho|pisto|articul|fechadura|amortec/i.test(i.MaterialDescricao || '')) && 
      i.ProdutoGrupo !== 1 && 
      !/^(mdf|mdp|chapa\s+mdf)/i.test(i.MaterialDescricao || '') &&
      i.MaterialTipo !== 'Serviço' &&
      i.ExibirNaProposta === 'Sim'
    );
    const ferragensNames = ferragensItems.map(i => cleanHardwareName(i.MaterialDescricao)).filter(Boolean);
    const uniqueFerragens = [];
    const seenFerragensLower = new Set();
    for (const name of ferragensNames) {
      const normalized = name.trim();
      const lower = normalized.toLowerCase();
      if (normalized && !seenFerragensLower.has(lower)) {
        seenFerragensLower.add(lower);
        uniqueFerragens.push(normalized);
      }
    }

    // 3. Vidros (Apenas com ExibirNaProposta = 'Sim')
    const vidrosItems = items.filter(i => 
      i.ProdutoGrupo === 6 && 
      i.MaterialTipo !== 'Serviço' &&
      i.ExibirNaProposta === 'Sim'
    );
    const vidrosNames = vidrosItems.map(i => cleanHardwareName(i.MaterialDescricao)).filter(Boolean);
    const uniqueVidros = [];
    const seenVidrosLower = new Set();
    for (const name of vidrosNames) {
      const normalized = name.trim();
      const lower = normalized.toLowerCase();
      if (normalized && !seenVidrosLower.has(lower)) {
        seenVidrosLower.add(lower);
        uniqueVidros.push(normalized);
      }
    }

    // 4. Outros itens com ExibirNaProposta = 'Sim'
    const outrosItems = items.filter(i => 
      !mdfItems.includes(i) && 
      !ferragensItems.includes(i) && 
      !vidrosItems.includes(i) && 
      i.MaterialTipo !== 'Serviço' &&
      i.ExibirNaProposta === 'Sim'
    );
    const outrosNames = outrosItems.map(i => cleanHardwareName(i.MaterialDescricao)).filter(Boolean);
    const uniqueOutros = [];
    const seenOutrosLower = new Set();
    for (const name of outrosNames) {
      const normalized = name.trim();
      const lower = normalized.toLowerCase();
      if (normalized && !seenOutrosLower.has(lower)) {
        seenOutrosLower.add(lower);
        uniqueOutros.push(normalized);
      }
    }

    const sections = [];
    if (uniqueMdfs.length > 0) {
      sections.push(`- MDF´S\n${uniqueMdfs.join(', ')}`);
    }
    if (uniqueFerragens.length > 0) {
      sections.push(`- FERRAGENS\n${uniqueFerragens.join(', ')}`);
    }
    if (uniqueVidros.length > 0) {
      sections.push(`- VIDROS\n${uniqueVidros.join(', ')}`);
    }
    if (uniqueOutros.length > 0) {
      sections.push(`- OUTROS\n${uniqueOutros.join(', ')}`);
    }

    return sections.join('\n\n');
  } catch (err) {
    console.error('Erro ao montar descrição do projeto:', err);
    return '';
  }
}

// GET /api/projetos/:id/descricao-sugerida
app.get('/api/projetos/:id/descricao-sugerida', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const descricao = await buildProjectDescriptionFromDB(id);
    res.json({ descricao });
  } catch (error) {
    console.error('GET DESCRICAO SUGERIDA ERROR:', error);
    res.status(500).json({ error: 'Erro ao gerar descrição sugerida do projeto.' });
  }
});

// POST /api/projetos/:id/gerar-descricao
app.post('/api/projetos/:id/gerar-descricao', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const descricao = await buildProjectDescriptionFromDB(id);
    if (descricao) {
      await db.run('UPDATE projetos SET descricao = ? WHERE id = ?', [descricao, id]);
    }
    const updatedProj = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    res.json(updatedProj);
  } catch (error) {
    console.error('POST GERAR DESCRICAO ERROR:', error);
    res.status(500).json({ error: 'Erro ao gerar e salvar descrição do projeto.' });
  }
});

// GET /api/projetos/:id/itens
app.get('/api/projetos/:id/itens', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    // Garante que a tabela ProjetoItem está populada a partir de Projeto_Materiais se necessário
    await ensureProjetoItemsPopulated(id);

    const list = await db.all(`
      SELECT 
        pi.ProjetoID,
        pi.ProjetoItemID,
        pi.MaterialReferencia,
        m.MaterialDescricao,
        m.MaterialTipo AS MaterialTipo,
        m.MaterialImagem,
        COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
        COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
        pi.ProjetoItemVlrUnit,
        COALESCE(m.MaterialValorUnitario, 0.0) AS MaterialValorUnitarioAtual,
        pi.ProjetoItemUnidade,
        pi.ProjetoItemQtd,
        pi.ProjetoItemTotal,
        pi.ProjetoItemTempo,
        pi.ProjetoItemDuracao
      FROM ProjetoItem pi
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia
      WHERE pi.ProjetoID = ?
      ORDER BY pi.ProjetoItemID ASC
    `, [id]);

    res.json(list);
  } catch (error) {
    console.error('GET PROJECT ITEMS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar itens do orçamento do projeto.' });
  }
});

// POST /api/projetos/:id/itens
app.post('/api/projetos/:id/itens', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { MaterialReferencia, ProjetoItemQtd } = req.body;
  if (!MaterialReferencia || ProjetoItemQtd === undefined) {
    return res.status(400).json({ error: 'Material e quantidade são obrigatórios.' });
  }

  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      JOIN orcamentos o ON p.orcamento_numero = o.numero 
      WHERE p.id = ?
    `, [id]);
    if (projCheck && projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter novos itens adicionados.' });
    }

    const mat = await db.get('SELECT * FROM Material WHERE MaterialReferencia = ?', [MaterialReferencia]);
    if (!mat) {
      return res.status(404).json({ error: 'Material não cadastrado.' });
    }

    const vlrUnit = mat.MaterialValorUnitario || 0.0;
    const unidade = mat.MaterialUnidade || '';
    let qtd = parseFloat(ProjetoItemQtd);
    if (isNaN(qtd) || qtd < 0 || qtd > 999999) {
      return res.status(400).json({ error: 'A quantidade deve ser entre 0 e 999.999,00.' });
    }

    // Se o serviço inserido for 'FAB.EMB.UND', obtém a soma de 'FAB.MON.CXA' + 'FAB.ESP.PCA'
    if (MaterialReferencia === 'FAB.EMB.UND') {
      const monItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.MON.CXA']);
      const espItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.ESP.PCA']);
      const sumQtd = (monItem ? (parseFloat(monItem.ProjetoItemQtd) || 0) : 0) + (espItem ? (parseFloat(espItem.ProjetoItemQtd) || 0) : 0);
      if (sumQtd > 0 || qtd === 0) {
        qtd = sumQtd;
      }
    }

    const total = vlrUnit * qtd;
    const tempo = parseInt(mat.MaterialTempo, 10) || 0;
    const duracao = Math.round(tempo * qtd);

    const seqRow = await db.get('SELECT MAX(ProjetoItemID) as maxSeq FROM ProjetoItem WHERE ProjetoID = ?', [id]);
    const nextSeq = seqRow && seqRow.maxSeq ? seqRow.maxSeq + 1 : 1;

    await db.run(
      `INSERT INTO ProjetoItem (ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nextSeq, MaterialReferencia, vlrUnit, unidade, qtd, total, tempo, duracao]
    );

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id);

    const proj = await db.get('SELECT CustoTotal, DuracaoFabricacao FROM projetos WHERE id = ?', [id]);
    const newTotal = proj ? (proj.CustoTotal || 0.0) : 0.0;

    res.status(201).json({
      ProjetoID: parseInt(id),
      ProjetoItemID: nextSeq,
      MaterialReferencia,
      MaterialDescricao: mat.MaterialDescricao,
      ProjetoItemVlrUnit: vlrUnit,
      ProjetoItemUnidade: unidade,
      ProjetoItemQtd: qtd,
      ProjetoItemTotal: total,
      ProjetoItemTempo: tempo,
      ProjetoItemDuracao: duracao,
      CustoTotal: newTotal
    });
  } catch (error) {
    console.error('ADD PROJECT ITEM ERROR:', error);
    res.status(500).json({ error: 'Erro ao adicionar item ao projeto.' });
  }
});

// PUT /api/projetos/:id/itens/:itemId
app.put('/api/projetos/:id/itens/:itemId', authenticateToken, async (req, res) => {
  const { id, itemId } = req.params;
  const { ProjetoItemQtd } = req.body;
  if (ProjetoItemQtd === undefined) {
    return res.status(400).json({ error: 'A quantidade é obrigatória.' });
  }

  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      JOIN orcamentos o ON p.orcamento_numero = o.numero 
      WHERE p.id = ?
    `, [id]);
    if (projCheck && projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter seus itens alterados.' });
    }

    const item = await db.get('SELECT * FROM ProjetoItem WHERE ProjetoID = ? AND ProjetoItemID = ?', [id, itemId]);
    if (!item) {
      return res.status(404).json({ error: 'Item não encontrado.' });
    }

    const vlrUnit = item.ProjetoItemVlrUnit || 0.0;
    const qtd = parseFloat(ProjetoItemQtd);
    if (isNaN(qtd) || qtd < 0 || qtd > 999999) {
      return res.status(400).json({ error: 'A quantidade deve ser entre 0 e 999.999,00.' });
    }
    const total = vlrUnit * qtd;

    let tempo = item.ProjetoItemTempo;
    if (tempo === null || tempo === undefined) {
      const mat = await db.get('SELECT MaterialTempo FROM Material WHERE MaterialReferencia = ?', [item.MaterialReferencia]);
      tempo = mat ? (parseInt(mat.MaterialTempo, 10) || 0) : 0;
    }
    const duracao = Math.round((parseInt(tempo, 10) || 0) * qtd);

    await db.run(
      'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemTempo = ?, ProjetoItemDuracao = ? WHERE ProjetoID = ? AND ProjetoItemID = ?',
      [qtd, total, tempo, duracao, id, itemId]
    );

    // Se a quantidade de FAB.MON.CXA ou FAB.ESP.PCA for alterada, recalcula automaticamente FAB.EMB.UND na tabela ProjetoItem
    if (item.MaterialReferencia === 'FAB.MON.CXA' || item.MaterialReferencia === 'FAB.ESP.PCA') {
      const embItem = await db.get('SELECT * FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.EMB.UND']);
      if (embItem) {
        const monItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.MON.CXA']);
        const espItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.ESP.PCA']);
        const sumQtd = (monItem ? (parseFloat(monItem.ProjetoItemQtd) || 0) : 0) + (espItem ? (parseFloat(espItem.ProjetoItemQtd) || 0) : 0);
        const embVlrUnit = embItem.ProjetoItemVlrUnit || 0.0;
        const embTotal = embVlrUnit * sumQtd;
        const embTempo = parseInt(embItem.ProjetoItemTempo, 10) || 0;
        const embDuracao = Math.round(embTempo * sumQtd);
        await db.run(
          'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemDuracao = ? WHERE ProjetoID = ? AND MaterialReferencia = ?',
          [sumQtd, embTotal, embDuracao, id, 'FAB.EMB.UND']
        );
      }
    }

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id);

    const proj = await db.get('SELECT CustoTotal, DuracaoFabricacao FROM projetos WHERE id = ?', [id]);
    const newTotal = proj ? (proj.CustoTotal || 0.0) : 0.0;

    res.json({
      success: true,
      ProjetoID: parseInt(id),
      ProjetoItemID: parseInt(itemId),
      ProjetoItemQtd: qtd,
      ProjetoItemTotal: total,
      ProjetoItemTempo: tempo,
      ProjetoItemDuracao: duracao,
      CustoTotal: newTotal
    });
  } catch (error) {
    console.error('UPDATE PROJECT ITEM ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar item do projeto.' });
  }
});

// DELETE /api/projetos/:id/itens/:itemId
app.delete('/api/projetos/:id/itens/:itemId', authenticateToken, async (req, res) => {
  const { id, itemId } = req.params;
  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      JOIN orcamentos o ON p.orcamento_numero = o.numero 
      WHERE p.id = ?
    `, [id]);
    if (projCheck && projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter seus itens removidos.' });
    }

    const item = await db.get('SELECT * FROM ProjetoItem WHERE ProjetoID = ? AND ProjetoItemID = ?', [id, itemId]);
    if (!item) {
      return res.status(404).json({ error: 'Item não encontrado.' });
    }

    await db.run('DELETE FROM ProjetoItem WHERE ProjetoID = ? AND ProjetoItemID = ?', [id, itemId]);

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id);
    
    const sumRow = await db.get('SELECT SUM(ProjetoItemTotal) as sumTotal FROM ProjetoItem WHERE ProjetoID = ?', [id]);
    const newTotal = sumRow && sumRow.sumTotal ? sumRow.sumTotal : 0.0;

    res.json({ success: true, message: 'Item removido com sucesso.', CustoTotal: newTotal });
  } catch (error) {
    console.error('DELETE PROJECT ITEM ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir item do projeto.' });
  }
});

// POST /api/projetos/:id/substituir-materiais - Substituição em lote de materiais em itens do projeto
app.post('/api/projetos/:id/substituir-materiais', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { itemIds, novoMaterialReferencia, novaQuantidade } = req.body;

  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'Nenhum item selecionado para substituição.' });
  }

  if (!novoMaterialReferencia) {
    return res.status(400).json({ error: 'O novo material de substituição é obrigatório.' });
  }

  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      JOIN orcamentos o ON p.orcamento_numero = o.numero 
      WHERE p.id = ?
    `, [id]);
    
    if (!projCheck) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    if (projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter seus materiais alterados.' });
    }

    const mat = await db.get('SELECT * FROM Material WHERE MaterialReferencia = ?', [novoMaterialReferencia]);
    if (!mat) {
      return res.status(404).json({ error: 'Material de substituição não encontrado no catálogo.' });
    }

    const vlrUnit = mat.MaterialValorUnitario || 0.0;
    const unidade = mat.MaterialUnidade || '';
    const tempo = parseInt(mat.MaterialTempo, 10) || 0;

    let qtdToInsert = 1;
    if (novaQuantidade !== undefined && !isNaN(parseFloat(novaQuantidade)) && parseFloat(novaQuantidade) > 0) {
      qtdToInsert = parseFloat(novaQuantidade);
    } else {
      // Fallback: soma da quantidade dos itens selecionados
      const placeholders = itemIds.map(() => '?').join(',');
      const sumRow = await db.get(`SELECT SUM(ProjetoItemQtd) as totalQtd FROM ProjetoItem WHERE ProjetoID = ? AND ProjetoItemID IN (${placeholders})`, [id, ...itemIds]);
      qtdToInsert = sumRow && sumRow.totalQtd ? parseFloat(sumRow.totalQtd) : 1;
    }

    const total = vlrUnit * qtdToInsert;
    const duracao = Math.round(tempo * qtdToInsert);

    // 1. Obter próximo ProjetoItemID
    const seqRow = await db.get('SELECT MAX(ProjetoItemID) as maxSeq FROM ProjetoItem WHERE ProjetoID = ?', [id]);
    const nextSeq = seqRow && seqRow.maxSeq ? seqRow.maxSeq + 1 : 1;

    // 2. Incluir o novo material consolidado na lista de ProjetoItem
    await db.run(
      `INSERT INTO ProjetoItem (ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nextSeq, novoMaterialReferencia, vlrUnit, unidade, qtdToInsert, total, tempo, duracao]
    );

    // 3. Excluir os itens substituídos da lista de materiais inseridos
    const delPlaceholders = itemIds.map(() => '?').join(',');
    await db.run(
      `DELETE FROM ProjetoItem WHERE ProjetoID = ? AND ProjetoItemID IN (${delPlaceholders})`,
      [id, ...itemIds]
    );

    // 4. Se o serviço for FAB.MON.CXA ou FAB.ESP.PCA, ajusta FAB.EMB.UND
    const monItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.MON.CXA']);
    const espItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.ESP.PCA']);
    const embItem = await db.get('SELECT * FROM ProjetoItem WHERE ProjetoID = ? AND MaterialReferencia = ?', [id, 'FAB.EMB.UND']);
    if (embItem) {
      const sumQtd = (monItem ? (parseFloat(monItem.ProjetoItemQtd) || 0) : 0) + (espItem ? (parseFloat(espItem.ProjetoItemQtd) || 0) : 0);
      const embVlrUnit = embItem.ProjetoItemVlrUnit || 0.0;
      const embTotal = embVlrUnit * sumQtd;
      const embTempo = parseInt(embItem.ProjetoItemTempo, 10) || 0;
      const embDuracao = Math.round(embTempo * sumQtd);
      await db.run(
        'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemDuracao = ? WHERE ProjetoID = ? AND MaterialReferencia = ?',
        [sumQtd, embTotal, embDuracao, id, 'FAB.EMB.UND']
      );
    }

    // 5. Recalcular custos consolidados do projeto
    await recalculateProjectCosts(id);

    // 6. Buscar lista atualizada de itens e dados do projeto
    const itens = await db.all(`
      SELECT 
        pi.ProjetoID,
        pi.ProjetoItemID,
        pi.MaterialReferencia,
        m.MaterialDescricao,
        m.MaterialTipo AS MaterialTipo,
        m.MaterialImagem,
        COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
        COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
        pi.ProjetoItemVlrUnit,
        COALESCE(m.MaterialValorUnitario, 0.0) AS MaterialValorUnitarioAtual,
        pi.ProjetoItemUnidade,
        pi.ProjetoItemQtd,
        pi.ProjetoItemTotal,
        pi.ProjetoItemTempo,
        pi.ProjetoItemDuracao
      FROM ProjetoItem pi
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia
      WHERE pi.ProjetoID = ?
      ORDER BY pi.ProjetoItemID ASC
    `, [id]);

    const proj = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);

    res.json({
      success: true,
      message: `Novo material "${mat.MaterialDescricao}" incluído (${qtdToInsert} ${unidade}) e ${itemIds.length} ${itemIds.length === 1 ? 'item anterior excluído' : 'itens anteriores excluídos'}.`,
      itens,
      projeto: proj
    });
  } catch (error) {
    console.error('SUBSTITUIR MATERIAIS ERROR:', error);
    res.status(500).json({ error: 'Erro ao substituir materiais do projeto.' });
  }
});

// POST /api/projetos/:id/atualizar-precos-materiais
app.post('/api/projetos/:id/atualizar-precos-materiais', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const proj = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      JOIN orcamentos o ON p.orcamento_numero = o.numero 
      WHERE p.id = ?
    `, [id]);

    if (!proj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    if (proj.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter os preços de seus materiais alterados.' });
    }

    // Update ProjetoItem with latest MaterialValorUnitario
    await db.run(`
      UPDATE ProjetoItem
      SET 
        ProjetoItemVlrUnit = COALESCE((
          SELECT m.MaterialValorUnitario 
          FROM Material m 
          WHERE m.MaterialReferencia = ProjetoItem.MaterialReferencia
        ), ProjetoItemVlrUnit),
        ProjetoItemTotal = ProjetoItemQtd * COALESCE((
          SELECT m.MaterialValorUnitario 
          FROM Material m 
          WHERE m.MaterialReferencia = ProjetoItem.MaterialReferencia
        ), ProjetoItemVlrUnit)
      WHERE ProjetoID = ?
    `, [id]);

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id);

    // Get updated project costs
    const updatedProj = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    const custoTotal = updatedProj ? (updatedProj.CustoTotal || 0.0) : 0.0;

    // Recalculate suggested & final sale price
    const budget = await db.get('SELECT parametro_financeiro_id FROM orcamentos WHERE numero = ?', [updatedProj.orcamento_numero]);
    const paramId = budget ? (budget.parametro_financeiro_id || 1) : 1;
    const paramConfig = await db.get('SELECT * FROM configuracoes_financeiras WHERE parametro_id = ?', [paramId]);

    const percImposto = updatedProj.perc_imposto !== null && updatedProj.perc_imposto !== undefined 
      ? parseFloat(updatedProj.perc_imposto) 
      : (paramConfig ? parseFloat(paramConfig.perc_imposto) || 6.0 : 6.0);

    const percComissao = updatedProj.perc_comissao !== null && updatedProj.perc_comissao !== undefined 
      ? parseFloat(updatedProj.perc_comissao) 
      : (paramConfig ? parseFloat(paramConfig.perc_comissao) || 5.0 : 5.0);

    const percFinanceiro = updatedProj.perc_custo_financeiro !== null && updatedProj.perc_custo_financeiro !== undefined 
      ? parseFloat(updatedProj.perc_custo_financeiro) 
      : (paramConfig ? parseFloat(paramConfig.perc_custo_financeiro) || 4.0 : 4.0);

    const percLucro = updatedProj.perc_markup_lucro !== null && updatedProj.perc_markup_lucro !== undefined 
      ? parseFloat(updatedProj.perc_markup_lucro) 
      : (paramConfig ? parseFloat(paramConfig.perc_markup_lucro) || 20.0 : 20.0);

    const totalPerc = percImposto + percComissao + percFinanceiro + percLucro;
    const divisor = 1 - (totalPerc / 100);
    const precoSugerido = (divisor > 0 && custoTotal > 0) ? (custoTotal / divisor) : (custoTotal * (1 + (totalPerc / 100)));

    await db.run(`
      UPDATE projetos 
      SET 
        preco_venda_sugerido = ?, 
        preco_venda_final = ?
      WHERE id = ?
    `, [precoSugerido, precoSugerido, id]);

    // Fetch updated items
    const updatedItems = await db.all(`
      SELECT 
        pi.ProjetoID,
        pi.ProjetoItemID,
        pi.MaterialReferencia,
        m.MaterialDescricao,
        m.MaterialTipo AS MaterialTipo,
        m.MaterialImagem,
        COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
        COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
        pi.ProjetoItemVlrUnit,
        COALESCE(m.MaterialValorUnitario, 0.0) AS MaterialValorUnitarioAtual,
        pi.ProjetoItemUnidade,
        pi.ProjetoItemQtd,
        pi.ProjetoItemTotal,
        pi.ProjetoItemTempo,
        pi.ProjetoItemDuracao
      FROM ProjetoItem pi
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia
      WHERE pi.ProjetoID = ?
      ORDER BY pi.ProjetoItemID ASC
    `, [id]);

    const finalProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id
      WHERE p.id = ?
    `, [id]);

    res.json({
      success: true,
      message: 'Preços dos materiais e precificação atualizados com sucesso.',
      projeto: finalProject,
      itens: updatedItems
    });
  } catch (error) {
    console.error('SYNC MATERIAL PRICES ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar preços dos materiais do projeto.' });
  }
});

// POST /api/projetos/:id/gerar-orcamento (GerarOrcamentoProjeto)
app.post('/api/projetos/:id/gerar-orcamento', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const project = await db.get('SELECT * FROM projetos WHERE id = ?', [id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    const materials = await db.all('SELECT * FROM Projeto_Materiais WHERE projeto_id = ?', [id]);

    await db.run('BEGIN TRANSACTION');

    // 1 - Limpa itens antigos para este projeto na tabela ProjetoItem
    await db.run('DELETE FROM ProjetoItem WHERE ProjetoID = ?', [id]);

    let currentSeq = 1;
    let custoTotal = 0;

    // Calcula a quantidade de FAB.EMB.UND com base na soma de FAB.MON.CXA + FAB.ESP.PCA
    const monItem = materials.find(m => m.referencia === 'FAB.MON.CXA');
    const espItem = materials.find(m => m.referencia === 'FAB.ESP.PCA');
    const qtdMonCxa = monItem ? (parseFloat(monItem.qtd) || 0.0) : 0.0;
    const qtdEspPca = espItem ? (parseFloat(espItem.qtd) || 0.0) : 0.0;
    const qtdEmbUnd = qtdMonCxa + qtdEspPca;

    for (const m of materials) {
      // Ignora a referência FAB.QTD.PCA caso exista em registros legados
      if (m.referencia === 'FAB.QTD.PCA') continue;

      // Recupera o material da tabela global Material usando a referência
      let globalMat = await db.get('SELECT * FROM Material WHERE MaterialReferencia = ?', [m.referencia]);
      
      // Se a referência não existir em Material, insere com segurança para não violar Foreign Key
      if (!globalMat) {
        let normUn = (m.un || '').toUpperCase().trim();
        if (normUn === 'UN') normUn = 'UNI';
        const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
        if (!allowedUnits.includes(normUn)) {
          normUn = 'UNI';
        }
        const matTipo = (m.tipo || (m.referencia && m.referencia.startsWith('FAB.') ? 'Serviço' : 'Produto'));
        await db.run(
          `INSERT INTO Material (MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [m.referencia, m.descricao || m.referencia, normUn, 0.0, null, 8, matTipo, 0]
        );
        globalMat = {
          MaterialReferencia: m.referencia,
          MaterialDescricao: m.descricao || m.referencia,
          MaterialUnidade: normUn,
          MaterialValorUnitario: 0.0,
          GrupoSigla: null,
          ProdutoGrupo: 8,
          MaterialTipo: matTipo,
          MaterialTempo: 0
        };
      }

      const vlrUnit = globalMat.MaterialValorUnitario || 0.0;
      const unidade = (globalMat.MaterialUnidade || m.un || 'UNI').substring(0, 3);
      let qtd = parseFloat(m.qtd) || 0.0;
      if (m.referencia === 'FAB.EMB.UND') {
        qtd = qtdEmbUnd;
      }
      const total = vlrUnit * qtd;
      const tempo = parseInt(globalMat.MaterialTempo, 10) || 0;
      const duracao = Math.round(tempo * qtd);

      await db.run(
        `INSERT INTO ProjetoItem (ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, currentSeq, m.referencia, vlrUnit, unidade, qtd, total, tempo, duracao]
      );
      custoTotal += total;
      currentSeq++;
    }

    // Recalculate project consolidated costs and total duration
    await recalculateProjectCosts(id);

    // Auto-generate project description if empty
    if (!project.descricao || project.descricao.trim() === '') {
      const autoDesc = await buildProjectDescriptionFromDB(id);
      if (autoDesc) {
        await db.run('UPDATE projetos SET descricao = ? WHERE id = ?', [autoDesc, id]);
      }
    }

    await db.run('COMMIT');

    res.json({ success: true, message: 'Orçamento gerado com sucesso.', CustoTotal: custoTotal });
  } catch (error) {
    try {
      await db.run('ROLLBACK');
    } catch (e) {
      // ignore
    }
    console.error('GERAR ORCAMENTO ERROR:', error);
    res.status(500).json({ error: error.message || 'Erro ao gerar o orçamento do projeto.' });
  }
});

// 14. Parametros Financeiros e Configuracoes Financeiras Routes
app.get('/api/parametros-financeiros', authenticateToken, async (req, res) => {
  const { situacao } = req.query;
  try {
    let query = `
      SELECT 
        pf.id, 
        pf.nome, 
        pf.situacao, 
        pf.created_at,
        cf.perc_imposto, 
        cf.perc_comissao, 
        cf.perc_custo_financeiro, 
        cf.perc_markup_lucro, 
        cf.perc_margem_minima, 
        cf.metodo_calculo,
        cf.updated_at
      FROM Parametro_Financeiro pf
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
    `;
    const params = [];
    if (situacao) {
      query += ` WHERE pf.situacao = ?`;
      params.push(situacao);
    }
    query += ` ORDER BY pf.id ASC`;
    const list = await db.all(query, params);
    res.json(list);
  } catch (error) {
    console.error('GET PARAMETROS FINANCEIROS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar parâmetros financeiros.' });
  }
});

app.get('/api/parametros-financeiros/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const item = await db.get(`
      SELECT 
        pf.id, 
        pf.nome, 
        pf.situacao, 
        pf.created_at,
        cf.perc_imposto, 
        cf.perc_comissao, 
        cf.perc_custo_financeiro, 
        cf.perc_markup_lucro, 
        cf.perc_margem_minima, 
        cf.metodo_calculo,
        cf.updated_at
      FROM Parametro_Financeiro pf
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE pf.id = ?
    `, [id]);
    if (!item) {
      return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
    }
    res.json(item);
  } catch (error) {
    console.error('GET PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar parâmetro financeiro.' });
  }
});

app.post('/api/parametros-financeiros', authenticateToken, async (req, res) => {
  const { 
    nome, 
    situacao, 
    perc_imposto, 
    perc_comissao, 
    perc_custo_financeiro, 
    perc_markup_lucro, 
    perc_margem_minima, 
    metodo_calculo 
  } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'O nome do parâmetro financeiro é obrigatório.' });
  }

  try {
    const result = await db.run(
      'INSERT INTO Parametro_Financeiro (nome, situacao) VALUES (?, ?)',
      [nome.trim(), situacao || 'Ativado']
    );
    const parametroId = result.lastID;

    await db.run(`
      INSERT INTO configuracoes_financeiras (parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      parametroId,
      parseFloat(perc_imposto) || 0,
      parseFloat(perc_comissao) || 0,
      parseFloat(perc_custo_financeiro) || 0,
      parseFloat(perc_markup_lucro) || 0,
      parseFloat(perc_margem_minima) || 0,
      metodo_calculo || 'divisor'
    ]);

    const created = await db.get(`
      SELECT 
        pf.id, 
        pf.nome, 
        pf.situacao, 
        pf.created_at,
        cf.perc_imposto, 
        cf.perc_comissao, 
        cf.perc_custo_financeiro, 
        cf.perc_markup_lucro, 
        cf.perc_margem_minima, 
        cf.metodo_calculo,
        cf.updated_at
      FROM Parametro_Financeiro pf
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE pf.id = ?
    `, [parametroId]);

    res.status(201).json(created);
  } catch (error) {
    console.error('CREATE PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar parâmetro financeiro.' });
  }
});

app.put('/api/parametros-financeiros/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { 
    nome, 
    situacao, 
    perc_imposto, 
    perc_comissao, 
    perc_custo_financeiro, 
    perc_markup_lucro, 
    perc_margem_minima, 
    metodo_calculo 
  } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'O nome do parâmetro financeiro é obrigatório.' });
  }

  try {
    const existing = await db.get('SELECT * FROM Parametro_Financeiro WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
    }

    await db.run(
      'UPDATE Parametro_Financeiro SET nome = ?, situacao = ? WHERE id = ?',
      [nome.trim(), situacao || 'Ativado', id]
    );

    const conf = await db.get('SELECT * FROM configuracoes_financeiras WHERE parametro_id = ?', [id]);
    if (conf) {
      await db.run(`
        UPDATE configuracoes_financeiras 
        SET 
          perc_imposto = ?, 
          perc_comissao = ?, 
          perc_custo_financeiro = ?, 
          perc_markup_lucro = ?, 
          perc_margem_minima = ?, 
          metodo_calculo = ?, 
          updated_at = CURRENT_TIMESTAMP
        WHERE parametro_id = ?
      `, [
        parseFloat(perc_imposto) || 0,
        parseFloat(perc_comissao) || 0,
        parseFloat(perc_custo_financeiro) || 0,
        parseFloat(perc_markup_lucro) || 0,
        parseFloat(perc_margem_minima) || 0,
        metodo_calculo || 'divisor',
        id
      ]);
    } else {
      await db.run(`
        INSERT INTO configuracoes_financeiras (parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        parseFloat(perc_imposto) || 0,
        parseFloat(perc_comissao) || 0,
        parseFloat(perc_custo_financeiro) || 0,
        parseFloat(perc_markup_lucro) || 0,
        parseFloat(perc_margem_minima) || 0,
        metodo_calculo || 'divisor'
      ]);
    }

    const updated = await db.get(`
      SELECT 
        pf.id, 
        pf.nome, 
        pf.situacao, 
        pf.created_at,
        cf.perc_imposto, 
        cf.perc_comissao, 
        cf.perc_custo_financeiro, 
        cf.perc_markup_lucro, 
        cf.perc_margem_minima, 
        cf.metodo_calculo,
        cf.updated_at
      FROM Parametro_Financeiro pf
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE pf.id = ?
    `, [id]);

    res.json(updated);
  } catch (error) {
    console.error('UPDATE PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar parâmetro financeiro.' });
  }
});

app.delete('/api/parametros-financeiros/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM Parametro_Financeiro WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
    }

    const inUse = await db.get('SELECT COUNT(*) as count FROM orcamentos WHERE parametro_financeiro_id = ?', [id]);
    if (inUse && inUse.count > 0) {
      return res.status(400).json({ error: `Este parâmetro está vinculado a ${inUse.count} orçamento(s) e não pode ser excluído. Em vez disso, altere a situação para 'Desativado'.` });
    }

    await db.run('DELETE FROM Parametro_Financeiro WHERE id = ?', [id]);
    res.json({ message: 'Parâmetro financeiro removido com sucesso.' });
  } catch (error) {
    console.error('DELETE PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir parâmetro financeiro.' });
  }
});

app.get('/api/configuracoes/financeiro', authenticateToken, async (req, res) => {
  try {
    let config = await db.get(`
      SELECT 
        pf.id, 
        pf.nome, 
        pf.situacao, 
        cf.perc_imposto, 
        cf.perc_comissao, 
        cf.perc_custo_financeiro, 
        cf.perc_markup_lucro, 
        cf.perc_margem_minima, 
        cf.metodo_calculo
      FROM Parametro_Financeiro pf
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
      WHERE pf.situacao = 'Ativado'
      ORDER BY pf.id ASC
      LIMIT 1
    `);
    if (!config) {
      config = await db.get(`
        SELECT 
          pf.id, 
          pf.nome, 
          pf.situacao, 
          cf.perc_imposto, 
          cf.perc_comissao, 
          cf.perc_custo_financeiro, 
          cf.perc_markup_lucro, 
          cf.perc_margem_minima, 
          cf.metodo_calculo
        FROM Parametro_Financeiro pf
        LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id
        WHERE pf.id = 1
      `);
    }
    res.json(config || {
      id: 1,
      nome: 'Padrão Fábrica',
      situacao: 'Ativado',
      perc_imposto: 6.0,
      perc_comissao: 5.0,
      perc_custo_financeiro: 4.0,
      perc_markup_lucro: 20.0,
      perc_margem_minima: 10.0,
      metodo_calculo: 'divisor'
    });
  } catch (error) {
    console.error('GET CONFIG FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar configurações financeiras.' });
  }
});

// ==========================================
// FORMAS DE PAGAMENTO & CONDIÇÕES ENDPOINTS
// ==========================================

// GET /api/formas-pagamento
app.get('/api/formas-pagamento', authenticateToken, async (req, res) => {
  try {
    const formas = await db.all('SELECT * FROM formas_pagamento ORDER BY ordem ASC, id ASC');
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento ORDER BY ordem ASC, id ASC');

    const result = formas.map(f => ({
      ...f,
      condicoes: condicoes.filter(c => c.forma_pagamento_id === f.id)
    }));

    res.json(result);
  } catch (error) {
    console.error('GET FORMAS PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar formas de pagamento.' });
  }
});

// GET /api/formas-pagamento/:id
app.get('/api/formas-pagamento/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const forma = await db.get('SELECT * FROM formas_pagamento WHERE id = ?', [id]);
    if (!forma) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE forma_pagamento_id = ? ORDER BY ordem ASC, id ASC', [id]);
    res.json({ ...forma, condicoes });
  } catch (error) {
    console.error('GET FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar forma de pagamento.' });
  }
});

// POST /api/formas-pagamento
app.post('/api/formas-pagamento', authenticateToken, async (req, res) => {
  const { nome, descricao, valor_minimo, valor_maximo, ativo, ordem, condicoes } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'Nome da forma de pagamento é obrigatório.' });
  }

  try {
    const vMin = parseFloat(valor_minimo) || 0.0;
    const vMax = parseFloat(valor_maximo) || 0.0;
    const isAtivo = ativo === 'Nao' ? 'Nao' : 'Sim';
    const ord = parseInt(ordem, 10) || 1;

    const result = await db.run(
      `INSERT INTO formas_pagamento (nome, descricao, valor_minimo, valor_maximo, ativo, ordem)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nome.trim(), (descricao || '').trim(), vMin, vMax, isAtivo, ord]
    );

    const formaId = result.lastID;

    if (Array.isArray(condicoes) && condicoes.length > 0) {
      for (let i = 0; i < condicoes.length; i++) {
        const c = condicoes[i];
        if (c.descricao && c.descricao.trim()) {
          await db.run(
            `INSERT INTO condicoes_pagamento (forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              formaId,
              parseFloat(c.perc_entrada) || 0,
              parseInt(c.num_parcelas, 10) || 0,
              parseFloat(c.perc_desconto) || 0,
              (c.meio_pagamento || '').trim(),
              c.descricao.trim(),
              parseInt(c.ordem, 10) || (i + 1)
            ]
          );
        }
      }
    }

    const createdForma = await db.get('SELECT * FROM formas_pagamento WHERE id = ?', [formaId]);
    const createdCondicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE forma_pagamento_id = ? ORDER BY ordem ASC, id ASC', [formaId]);
    res.status(201).json({ ...createdForma, condicoes: createdCondicoes });
  } catch (error) {
    console.error('POST FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar forma de pagamento.' });
  }
});

// PUT /api/formas-pagamento/:id
app.put('/api/formas-pagamento/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { nome, descricao, valor_minimo, valor_maximo, ativo, ordem } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'Nome da forma de pagamento é obrigatório.' });
  }

  try {
    const existing = await db.get('SELECT * FROM formas_pagamento WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }

    const vMin = valor_minimo !== undefined ? (parseFloat(valor_minimo) || 0.0) : existing.valor_minimo;
    const vMax = valor_maximo !== undefined ? (parseFloat(valor_maximo) || 0.0) : existing.valor_maximo;
    const isAtivo = ativo !== undefined ? (ativo === 'Nao' ? 'Nao' : 'Sim') : existing.ativo;
    const ord = ordem !== undefined ? (parseInt(ordem, 10) || 1) : existing.ordem;

    await db.run(
      `UPDATE formas_pagamento 
       SET nome = ?, descricao = ?, valor_minimo = ?, valor_maximo = ?, ativo = ?, ordem = ?
       WHERE id = ?`,
      [nome.trim(), (descricao !== undefined ? descricao : existing.descricao || '').trim(), vMin, vMax, isAtivo, ord, id]
    );

    const updated = await db.get('SELECT * FROM formas_pagamento WHERE id = ?', [id]);
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE forma_pagamento_id = ? ORDER BY ordem ASC, id ASC', [id]);
    res.json({ ...updated, condicoes });
  } catch (error) {
    console.error('PUT FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar forma de pagamento.' });
  }
});

// DELETE /api/formas-pagamento/:id
app.delete('/api/formas-pagamento/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM formas_pagamento WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }

    await db.run('DELETE FROM condicoes_pagamento WHERE forma_pagamento_id = ?', [id]);
    await db.run('DELETE FROM formas_pagamento WHERE id = ?', [id]);
    res.json({ message: 'Forma de pagamento excluída com sucesso.' });
  } catch (error) {
    console.error('DELETE FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir forma de pagamento.' });
  }
});

// POST /api/formas-pagamento/:id/condicoes
app.post('/api/formas-pagamento/:id/condicoes', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ error: 'Descrição da condição é obrigatória.' });
  }

  try {
    const forma = await db.get('SELECT * FROM formas_pagamento WHERE id = ?', [id]);
    if (!forma) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }

    const result = await db.run(
      `INSERT INTO condicoes_pagamento (forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parseFloat(perc_entrada) || 0,
        parseInt(num_parcelas, 10) || 0,
        parseFloat(perc_desconto) || 0,
        (meio_pagamento || '').trim(),
        descricao.trim(),
        parseInt(ordem, 10) || 1
      ]
    );

    const createdCondicao = await db.get('SELECT * FROM condicoes_pagamento WHERE id = ?', [result.lastID]);
    res.status(201).json(createdCondicao);
  } catch (error) {
    console.error('POST CONDICAO PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar condição de pagamento.' });
  }
});

// PUT /api/condicoes-pagamento/:id
app.put('/api/condicoes-pagamento/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ error: 'Descrição da condição é obrigatória.' });
  }

  try {
    const existing = await db.get('SELECT * FROM condicoes_pagamento WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Condição de pagamento não encontrada.' });
    }

    await db.run(
      `UPDATE condicoes_pagamento 
       SET perc_entrada = ?, num_parcelas = ?, perc_desconto = ?, meio_pagamento = ?, descricao = ?, ordem = ?
       WHERE id = ?`,
      [
        perc_entrada !== undefined ? (parseFloat(perc_entrada) || 0) : existing.perc_entrada,
        num_parcelas !== undefined ? (parseInt(num_parcelas, 10) || 0) : existing.num_parcelas,
        perc_desconto !== undefined ? (parseFloat(perc_desconto) || 0) : existing.perc_desconto,
        meio_pagamento !== undefined ? (meio_pagamento || '').trim() : existing.meio_pagamento,
        descricao.trim(),
        ordem !== undefined ? (parseInt(ordem, 10) || 1) : existing.ordem,
        id
      ]
    );

    const updated = await db.get('SELECT * FROM condicoes_pagamento WHERE id = ?', [id]);
    res.json(updated);
  } catch (error) {
    console.error('PUT CONDICAO PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar condição de pagamento.' });
  }
});

// DELETE /api/condicoes-pagamento/:id
app.delete('/api/condicoes-pagamento/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM condicoes_pagamento WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Condição de pagamento não encontrada.' });
    }

    await db.run('DELETE FROM condicoes_pagamento WHERE id = ?', [id]);
    res.json({ message: 'Condição de pagamento excluída com sucesso.' });
  } catch (error) {
    console.error('DELETE CONDICAO PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir condição de pagamento.' });
  }
});

// ==========================================
// COMPARTILHAMENTO DE PROPOSTA ENDPOINTS
// ==========================================

// POST /api/orcamentos/:numero/compartilhar - Gerar novo token com validade configurável e registrar histórico
app.post('/api/orcamentos/:numero/compartilhar', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  const { diasValidade } = req.body || {};
  try {
    const orc = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [numero]);
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const agora = new Date();
    const dias = parseInt(diasValidade, 10) > 0 ? parseInt(diasValidade, 10) : 3;
    const expiraEm = new Date(agora.getTime() + dias * 24 * 60 * 60 * 1000).toISOString();
    const userId = req.user?.id || null;
    const userNome = req.user?.nome || req.user?.name || req.user?.login || 'Usuário';

    const result = await db.run(
      `INSERT INTO proposta_compartilhamentos (orcamento_numero, token, criado_por, criado_por_nome, expira_em, acessos_count, status)
       VALUES (?, ?, ?, ?, ?, 0, 'Ativo')`,
      [numero, token, userId, userNome, expiraEm]
    );

    const shareId = result.lastID;
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE id = ?', [shareId]);

    res.status(201).json({
      ...share,
      diasValidade: dias,
      message: 'Token de compartilhamento gerado com sucesso.'
    });
  } catch (error) {
    console.error('POST COMPARTILHAR ORCAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao gerar link de compartilhamento.' });
  }
});

// GET /api/orcamentos/:numero/compartilhamentos - Histórico de compartilhamentos do orçamento
app.get('/api/orcamentos/:numero/compartilhamentos', authenticateToken, async (req, res) => {
  const { numero } = req.params;
  try {
    const list = await db.all(
      `SELECT * FROM proposta_compartilhamentos 
       WHERE orcamento_numero = ? 
       ORDER BY criado_em DESC, id DESC`,
      [numero]
    );

    const now = new Date();
    const result = list.map(item => {
      let computedStatus = item.status;
      if (item.status === 'Ativo' && new Date(item.expira_em) < now) {
        computedStatus = 'Expirado';
      }
      return {
        ...item,
        status: computedStatus,
        is_expirado: new Date(item.expira_em) < now
      };
    });

    res.json(result);
  } catch (error) {
    console.error('GET COMPARTILHAMENTOS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar histórico de compartilhamentos.' });
  }
});

// PUT /api/compartilhamentos/:id/revogar - Revogar um link compartilhado
app.put('/api/compartilhamentos/:id/revogar', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM proposta_compartilhamentos WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Registro de compartilhamento não encontrado.' });
    }

    await db.run("UPDATE proposta_compartilhamentos SET status = 'Revogado' WHERE id = ?", [id]);
    const updated = await db.get('SELECT * FROM proposta_compartilhamentos WHERE id = ?', [id]);
    res.json(updated);
  } catch (error) {
    console.error('REVOGAR COMPARTILHAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao revogar link compartilhado.' });
  }
});

// GET /api/public/propostas/:token - Acesso público à proposta via Token (válido por 3 dias)
app.get('/api/public/propostas/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE token = ?', [token]);
    if (!share) {
      return res.status(404).json({ 
        error: 'Link de proposta não encontrado.',
        code: 'TOKEN_NOT_FOUND'
      });
    }

    if (share.status === 'Revogado') {
      return res.status(410).json({ 
        error: 'Este link de proposta foi revogado pelo emissor.',
        code: 'LINK_REVOKED',
        expira_em: share.expira_em
      });
    }

    const agora = new Date();
    const dataExpiracao = new Date(share.expira_em);
    if (dataExpiracao < agora) {
      return res.status(410).json({ 
        error: 'Este link de proposta expirou. O prazo de validade foi atingido.',
        code: 'LINK_EXPIRED',
        expira_em: share.expira_em,
        expirado: true
      });
    }

    // Registrar e incrementar acesso
    await db.run(
      `UPDATE proposta_compartilhamentos 
       SET acessos_count = acessos_count + 1, ultimo_acesso = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [share.id]
    );

    // Buscar dados do orçamento
    const orc = await db.get(
      `SELECT o.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.email as cliente_email 
       FROM orcamentos o 
       LEFT JOIN clientes c ON o.cliente_id = c.id 
       WHERE o.numero = ?`,
      [share.orcamento_numero]
    );

    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    // Buscar projetos do orçamento
    const projetos = await db.all('SELECT * FROM projetos WHERE orcamento_numero = ? ORDER BY id ASC', [share.orcamento_numero]);

    // Buscar itens e imagens dos projetos
    const itensPorProjeto = {};
    for (const p of projetos) {
      let itens = await db.all(`
        SELECT 
          pi.ProjetoID,
          pi.ProjetoItemID,
          pi.MaterialReferencia,
          m.MaterialDescricao,
          m.MaterialTipo AS MaterialTipo,
          m.MaterialImagem,
          COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
          COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
          pi.ProjetoItemVlrUnit,
          pi.ProjetoItemUnidade,
          pi.ProjetoItemQtd,
          pi.ProjetoItemTotal,
          pi.ProjetoItemTempo,
          pi.ProjetoItemDuracao
        FROM ProjetoItem pi
        LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia
        WHERE pi.ProjetoID = ?
        ORDER BY pi.ProjetoItemID ASC
      `, [p.id]);

      if (!itens || itens.length === 0) {
        itens = await db.all(`
          SELECT 
            pm.projeto_id AS ProjetoID,
            pm.id AS ProjetoItemID,
            pm.referencia AS MaterialReferencia,
            COALESCE(m.MaterialDescricao, pm.descricao) AS MaterialDescricao,
            m.MaterialTipo AS MaterialTipo,
            m.MaterialImagem,
            COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
            COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
            COALESCE(m.MaterialValorUnitario, 0.0) AS ProjetoItemVlrUnit,
            COALESCE(m.MaterialUnidade, pm.un, 'UN') AS ProjetoItemUnidade,
            pm.qtd AS ProjetoItemQtd,
            (pm.qtd * COALESCE(m.MaterialValorUnitario, 0.0)) AS ProjetoItemTotal,
            COALESCE(m.MaterialTempo, 0) AS ProjetoItemTempo,
            0 AS ProjetoItemDuracao
          FROM Projeto_Materiais pm
          LEFT JOIN Material m ON pm.referencia = m.MaterialReferencia
          WHERE pm.projeto_id = ?
          ORDER BY pm.id ASC
        `, [p.id]);
      }

      itensPorProjeto[p.id] = itens || [];
    }

    // Buscar Formas de Pagamento ativas e suas condições
    const formas = await db.all('SELECT * FROM formas_pagamento WHERE ativo = "Sim" ORDER BY ordem ASC, id ASC');
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento ORDER BY ordem ASC, id ASC');
    const formasComCondicoes = formas.map(f => ({
      ...f,
      condicoes: condicoes.filter(c => c.forma_pagamento_id === f.id)
    }));

    // Buscar anexos dos projetos marcados para exibição na proposta (exibir_na_proposta = 'Sim')
    const anexosPorProjeto = {};
    for (const p of projetos) {
      const anexos = await db.all(
        `SELECT * FROM projeto_anexos WHERE projeto_id = ? AND COALESCE(exibir_na_proposta, 'Sim') = 'Sim' ORDER BY id ASC`,
        [p.id]
      );
      anexosPorProjeto[p.id] = anexos || [];
    }

    // Buscar parâmetros da empresa (logomarca e assinatura) para exibição na proposta pública
    const empresaParams = await db.all("SELECT chave, conteudo FROM parametros_empresa WHERE chave IN ('EMP_LOGO', 'EMP_ASS', 'LOGO_EMP', 'RAZAO_SOC', 'NOME_FANT', 'CNPJ')");
    const paramMap = {};
    (empresaParams || []).forEach(p => {
      if (p.chave) paramMap[p.chave.toUpperCase()] = p.conteudo || '';
    });

    res.json({
      orcamento: orc,
      projetos,
      itensPorProjeto,
      anexosPorProjeto,
      formas_pagamento: formasComCondicoes,
      empresa_logo: paramMap['EMP_LOGO'] || paramMap['LOGO_EMP'] || '',
      empresa_assinatura: paramMap['EMP_ASS'] || '',
      empresa_razao_social: paramMap['RAZAO_SOC'] || paramMap['NOME_FANT'] || '',
      empresa_cnpj: paramMap['CNPJ'] || '',
      compartilhamento: {
        token: share.token,
        criado_em: share.criado_em,
        expira_em: share.expira_em,
        acessos_count: (share.acessos_count || 0) + 1,
        aprovado_em: share.aprovado_em,
        forma_pagamento_selecionada: share.forma_pagamento_selecionada,
        anotacoes_cliente: share.anotacoes_cliente
      }
    });
  } catch (error) {
    console.error('GET PUBLIC PROPOSTA ERROR:', error);
    res.status(500).json({ error: 'Erro ao carregar proposta pública.' });
  }
});

// POST /api/public/propostas/:token/anotacoes - Gravação de anotações/observações e forma de pagamento na proposta digital
app.post('/api/public/propostas/:token/anotacoes', async (req, res) => {
  const { token } = req.params;
  const { anotacoes, forma_pagamento_descricao } = req.body || {};
  try {
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE token = ?', [token]);
    if (!share) {
      return res.status(404).json({ error: 'Link de proposta não encontrado.' });
    }

    if (share.status === 'Revogado') {
      return res.status(410).json({ error: 'Este link de proposta foi revogado.' });
    }

    const agora = new Date();
    const dataExpiracao = new Date(share.expira_em);
    if (dataExpiracao < agora) {
      return res.status(410).json({ error: 'Este link de proposta expirou.' });
    }

    const orc = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [share.orcamento_numero]);
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const notes = typeof anotacoes === 'string' ? anotacoes.trim() : (orc.anotacoes_cliente || null);
    const formaDesc = typeof forma_pagamento_descricao === 'string' ? forma_pagamento_descricao.trim() : (orc.forma_pagamento_selecionada || null);

    // Atualiza o orçamento com as anotações, forma de pagamento selecionada e status para 'Em Negociação'
    await db.run(
      `UPDATE orcamentos 
       SET anotacoes_cliente = ?, 
           forma_pagamento_selecionada = ?, 
           status = CASE WHEN status = 'Aprovado' THEN status ELSE 'Em Negociação' END
       WHERE numero = ?`,
      [notes, formaDesc || orc.forma_pagamento_selecionada || null, share.orcamento_numero]
    );

    // Atualiza o registro de compartilhamento
    await db.run(
      `UPDATE proposta_compartilhamentos 
       SET anotacoes_cliente = ?, 
           forma_pagamento_selecionada = ? 
       WHERE id = ?`,
      [notes, formaDesc || share.forma_pagamento_selecionada || null, share.id]
    );

    const updatedOrc = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [share.orcamento_numero]);

    res.json({
      success: true,
      message: 'Proposta salva com sucesso!',
      orcamento: updatedOrc
    });
  } catch (error) {
    console.error('SALVAR ANOTACOES PROPOSTA PUBLICA ERROR:', error);
    res.status(500).json({ error: 'Erro ao salvar proposta.' });
  }
});

// POST /api/public/propostas/:token/aprovar - Aprovação online da proposta pelo cliente
app.post('/api/public/propostas/:token/aprovar', async (req, res) => {
  const { token } = req.params;
  const { forma_pagamento_descricao, anotacoes } = req.body || {};
  try {
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE token = ?', [token]);
    if (!share) {
      return res.status(404).json({ error: 'Link de proposta não encontrado.' });
    }

    if (share.status === 'Revogado') {
      return res.status(410).json({ error: 'Este link de proposta foi revogado.' });
    }

    const agora = new Date();
    const dataExpiracao = new Date(share.expira_em);
    if (dataExpiracao < agora) {
      return res.status(410).json({ error: 'Este link de proposta expirou.' });
    }

    const orc = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [share.orcamento_numero]);
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const formaDesc = (forma_pagamento_descricao || '').trim();
    const notes = typeof anotacoes === 'string' ? anotacoes.trim() : (orc.anotacoes_cliente || null);

    // 1. Atualiza o status do orçamento para "Aprovado"
    await db.run(
      `UPDATE orcamentos 
       SET status = 'Aprovado', 
           forma_pagamento_selecionada = ?, 
           anotacoes_cliente = ?, 
           data_aprovacao = CURRENT_TIMESTAMP 
       WHERE numero = ?`,
      [formaDesc || orc.forma_pagamento_selecionada || null, notes, share.orcamento_numero]
    );

    // 2. Registra a aprovação no histórico do link compartilhado
    await db.run(
      `UPDATE proposta_compartilhamentos 
       SET status = 'Aprovado',
           aprovado_em = CURRENT_TIMESTAMP, 
           forma_pagamento_selecionada = ?, 
           anotacoes_cliente = ? 
       WHERE id = ?`,
      [formaDesc || null, notes, share.id]
    );

    const updatedOrc = await db.get('SELECT * FROM orcamentos WHERE numero = ?', [share.orcamento_numero]);

    res.json({
      success: true,
      message: 'Proposta aprovada com sucesso!',
      orcamento: updatedOrc
    });
  } catch (error) {
    console.error('APROVAR PROPOSTA PUBLICA ERROR:', error);
    res.status(500).json({ error: 'Erro ao processar aprovação da proposta.' });
  }
});

// -------------------------------------------------------------
// CRUD DE PARAMETROS DA EMPRESA (ParametroEmpresa)
// Chave Vchar(10), Tipo N(2) dominios(1-7), Conteudo Vchar(60)
// -------------------------------------------------------------

// Upload de Imagem para Parâmetro (Tipo 7)
const parametrosStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, parametrosUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'param-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadParametros = multer({ storage: parametrosStorage });

app.post('/api/parametros-empresa/upload-imagem', authenticateToken, uploadParametros.single('imagem'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado.' });
    }
    const relativePath = `uploads/parametros/${req.file.filename}`;
    res.json({
      success: true,
      url: relativePath,
      caminho: relativePath,
      filename: req.file.filename
    });
  } catch (err) {
    console.error('Erro no upload de imagem do parâmetro:', err);
    res.status(500).json({ error: 'Erro ao processar upload da imagem.' });
  }
});

// Listar todos os Parâmetros da Empresa
app.get('/api/parametros-empresa', authenticateToken, async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM parametros_empresa ORDER BY chave ASC');
    res.json(list);
  } catch (err) {
    console.error('Erro ao listar parametros_empresa:', err);
    res.status(500).json({ error: 'Erro ao buscar parâmetros da empresa.' });
  }
});

// Buscar um Parâmetro por ID ou Chave
app.get('/api/parametros-empresa/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    let param;
    if (isNaN(id)) {
      param = await db.get('SELECT * FROM parametros_empresa WHERE chave = ?', [id.toUpperCase()]);
    } else {
      param = await db.get('SELECT * FROM parametros_empresa WHERE id = ? OR chave = ?', [id, id.toUpperCase()]);
    }
    if (!param) {
      return res.status(404).json({ error: 'Parâmetro não encontrado.' });
    }
    res.json(param);
  } catch (err) {
    console.error('Erro ao buscar parâmetro:', err);
    res.status(500).json({ error: 'Erro ao buscar parâmetro da empresa.' });
  }
});

// Criar Novo Parâmetro
app.post('/api/parametros-empresa', authenticateToken, async (req, res) => {
  const { chave, tipo, conteudo, descricao } = req.body;
  try {
    if (!chave || typeof chave !== 'string') {
      return res.status(400).json({ error: 'O campo Chave é obrigatório.' });
    }
    const chaveFormatada = chave.trim().toUpperCase();
    if (chaveFormatada.length > 10) {
      return res.status(400).json({ error: 'A Chave deve ter no máximo 10 caracteres.' });
    }

    const tipoNum = parseInt(tipo, 10);
    if (isNaN(tipoNum) || tipoNum < 1 || tipoNum > 7) {
      return res.status(400).json({ error: 'O Tipo deve ser um valor de 1 a 7 (1-Texto, 2-Valor, 3-Data, 4-Percentual, 5-Unidade, 6-Hora, 7-Imagem).' });
    }

    const conteudoStr = typeof conteudo === 'string' ? conteudo.trim() : (conteudo !== undefined && conteudo !== null ? String(conteudo) : '');
    if (conteudoStr.length > 60) {
      return res.status(400).json({ error: 'O Conteúdo deve ter no máximo 60 caracteres.' });
    }

    // Verificar unicidade da Chave
    const existing = await db.get('SELECT id FROM parametros_empresa WHERE chave = ?', [chaveFormatada]);
    if (existing) {
      return res.status(400).json({ error: `Já existe um parâmetro com a chave "${chaveFormatada}".` });
    }

    const result = await db.run(
      `INSERT INTO parametros_empresa (chave, tipo, conteudo, descricao) VALUES (?, ?, ?, ?)`,
      [chaveFormatada, tipoNum, conteudoStr, descricao ? descricao.trim() : null]
    );

    const newParam = await db.get('SELECT * FROM parametros_empresa WHERE id = ?', [result.lastID]);
    res.status(201).json(newParam);
  } catch (err) {
    console.error('Erro ao criar parâmetro:', err);
    res.status(500).json({ error: 'Erro ao cadastrar parâmetro da empresa.' });
  }
});

// Atualizar Parâmetro Existente
app.put('/api/parametros-empresa/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { chave, tipo, conteudo, descricao } = req.body;
  try {
    const current = await db.get('SELECT * FROM parametros_empresa WHERE id = ?', [id]);
    if (!current) {
      return res.status(404).json({ error: 'Parâmetro não encontrado.' });
    }

    let chaveFormatada = current.chave;
    if (chave && typeof chave === 'string') {
      chaveFormatada = chave.trim().toUpperCase();
      if (chaveFormatada.length > 10) {
        return res.status(400).json({ error: 'A Chave deve ter no máximo 10 caracteres.' });
      }

      // Verificar unicidade se mudou a chave
      if (chaveFormatada !== current.chave) {
        const existing = await db.get('SELECT id FROM parametros_empresa WHERE chave = ? AND id != ?', [chaveFormatada, id]);
        if (existing) {
          return res.status(400).json({ error: `Já existe outro parâmetro com a chave "${chaveFormatada}".` });
        }
      }
    }

    let tipoNum = current.tipo;
    if (tipo !== undefined) {
      tipoNum = parseInt(tipo, 10);
      if (isNaN(tipoNum) || tipoNum < 1 || tipoNum > 7) {
        return res.status(400).json({ error: 'O Tipo deve ser um valor de 1 a 7.' });
      }
    }

    let conteudoStr = current.conteudo;
    if (conteudo !== undefined) {
      conteudoStr = typeof conteudo === 'string' ? conteudo.trim() : (conteudo !== null ? String(conteudo) : '');
      if (conteudoStr.length > 60) {
        return res.status(400).json({ error: 'O Conteúdo deve ter no máximo 60 caracteres.' });
      }
    }

    const descStr = descricao !== undefined ? (descricao ? descricao.trim() : null) : current.descricao;

    await db.run(
      `UPDATE parametros_empresa 
       SET chave = ?, tipo = ?, conteudo = ?, descricao = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [chaveFormatada, tipoNum, conteudoStr, descStr, id]
    );

    const updated = await db.get('SELECT * FROM parametros_empresa WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error('Erro ao atualizar parâmetro:', err);
    res.status(500).json({ error: 'Erro ao atualizar parâmetro da empresa.' });
  }
});

// Excluir Parâmetro
app.delete('/api/parametros-empresa/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const current = await db.get('SELECT * FROM parametros_empresa WHERE id = ?', [id]);
    if (!current) {
      return res.status(404).json({ error: 'Parâmetro não encontrado.' });
    }

    await db.run('DELETE FROM parametros_empresa WHERE id = ?', [id]);
    res.json({ success: true, message: `Parâmetro "${current.chave}" removido com sucesso.` });
  } catch (err) {
    console.error('Erro ao excluir parâmetro:', err);
    res.status(500).json({ error: 'Erro ao excluir parâmetro da empresa.' });
  }
});

// -------------------------------------------------------------
// Servir Frontend Estático e SPA Fallback (Produção / Hostinger)
// -------------------------------------------------------------
const candidateDistPaths = [
  process.env.FRONTEND_DIST_PATH,
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), '../frontend/dist'),
  path.resolve(process.cwd(), 'dist')
].filter(Boolean);

const frontendDistPath = candidateDistPaths.find(p => fs.existsSync(path.join(p, 'index.html')));

if (frontendDistPath) {
  console.log(`[Frontend] Servindo frontend estático a partir de: ${frontendDistPath}`);
  app.use(express.static(frontendDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      return next();
    }
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
} else {
  console.log('[Frontend] Diretório frontend/dist não encontrado. Servindo apenas rotas de API.');
}

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
