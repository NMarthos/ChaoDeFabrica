// Polyfill Promise.withResolvers para compatibilidade caso o servidor rode Node < 22 (ex: Node 18/20 na Hostinger)
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb, seedCompanyDefaults } from './db.js';
import {
  requestIdMiddleware,
  createAuthMiddleware,
  requirePermission,
  requireCompanyAdmin,
  logAuditoria,
  TenantRepository,
  sanitizeSafeFilename,
  resolveSafeUploadPath
} from './tenantContext.js';
import { createRequire } from 'module';
import { PNG } from 'pngjs';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carrega .env da raiz do projeto, da pasta backend ou do diretório de trabalho atual
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Lazy loaders para bibliotecas de PDF (evita falha de inicialização do servidor por módulos nativos/canvas no Linux)
let _pdfParseModule = null;
async function getPdfParse() {
  if (!_pdfParseModule) {
    _pdfParseModule = require('pdf-parse');
  }
  return _pdfParseModule;
}

let _pdfjsModule = null;
async function getPdfJs() {
  if (!_pdfjsModule) {
    _pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsModule;
}

const app = express();
const PORT = process.env.PORT || 3001;
export const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_token_key_12345';

// Base directory for uploads (supports custom UPLOADS_PATH env var to store files outside app/git directory)
const rawUploadsDir = process.env.UPLOADS_PATH || './uploads';
export const uploadsBaseDir = path.isAbsolute(rawUploadsDir) ? rawUploadsDir : path.resolve(process.cwd(), rawUploadsDir);
const uploadDir = uploadsBaseDir;
const layoutsUploadDir = path.join(uploadsBaseDir, 'layouts');
const anexosUploadDir = path.join(uploadsBaseDir, 'anexos');
const parametrosUploadDir = path.join(uploadsBaseDir, 'parametros');

try {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  if (!fs.existsSync(layoutsUploadDir)) fs.mkdirSync(layoutsUploadDir, { recursive: true });
  if (!fs.existsSync(anexosUploadDir)) fs.mkdirSync(anexosUploadDir, { recursive: true });
  if (!fs.existsSync(parametrosUploadDir)) fs.mkdirSync(parametrosUploadDir, { recursive: true });
} catch (mkdirErr) {
  console.warn('Aviso ao criar diretórios de upload:', mkdirErr.message);
}

// Helper to safely resolve physical path of uploaded files (protegido contra Path Traversal)
export function getUploadPhysicalPath(relPath) {
  const resolved = resolveSafeUploadPath(uploadsBaseDir, relPath);
  return resolved ? resolved.fullPath : '';
}

export function getCompanyUploadDir(empresaId, category = 'geral') {
  const empId = Number(empresaId);
  if (!Number.isInteger(empId) || empId <= 0) {
    throw new Error('empresa_id inválido para armazenamento de arquivo.');
  }
  const safeCategory = String(category || 'geral').replace(/[^a-z0-9_-]/gi, '');
  const fullDir = path.join(uploadsBaseDir, `empresa_${empId}`, safeCategory);
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
  }
  return {
    fullDir,
    relPrefix: `uploads/empresa_${empId}/${safeCategory}`
  };
}

// Middlewares básicos
app.use(requestIdMiddleware);
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Setup multer upload folder organizado por empresa
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const empId = req.auth?.empresaId;
      if (!empId) return cb(new Error('Contexto de empresa obrigatório para upload.'));
      const { fullDir, relPrefix } = getCompanyUploadDir(empId, 'produtos');
      file._relPrefix = relPrefix;
      cb(null, fullDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeSafeFilename(file.originalname, 'prod');
    file.tenantRelPath = `${file._relPrefix || `uploads/empresa_${req.auth?.empresaId}/produtos`}/${safeName}`;
    cb(null, safeName);
  }
});
const upload = multer({ storage });

// Setup multer upload folder for layout files (organizado por empresa)
const layoutsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const empId = req.auth?.empresaId;
      if (!empId) return cb(new Error('Contexto de empresa obrigatório para upload de layout.'));
      const { fullDir, relPrefix } = getCompanyUploadDir(empId, 'layouts');
      file._relPrefix = relPrefix;
      cb(null, fullDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeSafeFilename(file.originalname, 'layout');
    file.tenantRelPath = `${file._relPrefix || `uploads/empresa_${req.auth?.empresaId}/layouts`}/${safeName}`;
    cb(null, safeName);
  }
});
const uploadLayouts = multer({ storage: layoutsStorage });

// Setup multer upload folder for project attachment files (organizado por empresa)
const anexosStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const empId = req.auth?.empresaId;
      if (!empId) return cb(new Error('Contexto de empresa obrigatório para upload de anexo.'));
      const { fullDir, relPrefix } = getCompanyUploadDir(empId, 'anexos');
      file._relPrefix = relPrefix;
      cb(null, fullDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeSafeFilename(file.originalname, 'anexo');
    file.tenantRelPath = `${file._relPrefix || `uploads/empresa_${req.auth?.empresaId}/anexos`}/${safeName}`;
    cb(null, safeName);
  }
});
const uploadAnexos = multer({ storage: anexosStorage });

// Initialize database asynchronously (sem top-level await ou process.exit para não derrubar o Passenger/LiteSpeed na Hostinger)
let db = null;
let dbInitError = null;
let dbInitPromise = null;

export async function ensureDbInitialized() {
  if (db) return db;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      const initializedDb = await initDb();
      await ensureOrcamentosSchema(initializedDb);
      db = initializedDb;
      dbInitError = null;
      console.log('MySQL database initialized successfully.');
      return db;
    } catch (error) {
      dbInitError = error;
      console.error('\n❌ [ERRO DE BANCO DE DADOS]');
      if (error.code === 'ECONNREFUSED' || (error.errors && error.errors.some(e => e.code === 'ECONNREFUSED'))) {
        console.error(`Não foi possível conectar ao servidor MySQL (${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '3306'}).`);
      } else if (error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ER_DBACCESS_DENIED_ERROR') {
        console.error('Acesso negado para o usuário/senha/banco informados nas variáveis de ambiente.');
      } else {
        console.error('Falha ao inicializar banco MySQL:', error.message || error);
      }
      return null;
    } finally {
      dbInitPromise = null;
    }
  })();

  return dbInitPromise;
}

// Dispara inicialização do banco em background logo ao subir
const dbReadyPromise = ensureDbInitialized();

// Rota de diagnóstico de saúde do servidor e banco de dados
app.get('/api/health', async (req, res) => {
  if (!db) {
    await ensureDbInitialized();
  }
  res.status(200).json({
    status: db ? 'ok' : 'db_error',
    nodeVersion: process.version,
    port: PORT,
    dbConnected: Boolean(db),
    dbConfig: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || '3306',
      user: process.env.DB_USER || 'u510090903_admin',
      database: process.env.DB_NAME || 'u510090903_erp',
      hasPassword: Boolean(process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'Erp!Db_2026#xQ7m')
    },
    dbError: dbInitError ? {
      code: dbInitError.code || null,
      message: dbInitError.message || String(dbInitError)
    } : null
  });
});

// Middleware para garantir que o banco está conectado antes de processar rotas /api/* e /uploads/*
app.use(['/api', '/uploads'], async (req, res, next) => {
  if (req.path === '/health') return next();
  if (!db) {
    await ensureDbInitialized();
  }
  if (!db) {
    const errCode = dbInitError?.code || 'DB_INIT_FAILED';
    const errMsg = dbInitError?.message || 'Não foi possível conectar ao banco de dados MySQL.';
    return res.status(500).json({
      error: `Erro de conexão com o banco de dados (${errCode}): ${errMsg}. Verifique as variáveis DB_HOST, DB_USER, DB_PASSWORD e DB_NAME no painel da Hostinger.`
    });
  }
  next();
});

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
    if (!colNames.includes('data_assinatura')) await database.exec("ALTER TABLE orcamentos ADD COLUMN data_assinatura TEXT");
    if (!colNames.includes('assinatura_responsavel')) await database.exec("ALTER TABLE orcamentos ADD COLUMN assinatura_responsavel TEXT");
    if (!colNames.includes('usuario_assinatura_nome')) await database.exec("ALTER TABLE orcamentos ADD COLUMN usuario_assinatura_nome TEXT");
  } catch (e) {
    console.error('Error ensuring orcamentos schema:', e);
  }
}

// Middleware central de autenticação e contexto seguro da empresa (req.auth e req.tenantDb)
const authenticateToken = createAuthMiddleware(() => db, JWT_SECRET);
const requireAdmin = requireCompanyAdmin(() => db);

/**
 * Verifica se um caminho relativo de arquivo em /uploads pertence à empresa informada
 * (tanto pela pasta física uploads/empresa_<id>/ quanto pelos metadados registrados no banco).
 */
async function verifyFileBelongsToCompany(database, empresaId, normalizedRelPath) {
  const empId = Number(empresaId);
  if (!Number.isInteger(empId) || empId <= 0 || !normalizedRelPath) return false;

  const cleanNoLeadingSlash = normalizedRelPath.replace(/^\/+/, '');
  const withLeadingSlash = `/${cleanNoLeadingSlash}`;
  const fileNameOnly = path.basename(cleanNoLeadingSlash);

  // Se o caminho aponta explicitamente para a pasta de outra empresa (ex: uploads/empresa_2/...), bloqueia imediatamente!
  const empFolderMatch = cleanNoLeadingSlash.match(/^uploads\/empresa_(\d+)\//i);
  if (empFolderMatch && Number(empFolderMatch[1]) !== empId) {
    return false;
  }

  // Confirma propriedade nos registros de arquivos do banco de dados para a empresa autenticada
  const anexo = await database.get(
    `SELECT id FROM projeto_anexos
     WHERE empresa_id = ? AND (caminho = ? OR caminho = ? OR nome_arquivo = ?)
     LIMIT 1`,
    [empId, cleanNoLeadingSlash, withLeadingSlash, fileNameOnly]
  );
  if (anexo) return true;

  const arqImp = await database.get(
    `SELECT id FROM arquivos_importados
     WHERE empresa_id = ? AND (caminho_arquivo = ? OR caminho_arquivo = ? OR caminho_arquivo LIKE ?)
     LIMIT 1`,
    [empId, cleanNoLeadingSlash, withLeadingSlash, `%${fileNameOnly}`]
  );
  if (arqImp) return true;

  const matImg = await database.get(
    `SELECT MaterialReferencia FROM Material
     WHERE empresa_id = ? AND (MaterialImagem = ? OR MaterialImagem = ? OR MaterialImagem LIKE ?)
     LIMIT 1`,
    [empId, cleanNoLeadingSlash, withLeadingSlash, `%${fileNameOnly}`]
  );
  if (matImg) return true;

  const paramImg = await database.get(
    `SELECT id FROM parametros_empresa
     WHERE empresa_id = ? AND (conteudo = ? OR conteudo = ? OR conteudo LIKE ?)
     LIMIT 1`,
    [empId, cleanNoLeadingSlash, withLeadingSlash, `%${fileNameOnly}`]
  );
  if (paramImg) return true;

  const projUrl = await database.get(
    `SELECT id FROM projetos
     WHERE empresa_id = ? AND (ProjetoURL = ? OR ProjetoURL = ? OR ProjetoURL LIKE ?)
     LIMIT 1`,
    [empId, cleanNoLeadingSlash, withLeadingSlash, `%${fileNameOnly}`]
  );
  if (projUrl) return true;

  return false;
}

/**
 * Entrega autenticada e controlada de arquivos sob /uploads/* (substitui express.static público).
 * Suporta:
 * 1) Usuário autenticado da empresa proprietária do arquivo (Bearer token ou ?token=...).
 * 2) Proposta pública compartilhada (?share_token=...) APENAS para anexos/imagens autorizados daquela proposta.
 */
app.get('/uploads/*', async (req, res) => {
  try {
    // Validação estrita contra Path Traversal na URL bruta antes mesmo da normalização do Express
    const rawUrlPath = decodeURIComponent((req.originalUrl || req.url || '').split('?')[0]);
    if (rawUrlPath.includes('..') || rawUrlPath.includes('\\') || rawUrlPath.includes('\0')) {
      return res.status(400).json({ error: 'Caminho de arquivo inválido.' });
    }

    const safeResolved = resolveSafeUploadPath(uploadsBaseDir, rawUrlPath);
    if (!safeResolved) {
      return res.status(400).json({ error: 'Caminho de arquivo inválido.' });
    }

    // Caso 1: Acesso via token de proposta pública (?share_token=...)
    const shareToken = req.query?.share_token ? String(req.query.share_token).trim() : null;
    if (shareToken && !req.headers['authorization'] && !req.query?.token) {
      const share = await db.get(
        `SELECT pc.*, e.ativo AS empresa_ativo, e.status AS empresa_status
         FROM proposta_compartilhamentos pc
         INNER JOIN empresas e ON e.id = pc.empresa_id
         WHERE pc.token = ?
         LIMIT 1`,
        [shareToken]
      );
      if (!share || Number(share.empresa_ativo) !== 1 || share.status === 'revogado') {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }
      if (share.expira_em && new Date(share.expira_em) < new Date()) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }

      const empId = Number(share.empresa_id);
      const orcNum = share.orcamento_numero;
      const cleanRel = safeResolved.normalizedRelPath;
      const withSlash = `/${cleanRel}`;
      const fileNameOnly = path.basename(cleanRel);

      // Bloqueia pastas de outras empresas
      const empFolderMatch = cleanRel.match(/^uploads\/empresa_(\d+)\//i);
      if (empFolderMatch && Number(empFolderMatch[1]) !== empId) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }

      // Verifica se o arquivo é um anexo autorizado na proposta pública (exibir_na_proposta = 'Sim'), imagem de material do orçamento ou parâmetro da empresa
      const allowedAnexo = await db.get(
        `SELECT pa.id
         FROM projeto_anexos pa
         INNER JOIN projetos p ON p.empresa_id = pa.empresa_id AND p.id = pa.projeto_id
         WHERE pa.empresa_id = ? AND p.orcamento_numero = ?
           AND LOWER(COALESCE(pa.exibir_na_proposta, 'sim')) = 'sim'
           AND (pa.caminho = ? OR pa.caminho = ? OR pa.nome_arquivo = ?)
         LIMIT 1`,
        [empId, orcNum, cleanRel, withSlash, fileNameOnly]
      );

      const allowedParam = !allowedAnexo && await db.get(
        `SELECT id FROM parametros_empresa
         WHERE empresa_id = ? AND chave IN ('EMP_LOGO', 'EMP_ASS')
           AND (conteudo = ? OR conteudo = ? OR conteudo LIKE ?)
         LIMIT 1`,
        [empId, cleanRel, withSlash, `%${fileNameOnly}`]
      );

      const allowedMat = !allowedAnexo && !allowedParam && await db.get(
        `SELECT m.MaterialReferencia
         FROM Material m
         INNER JOIN ProjetoItem pi ON pi.empresa_id = m.empresa_id AND pi.MaterialReferencia = m.MaterialReferencia
         INNER JOIN projetos p ON p.empresa_id = pi.empresa_id AND p.id = pi.ProjetoID
         WHERE m.empresa_id = ? AND p.orcamento_numero = ?
           AND (m.MaterialImagem = ? OR m.MaterialImagem = ? OR m.MaterialImagem LIKE ?)
         LIMIT 1`,
        [empId, orcNum, cleanRel, withSlash, `%${fileNameOnly}`]
      );

      if (!allowedAnexo && !allowedParam && !allowedMat) {
        await logAuditoria(db, req, {
          empresaId: empId,
          acao: 'DOWNLOAD_PUBLICO_NAO_AUTORIZADO',
          recurso: 'UPLOADS',
          recursoId: cleanRel
        });
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }

      if (!fs.existsSync(safeResolved.fullPath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }
      return res.sendFile(safeResolved.fullPath);
    }

    // Caso 2: Acesso autenticado (valida JWT, usuário ativo, empresa ativa e vínculo)
    return authenticateToken(req, res, async () => {
      const empId = req.auth.empresaId;
      const belongs = await verifyFileBelongsToCompany(db, empId, safeResolved.normalizedRelPath);
      if (!belongs || !fs.existsSync(safeResolved.fullPath)) {
        await logAuditoria(db, req, {
          empresaId: empId,
          usuarioId: req.auth.userId,
          acao: 'ACESSO_ARQUIVO_NEGADO_OU_INEXISTENTE',
          recurso: 'UPLOADS',
          recursoId: safeResolved.normalizedRelPath
        });
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }
      return res.sendFile(safeResolved.fullPath);
    });
  } catch (err) {
    console.error('[Uploads] Erro ao servir arquivo protegido:', err);
    return res.status(500).json({ error: 'Erro interno ao processar arquivo.' });
  }
});

function formatDateTimeForMySQL(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------- API Routes ----------------

// 1. Authentication, RBAC & User Management Routes
app.post('/api/auth/login', async (req, res) => {
  const email = req.body?.email;
  const senha = req.body?.senha || req.body?.password;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    const user = await db.get(
      `SELECT u.*, e.razao_social AS empresa_razao_social, e.nome_fantasia AS empresa_nome_fantasia,
              e.status AS empresa_status, e.ativo AS empresa_ativo,
              p.nome AS perfil_nome, p.ativo AS perfil_ativo
       FROM usuarios u
       INNER JOIN empresas e ON e.id = u.empresa_id
       LEFT JOIN perfis p ON p.empresa_id = u.empresa_id AND p.id = u.perfil_id
       WHERE u.email = ?
       LIMIT 1`,
      [String(email).trim()]
    );
    if (!user) {
      await logAuditoria(db, req, { acao: 'LOGIN_FALHA', recurso: 'AUTH', detalhes: { email } });
      return res.status(401).json({ error: 'Email ou senha incorretos.' });
    }

    const validPassword = await bcrypt.compare(senha, user.senha);
    if (!validPassword) {
      await logAuditoria(db, req, {
        empresaId: user.empresa_id,
        usuarioId: user.id,
        acao: 'LOGIN_FALHA_SENHA',
        recurso: 'AUTH',
        recursoId: user.id
      });
      return res.status(401).json({ error: 'Email ou senha incorretos.' });
    }

    if (Number(user.ativo) !== 1) {
      await logAuditoria(db, req, {
        empresaId: user.empresa_id,
        usuarioId: user.id,
        acao: 'LOGIN_BLOQUEADO_USUARIO_INATIVO',
        recurso: 'AUTH',
        recursoId: user.id
      });
      return res.status(403).json({ error: 'Usuário inativo. Contate o administrador da sua empresa.' });
    }

    const empStatusOk = String(user.empresa_status || 'Ativo').trim().toLowerCase() === 'ativo';
    if (Number(user.empresa_ativo) !== 1 || !empStatusOk) {
      await logAuditoria(db, req, {
        empresaId: user.empresa_id,
        usuarioId: user.id,
        acao: 'LOGIN_BLOQUEADO_EMPRESA_INATIVA',
        recurso: 'AUTH',
        recursoId: user.empresa_id
      });
      return res.status(403).json({ error: 'Empresa inativa ou suspensa.' });
    }

    const isAdmin = String(user.role || '').toLowerCase() === 'admin' || String(user.perfil_nome || '').toLowerCase() === 'administrador';
    let permissoes = [];
    if (isAdmin) {
      const allFuncs = await db.all('SELECT codigo FROM funcoes');
      permissoes = allFuncs.map(f => f.codigo);
    } else if (user.perfil_id && Number(user.perfil_ativo) === 1) {
      const pfRows = await db.all(
        `SELECT f.codigo
         FROM perfil_funcoes pf
         INNER JOIN funcoes f ON f.id = pf.funcao_id
         WHERE pf.empresa_id = ? AND pf.perfil_id = ?`,
        [user.empresa_id, user.perfil_id]
      );
      permissoes = pfRows.map(r => r.codigo);
    }

    const tokenPayload = {
      id: Number(user.id),
      empresa_id: Number(user.empresa_id),
      nome: user.nome,
      email: user.email,
      role: isAdmin ? 'admin' : user.role,
      perfil_id: user.perfil_id ? Number(user.perfil_id) : null
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    await logAuditoria(db, req, {
      empresaId: user.empresa_id,
      usuarioId: user.id,
      acao: 'LOGIN_SUCESSO',
      recurso: 'AUTH',
      recursoId: user.id
    });

    res.json({
      token,
      user: {
        id: Number(user.id),
        empresa_id: Number(user.empresa_id),
        empresa_nome: user.empresa_nome_fantasia || user.empresa_razao_social,
        nome: user.nome,
        email: user.email,
        role: isAdmin ? 'admin' : user.role,
        perfil_id: user.perfil_id ? Number(user.perfil_id) : null,
        perfil_nome: user.perfil_nome || null,
        permissoes
      }
    });
  } catch (error) {
    console.error('LOGIN ERROR:', error);
    res.status(500).json({ error: error.message || 'Erro no servidor durante o login.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await req.tenantDb.get(
      `SELECT u.id, u.empresa_id, u.perfil_id, u.nome, u.email, u.role, u.ativo, u.assinatura, u.created_at,
              e.razao_social AS empresa_razao_social, e.nome_fantasia AS empresa_nome_fantasia,
              p.nome AS perfil_nome
       FROM usuarios u
       INNER JOIN empresas e ON e.id = u.empresa_id
       LEFT JOIN perfis p ON p.empresa_id = u.empresa_id AND p.id = u.perfil_id
       WHERE u.empresa_id = ? AND u.id = ?`,
      [req.auth.empresaId, req.auth.userId]
    );
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    res.json({
      ...user,
      permissoes: req.auth.permissoes
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// Catálogo global de funções do sistema (somente leitura para todas as empresas; protegido contra mutação)
app.get('/api/funcoes', authenticateToken, async (req, res) => {
  try {
    const funcoes = await db.all('SELECT id, codigo, nome, modulo, descricao FROM funcoes ORDER BY modulo ASC, id ASC');
    res.json(funcoes);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar catálogo de funções.' });
  }
});

app.all('/api/funcoes*', authenticateToken, async (req, res, next) => {
  if (req.method === 'GET' && req.path === '/api/funcoes') return next();
  await logAuditoria(db, req, {
    acao: 'TENTATIVA_MUTACAO_CATALOGO_GLOBAL_FUNCOES',
    recurso: 'funcoes',
    detalhes: { method: req.method, path: req.path }
  });
  return res.status(403).json({
    error: 'O catálogo global de funções do sistema é protegido contra alterações por administradores de empresas.'
  });
});

// Perfis de acesso (isolados por empresa_id)
app.get('/api/perfis', authenticateToken, async (req, res) => {
  try {
    const perfis = await req.tenantDb.all(
      'SELECT id, empresa_id, nome, descricao, ativo, sistema, created_at FROM perfis WHERE empresa_id = ? ORDER BY id ASC',
      [req.auth.empresaId]
    );
    const vinculos = await req.tenantDb.all(
      `SELECT pf.perfil_id, pf.funcao_id, pf.permissao, f.codigo, f.nome AS funcao_nome, f.modulo
       FROM perfil_funcoes pf
       INNER JOIN funcoes f ON f.id = pf.funcao_id
       WHERE pf.empresa_id = ?`,
      [req.auth.empresaId]
    );
    const result = perfis.map(p => ({
      ...p,
      funcoes: vinculos.filter(v => v.perfil_id === p.id)
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar perfis da empresa.' });
  }
});

app.post('/api/perfis', authenticateToken, requirePermission('ADMIN_PERFIS'), async (req, res) => {
  const { nome, descricao, ativo = 1, funcoes = [] } = req.body;
  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ error: 'O nome do perfil é obrigatório.' });
  }

  try {
    const created = await req.tenantDb.transaction(async (tx) => {
      const existing = await tx.get(
        'SELECT id FROM perfis WHERE empresa_id = ? AND LOWER(nome) = LOWER(?) LIMIT 1',
        [req.auth.empresaId, String(nome).trim()]
      );
      if (existing) {
        const err = new Error('Já existe um perfil com este nome na sua empresa.');
        err.status = 400;
        throw err;
      }

      const ins = await tx.run(
        'INSERT INTO perfis (empresa_id, nome, descricao, ativo, sistema) VALUES (?, ?, ?, ?, 0)',
        [req.auth.empresaId, String(nome).trim(), descricao || null, Number(ativo) ? 1 : 0]
      );
      const perfilId = ins.lastID;

      if (Array.isArray(funcoes) && funcoes.length > 0) {
        for (const item of funcoes) {
          const codigoOrId = typeof item === 'object' ? (item.codigo || item.funcao_id || item.id) : item;
          const funcRow = await tx.get(
            'SELECT id, codigo FROM funcoes WHERE id = ? OR codigo = ? LIMIT 1',
            [codigoOrId, String(codigoOrId)]
          );
          if (!funcRow) {
            const err = new Error(`Função inválida informada: ${codigoOrId}`);
            err.status = 400;
            throw err;
          }
          // Impede conceder privilégios superiores aos autorizados ao próprio usuário
          if (req.auth.role !== 'admin' && !req.auth.permissoes.includes(funcRow.codigo)) {
            const err = new Error(`Não é permitido conceder a permissão "${funcRow.codigo}" superior às suas próprias permissões.`);
            err.status = 403;
            throw err;
          }
          await tx.run(
            'INSERT INTO perfil_funcoes (empresa_id, perfil_id, funcao_id, permissao) VALUES (?, ?, ?, ?)',
            [req.auth.empresaId, perfilId, funcRow.id, (typeof item === 'object' && item.permissao) ? item.permissao : 'TOTAL']
          );
        }
      }

      return tx.get('SELECT * FROM perfis WHERE empresa_id = ? AND id = ?', [req.auth.empresaId, perfilId]);
    });

    await logAuditoria(db, req, {
      acao: 'CRIAR_PERFIL',
      recurso: 'perfis',
      recursoId: created.id,
      detalhes: { nome: created.nome }
    });

    res.status(201).json(created);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erro ao criar perfil.' });
  }
});

app.put('/api/perfis/:id', authenticateToken, requirePermission('ADMIN_PERFIS'), async (req, res) => {
  const perfilId = Number(req.params.id);
  const { nome, descricao, ativo, funcoes } = req.body;

  try {
    const updated = await req.tenantDb.transaction(async (tx) => {
      const existing = await tx.get(
        'SELECT * FROM perfis WHERE empresa_id = ? AND id = ? LIMIT 1',
        [req.auth.empresaId, perfilId]
      );
      if (!existing) {
        const err = new Error('Perfil não encontrado.');
        err.status = 404;
        throw err;
      }

      const novoNome = nome !== undefined ? String(nome).trim() : existing.nome;
      const novaDesc = descricao !== undefined ? descricao : existing.descricao;
      const novoAtivo = ativo !== undefined ? (Number(ativo) ? 1 : 0) : existing.ativo;

      await tx.run(
        'UPDATE perfis SET nome = ?, descricao = ?, ativo = ? WHERE empresa_id = ? AND id = ?',
        [novoNome, novaDesc, novoAtivo, req.auth.empresaId, perfilId]
      );

      if (Array.isArray(funcoes)) {
        await tx.run('DELETE FROM perfil_funcoes WHERE empresa_id = ? AND perfil_id = ?', [req.auth.empresaId, perfilId]);
        for (const item of funcoes) {
          const codigoOrId = typeof item === 'object' ? (item.codigo || item.funcao_id || item.id) : item;
          const funcRow = await tx.get(
            'SELECT id, codigo FROM funcoes WHERE id = ? OR codigo = ? LIMIT 1',
            [codigoOrId, String(codigoOrId)]
          );
          if (!funcRow) continue;
          if (req.auth.role !== 'admin' && !req.auth.permissoes.includes(funcRow.codigo)) {
            const err = new Error(`Não é permitido conceder a permissão "${funcRow.codigo}" superior às suas próprias permissões.`);
            err.status = 403;
            throw err;
          }
          await tx.run(
            'INSERT INTO perfil_funcoes (empresa_id, perfil_id, funcao_id, permissao) VALUES (?, ?, ?, ?)',
            [req.auth.empresaId, perfilId, funcRow.id, (typeof item === 'object' && item.permissao) ? item.permissao : 'TOTAL']
          );
        }
      }

      return tx.get('SELECT * FROM perfis WHERE empresa_id = ? AND id = ?', [req.auth.empresaId, perfilId]);
    });

    await logAuditoria(db, req, {
      acao: 'ATUALIZAR_PERFIL',
      recurso: 'perfis',
      recursoId: perfilId
    });

    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erro ao atualizar perfil.' });
  }
});

app.delete('/api/perfis/:id', authenticateToken, requirePermission('ADMIN_PERFIS'), async (req, res) => {
  const perfilId = Number(req.params.id);
  try {
    const existing = await req.tenantDb.get(
      'SELECT * FROM perfis WHERE empresa_id = ? AND id = ? LIMIT 1',
      [req.auth.empresaId, perfilId]
    );
    if (!existing) {
      return res.status(404).json({ error: 'Perfil não encontrado.' });
    }
    if (Number(existing.sistema) === 1) {
      return res.status(400).json({ error: 'Perfis padrão do sistema não podem ser excluídos.' });
    }
    await req.tenantDb.run('DELETE FROM perfis WHERE empresa_id = ? AND id = ?', [req.auth.empresaId, perfilId]);
    await logAuditoria(db, req, { acao: 'EXCLUIR_PERFIL', recurso: 'perfis', recursoId: perfilId });
    res.json({ message: 'Perfil excluído com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir perfil.' });
  }
});

// Administração de usuários da empresa (restrita à própria empresa)
app.get('/api/usuarios', authenticateToken, requirePermission('ADMIN_USUARIOS'), async (req, res) => {
  try {
    const users = await req.tenantDb.all(
      `SELECT u.id, u.empresa_id, u.perfil_id, u.nome, u.email, u.role, u.ativo, u.created_at,
              p.nome AS perfil_nome
       FROM usuarios u
       LEFT JOIN perfis p ON p.empresa_id = u.empresa_id AND p.id = u.perfil_id
       WHERE u.empresa_id = ?
       ORDER BY u.id ASC`,
      [req.auth.empresaId]
    );
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar usuários da empresa.' });
  }
});

app.get('/api/usuarios/:id', authenticateToken, requirePermission('ADMIN_USUARIOS'), async (req, res, next) => {
  if (req.params.id === 'assinatura') return next();
  try {
    const user = await req.tenantDb.get(
      `SELECT u.id, u.empresa_id, u.perfil_id, u.nome, u.email, u.role, u.ativo, u.created_at,
              p.nome AS perfil_nome
       FROM usuarios u
       LEFT JOIN perfis p ON p.empresa_id = u.empresa_id AND p.id = u.perfil_id
       WHERE u.empresa_id = ? AND u.id = ?
       LIMIT 1`,
      [req.auth.empresaId, req.params.id]
    );
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar usuário.' });
  }
});

app.post('/api/usuarios', authenticateToken, requirePermission('ADMIN_USUARIOS'), async (req, res) => {
  const { nome, email, senha, role = 'user', perfil_id = null, ativo = 1 } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  }

  try {
    // Impede que não-admin crie um usuário admin
    const targetRole = String(role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';
    if (targetRole === 'admin' && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem conceder perfil de administrador.' });
    }

    // Se perfil_id foi informado, valida que pertence estritamente à mesma empresa autenticada
    let validPerfilId = null;
    if (perfil_id !== null && perfil_id !== undefined && perfil_id !== '') {
      const perfilRow = await req.tenantDb.get(
        'SELECT id, nome FROM perfis WHERE empresa_id = ? AND id = ? LIMIT 1',
        [req.auth.empresaId, Number(perfil_id)]
      );
      if (!perfilRow) {
        await logAuditoria(db, req, {
          acao: 'TENTATIVA_VINCULO_PERFIL_OUTRA_EMPRESA',
          recurso: 'usuarios',
          detalhes: { perfil_id }
        });
        return res.status(404).json({ error: 'Perfil de acesso não encontrado na empresa.' });
      }
      if (String(perfilRow.nome).toLowerCase() === 'administrador' && req.auth.role !== 'admin') {
        return res.status(403).json({ error: 'Não é permitido atribuir perfil com privilégios superiores aos seus.' });
      }
      validPerfilId = perfilRow.id;
    }

    const emailClean = String(email).trim().toLowerCase();
    const existingEmail = await db.get('SELECT id FROM usuarios WHERE LOWER(email) = ? LIMIT 1', [emailClean]);
    if (existingEmail) {
      return res.status(400).json({ error: 'Este endereço de e-mail já está em uso.' });
    }

    const hashed = await bcrypt.hash(String(senha), 10);
    const ins = await req.tenantDb.run(
      `INSERT INTO usuarios (empresa_id, perfil_id, nome, email, senha, role, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.auth.empresaId, validPerfilId, String(nome).trim(), emailClean, hashed, targetRole, Number(ativo) ? 1 : 0]
    );

    await logAuditoria(db, req, {
      acao: 'CRIAR_USUARIO',
      recurso: 'usuarios',
      recursoId: ins.lastID,
      detalhes: { email: emailClean, role: targetRole, perfil_id: validPerfilId }
    });

    const created = await req.tenantDb.get(
      'SELECT id, empresa_id, perfil_id, nome, email, role, ativo, created_at FROM usuarios WHERE empresa_id = ? AND id = ?',
      [req.auth.empresaId, ins.lastID]
    );
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao criar usuário.' });
  }
});

app.put('/api/usuarios/:id', authenticateToken, requirePermission('ADMIN_USUARIOS'), async (req, res, next) => {
  if (req.params.id === 'assinatura') return next();
  const targetUserId = Number(req.params.id);
  const { nome, email, senha, role, perfil_id, ativo } = req.body;

  try {
    const existing = await req.tenantDb.get(
      'SELECT * FROM usuarios WHERE empresa_id = ? AND id = ? LIMIT 1',
      [req.auth.empresaId, targetUserId]
    );
    if (!existing) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const newRole = role !== undefined ? (String(role).toLowerCase() === 'admin' ? 'admin' : 'user') : existing.role;
    if (newRole === 'admin' && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'Não é permitido conceder privilégio de administrador.' });
    }

    let validPerfilId = existing.perfil_id;
    if (perfil_id !== undefined) {
      if (perfil_id === null || perfil_id === '') {
        validPerfilId = null;
      } else {
        const perfilRow = await req.tenantDb.get(
          'SELECT id, nome FROM perfis WHERE empresa_id = ? AND id = ? LIMIT 1',
          [req.auth.empresaId, Number(perfil_id)]
        );
        if (!perfilRow) {
          await logAuditoria(db, req, {
            acao: 'TENTATIVA_ATRIBUIR_PERFIL_OUTRA_EMPRESA',
            recurso: 'usuarios',
            recursoId: targetUserId,
            detalhes: { perfil_id }
          });
          return res.status(404).json({ error: 'Perfil de acesso não encontrado na empresa.' });
        }
        if (String(perfilRow.nome).toLowerCase() === 'administrador' && req.auth.role !== 'admin') {
          return res.status(403).json({ error: 'Não é permitido conceder perfil com privilégios superiores aos seus.' });
        }
        validPerfilId = perfilRow.id;
      }
    }

    const newEmail = email !== undefined ? String(email).trim().toLowerCase() : existing.email;
    if (newEmail !== existing.email.toLowerCase()) {
      const dup = await db.get('SELECT id FROM usuarios WHERE LOWER(email) = ? AND id <> ? LIMIT 1', [newEmail, targetUserId]);
      if (dup) {
        return res.status(400).json({ error: 'Este endereço de e-mail já está em uso.' });
      }
    }

    const newNome = nome !== undefined ? String(nome).trim() : existing.nome;
    const newAtivo = ativo !== undefined ? (Number(ativo) ? 1 : 0) : existing.ativo;
    const newSenha = (senha && String(senha).trim().length > 0)
      ? await bcrypt.hash(String(senha), 10)
      : existing.senha;

    await req.tenantDb.run(
      `UPDATE usuarios
       SET nome = ?, email = ?, senha = ?, role = ?, perfil_id = ?, ativo = ?
       WHERE empresa_id = ? AND id = ?`,
      [newNome, newEmail, newSenha, newRole, validPerfilId, newAtivo, req.auth.empresaId, targetUserId]
    );

    await logAuditoria(db, req, {
      acao: 'ATUALIZAR_USUARIO',
      recurso: 'usuarios',
      recursoId: targetUserId,
      detalhes: { role: newRole, perfil_id: validPerfilId, ativo: newAtivo }
    });

    const updated = await req.tenantDb.get(
      'SELECT id, empresa_id, perfil_id, nome, email, role, ativo, created_at FROM usuarios WHERE empresa_id = ? AND id = ?',
      [req.auth.empresaId, targetUserId]
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao atualizar usuário.' });
  }
});

app.delete('/api/usuarios/:id', authenticateToken, requirePermission('ADMIN_USUARIOS'), async (req, res) => {
  const targetUserId = Number(req.params.id);
  if (targetUserId === req.auth.userId) {
    return res.status(400).json({ error: 'Não é permitido excluir o próprio usuário autenticado.' });
  }
  try {
    const result = await req.tenantDb.run(
      'DELETE FROM usuarios WHERE empresa_id = ? AND id = ?',
      [req.auth.empresaId, targetUserId]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    await logAuditoria(db, req, { acao: 'EXCLUIR_USUARIO', recurso: 'usuarios', recursoId: targetUserId });
    res.json({ message: 'Usuário excluído com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir usuário.' });
  }
});

// 2. Dashboard Stats Route (isolada por empresa_id)
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const empId = req.auth.empresaId;
    const clientsCount = await req.tenantDb.get('SELECT COUNT(*) as count FROM clientes WHERE empresa_id = ? AND status = "Ativo"', [empId]);
    const totalRevenue = await req.tenantDb.get('SELECT SUM(valor) as total FROM contratos WHERE empresa_id = ? AND status = "Ativo"', [empId]);
    const contractsCount = await req.tenantDb.get('SELECT COUNT(*) as count FROM contratos WHERE empresa_id = ?', [empId]);
    const inactiveClients = await req.tenantDb.get('SELECT COUNT(*) as count FROM clientes WHERE empresa_id = ? AND status = "Inativo"', [empId]);

    res.json({
      clientesAtivos: Number(clientsCount?.count || 0),
      clientesInativos: Number(inactiveClients?.count || 0),
      faturamentoMensal: Number(totalRevenue?.total || 0),
      totalContratos: Number(contractsCount?.count || 0)
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar estatísticas do painel.' });
  }
});

// 3. Clients Routes (isoladas por empresa_id)
app.get('/api/clientes', authenticateToken, async (req, res) => {
  try {
    const empId = req.auth.empresaId;
    const { busca, status } = req.query;
    let sql = 'SELECT * FROM clientes WHERE empresa_id = ?';
    const params = [empId];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (busca) {
      sql += ' AND (nome LIKE ? OR documento LIKE ? OR email LIKE ?)';
      params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
    }
    sql += ' ORDER BY nome ASC';
    const list = await req.tenantDb.all(sql, params);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar clientes.' });
  }
});

app.get('/api/clientes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const client = await req.tenantDb.get('SELECT * FROM clientes WHERE empresa_id = ? AND id = ?', [req.auth.empresaId, id]);
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
  const { nome, documento, email, telefone, status, tipo_pessoa, cidade, uf } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'O nome do cliente é obrigatório.' });
  }

  try {
    const empId = req.auth.empresaId;
    const result = await req.tenantDb.run(
      'INSERT INTO clientes (empresa_id, nome, documento, email, telefone, status, tipo_pessoa, cidade, uf) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [empId, nome.trim(), documento || null, email || null, telefone || null, status || 'Ativo', tipo_pessoa || 'Física', cidade || null, uf || null]
    );
    const newClient = await req.tenantDb.get('SELECT * FROM clientes WHERE empresa_id = ? AND id = ?', [empId, result.lastID]);
    res.status(201).json(newClient);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || (error.message && (error.message.includes('UNIQUE constraint failed') || error.message.includes('Duplicate entry')))) {
      return res.status(400).json({ error: 'Documento ou email já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro ao cadastrar cliente.' });
  }
});

app.put('/api/clientes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { 
    nome, documento, email, telefone, status, tipo_pessoa,
    rg, endereco, numero, complemento, bairro, cidade, uf, cep,
    entrega_endereco, entrega_numero, entrega_complemento, entrega_bairro, entrega_cidade, entrega_uf, entrega_cep
  } = req.body;

  try {
    const empId = req.auth.empresaId;
    const client = await req.tenantDb.get('SELECT * FROM clientes WHERE empresa_id = ? AND id = ?', [empId, id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    await req.tenantDb.run(`
      UPDATE clientes 
      SET 
        nome = ?, documento = ?, email = ?, telefone = ?, status = ?, tipo_pessoa = ?,
        rg = ?, endereco = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, cep = ?,
        entrega_endereco = ?, entrega_numero = ?, entrega_complemento = ?, entrega_bairro = ?, entrega_cidade = ?, entrega_uf = ?, entrega_cep = ?
      WHERE empresa_id = ? AND id = ?
    `, [
      nome !== undefined ? nome : client.nome,
      documento !== undefined ? documento : client.documento,
      email !== undefined ? email : client.email,
      telefone !== undefined ? telefone : client.telefone,
      status !== undefined ? status : client.status,
      tipo_pessoa !== undefined ? tipo_pessoa : (client.tipo_pessoa || 'Física'),
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
      empId,
      id
    ]);

    const updatedClient = await req.tenantDb.get('SELECT * FROM clientes WHERE empresa_id = ? AND id = ?', [empId, id]);
    res.json(updatedClient);
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Erro ao atualizar cliente.' });
  }
});

app.delete('/api/clientes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const empId = req.auth.empresaId;
    const result = await req.tenantDb.run('DELETE FROM clientes WHERE empresa_id = ? AND id = ?', [empId, id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    res.json({ message: 'Cliente removido com sucesso.' });
  } catch (error) {
    if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) {
      return res.status(400).json({ error: 'Não é possível excluir cliente com orçamentos ou contratos vinculados.' });
    }
    res.status(500).json({ error: 'Erro ao excluir cliente.' });
  }
});

// 4. Contracts Routes (isoladas por empresa_id)
app.get('/api/contratos', authenticateToken, async (req, res) => {
  try {
    const empId = req.auth.empresaId;
    const list = await req.tenantDb.all(`
      SELECT contratos.*, clientes.nome as cliente_nome 
      FROM contratos 
      INNER JOIN clientes ON contratos.empresa_id = clientes.empresa_id AND contratos.cliente_id = clientes.id 
      WHERE contratos.empresa_id = ?
      ORDER BY contratos.created_at DESC
    `, [empId]);
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

  try {
    const empId = req.auth.empresaId;
    // Valida que o cliente pertence à mesma empresa autenticada
    const clientOwned = await req.tenantDb.get(
      'SELECT id FROM clientes WHERE empresa_id = ? AND id = ? LIMIT 1',
      [empId, cliente_id]
    );
    if (!clientOwned) {
      await logAuditoria(db, req, {
        acao: 'TENTATIVA_VINCULO_CLIENTE_OUTRA_EMPRESA',
        recurso: 'contratos',
        detalhes: { cliente_id, numero }
      });
      return res.status(404).json({ error: 'Cliente informado não encontrado na empresa.' });
    }

    let drive_file_id = null;
    if (req.file) {
      drive_file_id = `GD_EMP${empId}_${Date.now()}`;
    }

    const result = await req.tenantDb.run(
      'INSERT INTO contratos (empresa_id, cliente_id, numero, valor, data_inicio, data_fim, status, drive_file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [empId, cliente_id, numero, parseFloat(valor), data_inicio, data_fim, status || 'Ativo', drive_file_id]
    );

    const newContract = await req.tenantDb.get('SELECT * FROM contratos WHERE empresa_id = ? AND id = ?', [empId, result.lastID]);
    res.status(201).json(newContract);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || (error.message && (error.message.includes('UNIQUE constraint failed') || error.message.includes('Duplicate entry')))) {
      return res.status(400).json({ error: 'Número de contrato já existente nesta empresa.' });
    }
    res.status(500).json({ error: 'Erro ao cadastrar contrato.' });
  }
});

app.put('/api/contratos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { valor, status, data_fim } = req.body;

  try {
    const empId = req.auth.empresaId;
    const contract = await req.tenantDb.get('SELECT * FROM contratos WHERE empresa_id = ? AND id = ?', [empId, id]);
    if (!contract) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }

    await req.tenantDb.run(
      'UPDATE contratos SET valor = ?, status = ?, data_fim = ? WHERE empresa_id = ? AND id = ?',
      [valor !== undefined ? parseFloat(valor) : contract.valor, status || contract.status, data_fim || contract.data_fim, empId, id]
    );

    const updatedContract = await req.tenantDb.get('SELECT * FROM contratos WHERE empresa_id = ? AND id = ?', [empId, id]);
    res.json(updatedContract);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar contrato.' });
  }
});

app.delete('/api/contratos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const empId = req.auth.empresaId;
    const result = await req.tenantDb.run('DELETE FROM contratos WHERE empresa_id = ? AND id = ?', [empId, id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }
    res.json({ message: 'Contrato removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir contrato.' });
  }
});

// 5. Services Routes (isoladas por empresa_id)
app.get('/api/servicos', authenticateToken, async (req, res) => {
  try {
    const list = await req.tenantDb.all(
      'SELECT * FROM servicos WHERE empresa_id = ? ORDER BY sequencia ASC, nome ASC',
      [req.auth.empresaId]
    );
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
    const empId = req.auth.empresaId;
    const result = await req.tenantDb.run(
      'INSERT INTO servicos (empresa_id, nome, unidade, tempo, sequencia) VALUES (?, ?, ?, ?, ?)',
      [empId, nome, parseInt(unidade), parseInt(tempo), sequencia !== undefined ? parseInt(sequencia) : 0]
    );
    const newService = await req.tenantDb.get('SELECT * FROM servicos WHERE empresa_id = ? AND id = ?', [empId, result.lastID]);
    res.status(201).json(newService);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cadastrar serviço.' });
  }
});

app.put('/api/servicos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { nome, unidade, tempo, sequencia } = req.body;

  try {
    const empId = req.auth.empresaId;
    const service = await req.tenantDb.get('SELECT * FROM servicos WHERE empresa_id = ? AND id = ?', [empId, id]);
    if (!service) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }

    await req.tenantDb.run(
      'UPDATE servicos SET nome = ?, unidade = ?, tempo = ?, sequencia = ? WHERE empresa_id = ? AND id = ?',
      [
        nome || service.nome,
        unidade !== undefined ? parseInt(unidade) : service.unidade,
        tempo !== undefined ? parseInt(tempo) : service.tempo,
        sequencia !== undefined ? parseInt(sequencia) : service.sequencia,
        empId,
        id
      ]
    );

    const updatedService = await req.tenantDb.get('SELECT * FROM servicos WHERE empresa_id = ? AND id = ?', [empId, id]);
    res.json(updatedService);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar serviço.' });
  }
});

app.delete('/api/servicos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const empId = req.auth.empresaId;
    const result = await req.tenantDb.run('DELETE FROM servicos WHERE empresa_id = ? AND id = ?', [empId, id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }
    res.json({ message: 'Serviço removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir serviço.' });
  }
});

// 5.2. Product (Produtos / Material) Routes (isoladas por empresa_id)
app.get('/api/produtos', authenticateToken, async (req, res) => {
  try {
    const empId = req.auth.empresaId;
    const list = await req.tenantDb.all(`
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
      WHERE empresa_id = ?
      ORDER BY MaterialDescricao ASC
    `, [empId]);

    let servicosList = [];
    try {
      servicosList = await req.tenantDb.all(
        'SELECT id, nome, sequencia FROM servicos WHERE empresa_id = ? ORDER BY sequencia ASC, nome ASC',
        [empId]
      );
    } catch (e) {
      servicosList = [];
    }

    const normalize = (str) => (str || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .trim();

    const enriched = list.map(p => {
      if (p.tipo !== 'Serviço' && !p.codigo?.startsWith('FAB.')) {
        return { ...p, sequencia: null };
      }
      const pNomeNorm = normalize(p.nome);
      const pCodNorm = normalize(p.codigo);

      const matched = servicosList.find(s => {
        const sNomeNorm = normalize(s.nome);
        if (sNomeNorm === pNomeNorm) return true;
        if (pNomeNorm.includes(sNomeNorm) || sNomeNorm.includes(pNomeNorm)) return true;
        if ((pCodNorm.includes('cor') || pCodNorm.includes('sep') || pNomeNorm.includes('corte') || pNomeNorm.includes('separacao')) && (sNomeNorm.includes('separacao') || sNomeNorm.includes('corte'))) return true;
        if ((pCodNorm.includes('usi') || pNomeNorm.includes('usinagem')) && sNomeNorm.includes('usinagem')) return true;
        if ((pCodNorm.includes('fit') || pNomeNorm.includes('fitagem')) && sNomeNorm.includes('fitagem')) return true;
        if ((pCodNorm.includes('mon') || pNomeNorm.includes('montagem')) && (sNomeNorm.includes('montagem de caixa') || sNomeNorm.includes('montagem'))) return true;
        if ((pCodNorm.includes('esp') || pNomeNorm.includes('especial')) && sNomeNorm.includes('especial')) return true;
        if ((pCodNorm.includes('emb') || pNomeNorm.includes('embalagem')) && sNomeNorm.includes('embalagem')) return true;
        return false;
      });

      return {
        ...p,
        sequencia: matched && matched.sequencia !== undefined ? matched.sequencia : 999
      };
    });

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar produtos.' });
  }
});

app.post('/api/produtos', authenticateToken, upload.single('imagem'), async (req, res) => {
  const codigo = req.body.codigo || req.body.MaterialReferencia;
  const nome = req.body.nome || req.body.MaterialDescricao;
  const preco = req.body.preco !== undefined ? req.body.preco : req.body.MaterialValorUnitario;
  const unidade = req.body.unidade || req.body.MaterialUnidade;
  const { tipo, tempo, ExibirNaProposta, ProdutoGrupo, produtoGrupo } = req.body;
  if (!codigo || !nome || !unidade) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({ error: 'Código, nome e unidade são obrigatórios.' });
  }

  let normUn = (unidade || '').toUpperCase().trim();
  if (normUn === 'UN') normUn = 'UNI';
  const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
  if (!allowedUnits.includes(normUn)) {
    normUn = 'UNI';
  }

  let normTipo = (tipo || 'Produto').trim();
  if (normTipo !== 'Serviço') normTipo = 'Produto';

  const tempoVal = normTipo === 'Serviço' ? (parseInt(tempo, 10) || 0) : 0;
  const normExibir = (ExibirNaProposta === 'Sim' || ExibirNaProposta === true || ExibirNaProposta === 'true' || ExibirNaProposta === '1') ? 'Sim' : 'Nao';

  const rawGrupo = ProdutoGrupo !== undefined ? ProdutoGrupo : produtoGrupo;
  let grupoVal = parseInt(rawGrupo, 10);
  if (isNaN(grupoVal) || grupoVal < 1 || grupoVal > 8) {
    grupoVal = 8;
  }

  const imagem = req.file ? (req.file.tenantRelPath || `uploads/empresa_${req.auth.empresaId}/produtos/${req.file.filename}`) : null;

  try {
    const empId = req.auth.empresaId;
    const existing = await req.tenantDb.get(
      'SELECT MaterialReferencia FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?',
      [empId, codigo]
    );
    if (existing) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: 'Já existe um produto cadastrado com este código na sua empresa.' });
    }

    await req.tenantDb.run(
      `INSERT INTO Material (empresa_id, MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialImagem, MaterialTempo, ExibirNaProposta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [empId, codigo, nome, normUn, parseFloat(preco) || 0.0, null, grupoVal, normTipo, imagem, tempoVal, normExibir]
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
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Erro ao criar produto.' });
  }
});

app.put('/api/produtos/:id', authenticateToken, upload.single('imagem'), async (req, res) => {
  const { id } = req.params; // MaterialReferencia
  const { nome, preco, unidade, tipo, tempo, ExibirNaProposta, ProdutoGrupo, produtoGrupo } = req.body;

  try {
    const empId = req.auth.empresaId;
    const product = await req.tenantDb.get(
      'SELECT * FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?',
      [empId, id]
    );
    if (!product) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    let normUn = (unidade || '').toUpperCase().trim();
    if (normUn === 'UN') normUn = 'UNI';
    const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
    if (!allowedUnits.includes(normUn)) {
      normUn = 'UNI';
    }

    let normTipo = (tipo || product.MaterialTipo || 'Produto').trim();
    if (normTipo !== 'Serviço') normTipo = 'Produto';

    const tempoVal = normTipo === 'Serviço' ? (parseInt(tempo, 10) || 0) : 0;
    const normExibir = ExibirNaProposta !== undefined 
      ? ((ExibirNaProposta === 'Sim' || ExibirNaProposta === true || ExibirNaProposta === 'true' || ExibirNaProposta === '1') ? 'Sim' : 'Nao')
      : (product.ExibirNaProposta || 'Nao');

    const rawGrupo = ProdutoGrupo !== undefined ? ProdutoGrupo : produtoGrupo;
    let grupoVal;
    if (rawGrupo !== undefined && rawGrupo !== null && rawGrupo !== '') {
      const parsed = parseInt(rawGrupo, 10);
      grupoVal = (!isNaN(parsed) && parsed >= 1 && parsed <= 8) ? parsed : 8;
    } else {
      grupoVal = product.ProdutoGrupo || 8;
    }

    let imagem = product.MaterialImagem;
    if (req.file) {
      imagem = req.file.tenantRelPath || `uploads/empresa_${empId}/produtos/${req.file.filename}`;
      if (product.MaterialImagem) {
        const oldPath = getUploadPhysicalPath(product.MaterialImagem);
        if (oldPath && fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    }

    await req.tenantDb.run(
      `UPDATE Material 
       SET MaterialDescricao = ?, MaterialUnidade = ?, MaterialValorUnitario = ?, MaterialTipo = ?, MaterialImagem = ?, MaterialTempo = ?, ExibirNaProposta = ?, ProdutoGrupo = ?
       WHERE empresa_id = ? AND MaterialReferencia = ?`,
      [nome, normUn, parseFloat(preco) || 0.0, normTipo, imagem, tempoVal, normExibir, grupoVal, empId, id]
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
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Erro ao atualizar produto.' });
  }
});

app.delete('/api/produtos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params; // MaterialReferencia
  try {
    const empId = req.auth.empresaId;
    const product = await req.tenantDb.get(
      'SELECT * FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?',
      [empId, id]
    );
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    // Verificar se o produto está vinculado a algum item de projeto da própria empresa
    const linkedProjects = await req.tenantDb.all(`
      SELECT DISTINCT p.id, p.nome 
      FROM ProjetoItem pi 
      INNER JOIN projetos p ON pi.empresa_id = p.empresa_id AND pi.ProjetoID = p.id 
      WHERE pi.empresa_id = ? AND pi.MaterialReferencia = ?
    `, [empId, id]);

    if (linkedProjects && linkedProjects.length > 0) {
      const projectNames = linkedProjects.map(p => `"${p.nome}" (ID: ${p.id})`).join(', ');
      return res.status(400).json({ 
        error: `Não é possível excluir o produto "${id}" pois ele está em uso no(s) projeto(s): ${projectNames}. Remova o item do projeto antes de excluí-lo do catálogo.` 
      });
    }

    if (product.MaterialImagem && typeof product.MaterialImagem === 'string' && !product.MaterialImagem.startsWith('data:')) {
      try {
        const imgPath = getUploadPhysicalPath(product.MaterialImagem);
        if (imgPath && fs.existsSync(imgPath)) {
          fs.unlinkSync(imgPath);
        }
      } catch (imgErr) {
        console.warn('Erro ao remover arquivo de imagem do produto:', imgErr.message);
      }
    }

    try {
      await req.tenantDb.run('DELETE FROM Projeto_Materiais WHERE empresa_id = ? AND referencia = ?', [empId, id]);
    } catch (e) {}

    await req.tenantDb.run('DELETE FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?', [empId, id]);
    res.json({ message: 'Produto removido com sucesso.' });
  } catch (error) {
    console.error('DELETE PRODUCT ERROR:', error);
    if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) {
      return res.status(400).json({ 
        error: `Não é possível excluir o produto "${id}" pois ele possui vínculos ativos no banco de dados.` 
      });
    }
    res.status(500).json({ error: error.message || 'Erro ao excluir produto.' });
  }
});

// Rotas: Ordem_Servico (isoladas por empresa_id)
async function handleGetOrdemServico(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { situacao, busca } = req.query;
    let query = `
      SELECT 
        os.Numero, 
        os.ProjetoID,
        os.NomeProjeto,
        os.Tempo,
        os.DataCriacao, 
        os.DataConclusao, 
        os.Situacao, 
        os.Responsavel,
        o.descricao AS orcamento_descricao,
        o.total_venda AS orcamento_total,
        c.nome AS cliente_nome
      FROM Ordem_Servico os
      LEFT JOIN orcamentos o ON os.empresa_id = o.empresa_id AND os.Numero = o.numero
      LEFT JOIN clientes c ON o.empresa_id = c.empresa_id AND o.cliente_id = c.id
      WHERE os.empresa_id = ?
    `;
    const params = [empId];

    if (situacao && situacao !== 'TODAS' && situacao !== 'Todos') {
      query += ' AND os.Situacao = ?';
      params.push(situacao);
    }

    if (busca) {
      query += ' AND (os.Numero LIKE ? OR os.Responsavel LIKE ? OR c.nome LIKE ? OR o.descricao LIKE ? OR os.NomeProjeto LIKE ?)';
      params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`, `%${busca}%`, `%${busca}%`);
    }

    query += ' ORDER BY os.Numero DESC, os.ProjetoID ASC';

    const items = await req.tenantDb.all(query, params);
    res.json(items);
  } catch (error) {
    console.error('GET ORDEM SERVICO ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar ordens de serviço.' });
  }
}

app.get('/api/ordem-servico', authenticateToken, handleGetOrdemServico);
app.get('/api/ordem-controle', authenticateToken, handleGetOrdemServico);

async function handleGetOrdemServicoById(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { numero } = req.params;
    const { projetoId } = req.query;
    
    if (projetoId !== undefined && projetoId !== null && projetoId !== '') {
      const item = await req.tenantDb.get(
        'SELECT Numero, ProjetoID, NomeProjeto, Tempo, DataCriacao, DataConclusao, Situacao, Responsavel FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
        [empId, numero, projetoId]
      );
      if (!item) {
        return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
      }
      return res.json(item);
    }

    const items = await req.tenantDb.all(
      'SELECT Numero, ProjetoID, NomeProjeto, Tempo, DataCriacao, DataConclusao, Situacao, Responsavel FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? ORDER BY ProjetoID ASC',
      [empId, numero]
    );
    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }
    res.json(items[0]);
  } catch (error) {
    console.error('GET ORDEM SERVICO BY ID ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar ordem de serviço.' });
  }
}

app.get('/api/ordem-servico/:numero', authenticateToken, handleGetOrdemServicoById);
app.get('/api/ordem-controle/:numero', authenticateToken, handleGetOrdemServicoById);

async function handlePostOrdemServico(req, res) {
  try {
    const empId = req.auth.empresaId;
    let { Numero, ProjetoID, DataCriacao, DataConclusao, Situacao, Responsavel, NomeProjeto, Tempo } = req.body;

    if (!Numero) {
      const maxRow = await req.tenantDb.get('SELECT MAX(Numero) as maxNum FROM Ordem_Servico WHERE empresa_id = ?', [empId]);
      Numero = (maxRow && maxRow.maxNum ? maxRow.maxNum : 0) + 1;
    }

    if (!ProjetoID) {
      const maxProjRow = await req.tenantDb.get(
        'SELECT MAX(ProjetoID) as maxProj FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ?',
        [empId, Numero]
      );
      ProjetoID = (maxProjRow && maxProjRow.maxProj ? parseInt(maxProjRow.maxProj, 10) : 0) + 1;
    }

    const situacaoVal = Situacao || 'Aberta';
    const responsavelVal = Responsavel || req.user?.email || req.user?.nome || null;
    const dataCriacaoVal = DataCriacao || new Date().toISOString().split('T')[0];
    const dataConclusaoVal = DataConclusao || null;
    const nomeProjVal = NomeProjeto || null;
    const tempoVal = parseInt(Tempo, 10) || 0;

    await req.tenantDb.run(
      'INSERT INTO Ordem_Servico (empresa_id, Numero, ProjetoID, DataCriacao, DataConclusao, Situacao, Responsavel, NomeProjeto, Tempo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [empId, Numero, ProjetoID, dataCriacaoVal, dataConclusaoVal, situacaoVal, responsavelVal, nomeProjVal, tempoVal]
    );

    const created = await req.tenantDb.get(
      'SELECT * FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [empId, Numero, ProjetoID]
    );
    res.status(201).json(created);
  } catch (error) {
    console.error('CREATE ORDEM SERVICO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar ordem de serviço.' });
  }
}

app.post('/api/ordem-servico', authenticateToken, handlePostOrdemServico);
app.post('/api/ordem-controle', authenticateToken, handlePostOrdemServico);

async function handlePutOrdemServico(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { numero } = req.params;
    const projetoId = req.query.projetoId || req.body.ProjetoID || req.body.projetoId;
    
    let existing;
    if (projetoId !== undefined && projetoId !== null && projetoId !== '') {
      existing = await req.tenantDb.get(
        'SELECT * FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
        [empId, numero, projetoId]
      );
    } else {
      existing = await req.tenantDb.get(
        'SELECT * FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? ORDER BY ProjetoID ASC LIMIT 1',
        [empId, numero]
      );
    }

    if (!existing) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    const targetProjId = existing.ProjetoID;
    const { DataCriacao, DataConclusao, Situacao, Responsavel, NomeProjeto, Tempo } = req.body;

    await req.tenantDb.run(
      'UPDATE Ordem_Servico SET DataCriacao = ?, DataConclusao = ?, Situacao = ?, Responsavel = ?, NomeProjeto = ?, Tempo = ? WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [
        DataCriacao !== undefined ? DataCriacao : existing.DataCriacao,
        DataConclusao !== undefined ? DataConclusao : existing.DataConclusao,
        Situacao !== undefined ? Situacao : existing.Situacao,
        Responsavel !== undefined ? Responsavel : existing.Responsavel,
        NomeProjeto !== undefined ? NomeProjeto : existing.NomeProjeto,
        Tempo !== undefined ? parseInt(Tempo, 10) : existing.Tempo,
        empId,
        numero,
        targetProjId
      ]
    );

    const updated = await req.tenantDb.get(
      'SELECT * FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [empId, numero, targetProjId]
    );
    res.json(updated);
  } catch (error) {
    console.error('UPDATE ORDEM SERVICO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar ordem de serviço.' });
  }
}

app.put('/api/ordem-servico/:numero', authenticateToken, handlePutOrdemServico);
app.put('/api/ordem-controle/:numero', authenticateToken, handlePutOrdemServico);

async function handleDeleteOrdemServico(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { numero } = req.params;
    const projetoId = req.query.projetoId || req.body?.ProjetoID || req.body?.projetoId;

    if (projetoId !== undefined && projetoId !== null && projetoId !== '') {
      const result = await req.tenantDb.run(
        'DELETE FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
        [empId, numero, projetoId]
      );
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
      }
    } else {
      const result = await req.tenantDb.run(
        'DELETE FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ?',
        [empId, numero]
      );
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
      }
    }

    res.json({ message: 'Ordem de serviço excluída com sucesso.' });
  } catch (error) {
    console.error('DELETE ORDEM SERVICO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir ordem de serviço.' });
  }
}

app.delete('/api/ordem-servico/:numero', authenticateToken, handleDeleteOrdemServico);
app.delete('/api/ordem-controle/:numero', authenticateToken, handleDeleteOrdemServico);

// ==========================================
// ROTAS: Revisão Técnica da Ordem de Serviço (isoladas por empresa_id)
// ==========================================
async function handleGetRevisaoTecnica(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { numero, projetoId: paramProjId } = req.params;
    const queryProjId = req.query.projetoId || req.query.item;
    const targetProjId = paramProjId !== undefined ? paramProjId : (queryProjId || 1);

    // 1. Ordem de Serviço
    let os = await req.tenantDb.get(
      'SELECT Numero, ProjetoID, NomeProjeto, Tempo, DataCriacao, DataConclusao, Situacao, Responsavel FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [empId, numero, targetProjId]
    );

    if (!os) {
      os = await req.tenantDb.get(
        'SELECT Numero, ProjetoID, NomeProjeto, Tempo, DataCriacao, DataConclusao, Situacao, Responsavel FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? ORDER BY ProjetoID ASC LIMIT 1',
        [empId, numero]
      );
    }

    if (!os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    // 2. Orçamento com dados do cliente
    const orcamento = await req.tenantDb.get(`
      SELECT 
        o.numero,
        o.data_criacao,
        o.cliente_id,
        o.descricao,
        COALESCE(o.status, 'Em Aberto') as status,
        o.parametro_financeiro_id,
        o.total_venda,
        o.forma_pagamento_selecionada,
        c.nome as cliente_nome,
        c.telefone as cliente_telefone,
        c.documento as cliente_documento,
        c.email as cliente_email,
        c.cidade as cliente_cidade,
        c.uf as cliente_uf
      FROM orcamentos o
      LEFT JOIN clientes c ON o.empresa_id = c.empresa_id AND o.cliente_id = c.id
      WHERE o.empresa_id = ? AND o.numero = ?
    `, [empId, numero]);

    // 3. Todos os projetos do orçamento da mesma empresa
    const projetos = await req.tenantDb.all(
      'SELECT * FROM projetos WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY id ASC',
      [empId, numero]
    );

    // 4. Selecionar projeto correspondente ao item da OS
    let matchedProject = null;
    if (projetos && projetos.length > 0) {
      if (os.NomeProjeto) {
        const osNomeNorm = os.NomeProjeto.trim().toLowerCase();
        matchedProject = projetos.find(p => p.nome && p.nome.trim().toLowerCase() === osNomeNorm);
      }
      if (!matchedProject) {
        const idx = (parseInt(os.ProjetoID, 10) || 1) - 1;
        if (idx >= 0 && idx < projetos.length) {
          matchedProject = projetos[idx];
        }
      }
      if (!matchedProject) {
        matchedProject = projetos[0];
      }
    }

    // 5. Itens e Anexos do Projeto
    let itens = [];
    let anexos = [];

    if (matchedProject && matchedProject.id) {
      await ensureProjetoItemsPopulated(matchedProject.id, empId);

      const rawItens = await req.tenantDb.all(`
        SELECT 
          pi.ProjetoID,
          pi.ProjetoItemID,
          pi.MaterialReferencia,
          m.MaterialDescricao,
          m.MaterialTipo,
          pi.ProjetoItemQtd,
          pi.ProjetoItemUnidade,
          pi.ProjetoItemVlrUnit,
          pi.ProjetoItemTotal,
          pi.ProjetoItemTempo,
          pi.ProjetoItemDuracao,
          COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
          m.MaterialImagem,
          COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta
        FROM ProjetoItem pi
        LEFT JOIN Material m ON pi.empresa_id = m.empresa_id AND pi.MaterialReferencia = m.MaterialReferencia
        WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
        ORDER BY pi.ProjetoItemID ASC
      `, [empId, matchedProject.id]);

      itens = await enrichProjectItemsWithServicoSequencia(rawItens, empId);
      anexos = await req.tenantDb.all(
        'SELECT * FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ? ORDER BY criado_em DESC',
        [empId, matchedProject.id]
      );
    }

    // 6. Checklist salvo da Ordem de Serviço
    const checklist = await req.tenantDb.all(
      'SELECT id, numero, projeto_id, tarefa_key, tarefa_texto, concluido, data_conclusao, responsavel, observacao, updated_at FROM ordem_servico_checklist WHERE empresa_id = ? AND numero = ? AND projeto_id = ? ORDER BY tarefa_key ASC, id ASC',
      [empId, numero, os.ProjetoID]
    );

    res.json({
      ordemServico: os,
      orcamento,
      projeto: matchedProject,
      projetos,
      anexos,
      itens,
      checklist
    });
  } catch (error) {
    console.error('GET REVISAO TECNICA ERROR:', error);
    res.status(500).json({ error: 'Erro ao carregar dados da revisão técnica.' });
  }
}

async function handlePutRevisaoChecklist(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { numero, projetoId: paramProjId } = req.params;
    const queryProjId = req.query.projetoId || req.body.projeto_id || req.body.ProjetoID;
    const targetProjId = paramProjId !== undefined ? paramProjId : (queryProjId || 1);
    const responsavelPadrao = req.user?.nome || req.user?.email || 'Usuário';

    // Confirma que a OS pertence à empresa autenticada antes de gravar o checklist
    const osExists = await req.tenantDb.get(
      'SELECT Numero, ProjetoID FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [empId, numero, targetProjId]
    );
    if (!osExists) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    const formatDateTimeForSql = (val) => {
      if (!val) return null;
      const d = new Date(val);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 19).replace('T', ' ');
    };

    let tarefas = [];
    if (Array.isArray(req.body.tarefas)) {
      tarefas = req.body.tarefas;
    } else if (req.body.tarefa_key) {
      tarefas = [req.body];
    } else {
      return res.status(400).json({ error: 'Nenhuma tarefa informada para atualização.' });
    }

    for (const t of tarefas) {
      const { tarefa_key, tarefa_texto, concluido, observacao } = t;
      if (!tarefa_key) continue;

      const isConcluido = (concluido === 1 || concluido === true || concluido === '1') ? 1 : 0;
      const dataConclusao = isConcluido ? formatDateTimeForSql(t.data_conclusao || new Date()) : null;
      const resp = t.responsavel || (isConcluido ? responsavelPadrao : null);
      const texto = tarefa_texto || '';
      const obs = observacao !== undefined ? observacao : null;

      await req.tenantDb.run(`
        INSERT INTO ordem_servico_checklist 
          (empresa_id, numero, projeto_id, tarefa_key, tarefa_texto, concluido, data_conclusao, responsavel, observacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          tarefa_texto = COALESCE(VALUES(tarefa_texto), tarefa_texto),
          concluido = VALUES(concluido),
          data_conclusao = VALUES(data_conclusao),
          responsavel = VALUES(responsavel),
          observacao = COALESCE(VALUES(observacao), observacao),
          updated_at = CURRENT_TIMESTAMP
      `, [empId, numero, targetProjId, tarefa_key, texto, isConcluido, dataConclusao, resp, obs]);
    }

    const updatedChecklist = await req.tenantDb.all(
      'SELECT id, numero, projeto_id, tarefa_key, tarefa_texto, concluido, data_conclusao, responsavel, observacao, updated_at FROM ordem_servico_checklist WHERE empresa_id = ? AND numero = ? AND projeto_id = ? ORDER BY tarefa_key ASC, id ASC',
      [empId, numero, targetProjId]
    );

    res.json({
      success: true,
      message: 'Check-list da revisão técnica atualizado com sucesso.',
      checklist: updatedChecklist
    });
  } catch (error) {
    console.error('PUT REVISAO CHECKLIST ERROR:', error);
    res.status(500).json({ error: 'Erro ao salvar check-list da revisão técnica.' });
  }
}

async function handlePutSituacaoOrdemServico(req, res) {
  try {
    const empId = req.auth.empresaId;
    const { numero, projetoId } = req.params;
    const { Situacao, situacao, Responsavel, responsavel } = req.body;
    const novaSituacao = Situacao || situacao;
    if (!novaSituacao) {
      return res.status(400).json({ error: 'Situação é obrigatória.' });
    }

    const existing = await req.tenantDb.get(
      'SELECT * FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [empId, numero, projetoId]
    );
    if (!existing) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    const dataConclusao = novaSituacao === 'Concluida' ? new Date().toISOString().split('T')[0] : null;
    const resp = Responsavel || responsavel;

    let query = 'UPDATE Ordem_Servico SET Situacao = ?, DataConclusao = ?';
    const params = [novaSituacao, dataConclusao];

    if (resp) {
      query += ', Responsavel = ?';
      params.push(resp);
    }

    query += ' WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?';
    params.push(empId, numero, projetoId);

    await req.tenantDb.run(query, params);

    const updated = await req.tenantDb.get(
      'SELECT * FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
      [empId, numero, projetoId]
    );
    res.json({ success: true, item: updated });
  } catch (error) {
    console.error('PUT SITUACAO OS ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar situação da ordem de serviço.' });
  }
}

app.get('/api/ordem-servico/:numero/:projetoId/revisao', authenticateToken, handleGetRevisaoTecnica);
app.get('/api/ordem-servico/:numero/revisao', authenticateToken, handleGetRevisaoTecnica);
app.put('/api/ordem-servico/:numero/:projetoId/checklist', authenticateToken, handlePutRevisaoChecklist);
app.put('/api/ordem-servico/:numero/checklist', authenticateToken, handlePutRevisaoChecklist);
app.put('/api/ordem-servico/:numero/:projetoId/situacao', authenticateToken, handlePutSituacaoOrdemServico);


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

// 7. Planta Baixa (Factory Floor Plan) Data Route
app.get('/api/planta-baixa/dados', authenticateToken, async (req, res) => {
  try {
    res.json([]);
  } catch (error) {
    console.error('PLANTA BAIXA DADOS ERROR:', error);
    res.status(500).json({ error: 'Erro ao carregar dados da planta baixa.' });
  }
});

// 8. Layout Files Routes (Importação de Layouts)
app.get('/api/arquivos-importados', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  try {
    const list = await db.all(`
      SELECT 
        id, 
        empresa_id,
        nome_arquivo, 
        tamanho, 
        tipo_layout, 
        caminho_arquivo, 
        data_upload,
        COALESCE(projeto_id, (SELECT id FROM projetos WHERE empresa_id = ? ORDER BY id ASC LIMIT 1)) as projeto_id
      FROM arquivos_importados 
      WHERE empresa_id = ?
      ORDER BY data_upload DESC
    `, [empresaId, empresaId]);
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
async function CarregarMateriais(file, finalProjectId, empresaId = 1) {
  try {
    const pdf = await getPdfParse();
    const fileBuffer = fs.readFileSync(file.path);
    const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
    if (instance.load) await instance.load();
    const pdfData = await instance.getText();
    const text = pdfData.text || '';
    
    const materials = parseMaterialsFromText(text);
    if (materials.length > 0 && finalProjectId) {
      // Limpa materiais anteriores desse projeto para evitar duplicatas
      await db.run('DELETE FROM Projeto_Materiais WHERE empresa_id = ? AND projeto_id = ?', [empresaId, finalProjectId]);
      
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
          'INSERT INTO Projeto_Materiais (empresa_id, projeto_id, referencia, descricao, qtd, un) VALUES (?, ?, ?, ?, ?, ?)',
          [empresaId, finalProjectId, m.referencia, m.descricao, m.qtd, m.un]
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
          'INSERT INTO Projeto_Materiais (empresa_id, projeto_id, referencia, descricao, qtd, un) VALUES (?, ?, ?, ?, ?, ?)',
          [empresaId, finalProjectId, item.referencia, item.descricao, item.qtd, item.un]
        );
      }

      // 3. Inserir todos na tabela Material da empresa se a referência não existir
      const mappedMaterials = materials.map(m => ({ ...m, tipo: 'Produto' }));
      const mappedExtras = extraItems.map(e => ({ ...e, tipo: 'Serviço' }));
      const allItems = [...mappedMaterials, ...mappedExtras];

      for (const m of allItems) {
        const existing = await db.get(
          'SELECT MaterialReferencia FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?',
          [empresaId, m.referencia]
        );
        if (!existing) {
          // Normaliza unidade para respeitar o constraint do banco
          let normUn = (m.un || '').toUpperCase().trim();
          if (normUn === 'UN') normUn = 'UNI';
          const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
          if (!allowedUnits.includes(normUn)) {
            normUn = 'UNI'; // fallback seguro
          }

          await db.run(
            `INSERT INTO Material (empresa_id, MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [empresaId, m.referencia, m.descricao, normUn, 0.0, null, 8, m.tipo, 0]
          );
        }
      }

      console.log(`[CarregarMateriais] Gravados ${materials.length} materiais e ${extraItems.length} itens de fabricação para o projeto ID ${finalProjectId} (empresa ${empresaId})`);
      
      // Sincroniza e recalcula custos e preços do projeto
      await db.run('DELETE FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, finalProjectId]);
      await ensureProjetoItemsPopulated(finalProjectId, empresaId);
      await recalculateProjectCosts(finalProjectId, empresaId);
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
async function CarregarPecas(file, finalProjectId, empresaId = 1) {
  try {
    const pdfjs = await getPdfJs();
    const pdf = await getPdfParse();
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
      await db.run('DELETE FROM Projeto_Pecas WHERE empresa_id = ? AND projeto_id = ?', [empresaId, finalProjectId]);

      for (let idx = 0; idx < pecas.length; idx++) {
        const p = pecas[idx];
        // Imagem da peça (índice par: 2 * idx)
        const base64Image = imageBase64List[2 * idx] || null;
        // Código de barras (índice ímpar: 2 * idx + 1)
        const base64Barcode = imageBase64List[2 * idx + 1] || null;

        await db.run(
          'INSERT INTO Projeto_Pecas (empresa_id, projeto_id, peca, etiqueta, dimen, chapa, modulo, cod_item, imagem, cor_barras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [empresaId, finalProjectId, p.peca || '', p.etiqueta || '', p.dimen || '', p.chapa || '', p.modulo || '', p.cod_item || '', base64Image, base64Barcode]
        );
      }
      console.log(`[CarregarPecas] Gravadas ${pecas.length} peças para o projeto ID ${finalProjectId}`);

      // Atualiza a quantidade de peças no campo ProjetoQtdPecas da tabela projetos
      await db.run(
        'UPDATE projetos SET ProjetoQtdPecas = ? WHERE empresa_id = ? AND id = ?',
        [pecas.length, empresaId, finalProjectId]
      );
      console.log(`[CarregarPecas] Atualizado ProjetoQtdPecas com quantidade ${pecas.length} para o projeto ID ${finalProjectId}`);
    }
  } catch (parseErr) {
    console.error('Erro na rotina CarregarPecas:', parseErr);
    throw parseErr;
  }
}

app.post('/api/arquivos-importados', authenticateToken, uploadLayouts.array('arquivos'), async (req, res) => {
  const empresaId = req.auth.empresaId;
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const { projeto_id } = req.body;
  let targetProjetoId = null;
  if (projeto_id && projeto_id !== 'null' && projeto_id !== 'undefined') {
    targetProjetoId = parseInt(projeto_id, 10);
    if (isNaN(targetProjetoId)) {
      targetProjetoId = null;
    }
  }

  let finalProjectId = targetProjetoId;
  if (finalProjectId) {
    const ownedProj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, finalProjectId]);
    if (!ownedProj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
  } else {
    const firstProj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? ORDER BY id ASC LIMIT 1', [empresaId]);
    if (firstProj) {
      finalProjectId = firstProj.id;
    }
  }

  try {
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
      if (lowerName.includes('assembly modelo') || lowerName.includes('assembly')) {
        return 3;
      }
      if (lowerName.includes('etiqueta') || lowerName.includes('etiquetas')) {
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
        originalName = Buffer.from(originalName, 'latin1').toString('utf8');
      } catch (err) {
        console.error('Erro ao converter encoding do nome do arquivo:', err);
      }

      // Se o arquivo com o mesmo nome já existe neste projeto da empresa, removemos o antigo
      try {
        const existingFile = await db.get(
          'SELECT * FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ? AND nome_arquivo = ?',
          [empresaId, finalProjectId, originalName]
        );
        if (existingFile) {
          console.log(`[Upload] Arquivo duplicado detectado para o projeto ${finalProjectId}: "${originalName}". Removendo carga antiga.`);
          if (fs.existsSync(existingFile.caminho_arquivo)) {
            fs.unlinkSync(existingFile.caminho_arquivo);
          }
          await db.run('DELETE FROM arquivos_importados WHERE empresa_id = ? AND id = ?', [empresaId, existingFile.id]);
        }
      } catch (err) {
        console.error('Erro ao limpar arquivo duplicado:', err);
      }

      const normalizedName = originalName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_\-\s]/g, "");

      const lowerName = normalizedName.toLowerCase();
      let resolvedLayout = 'Outro';

      if (lowerName.includes('cuttingplan')) {
        resolvedLayout = 'PlanoCorte';
      } else if (lowerName.includes('etiqueta') || lowerName.includes('etiquetas')) {
        resolvedLayout = 'Etiqueta';
      } else if (lowerName.includes('assembly modelo') || lowerName.includes('assembly')) {
        resolvedLayout = 'Modulo';
      } else if (lowerName.includes('relatorio_para_compra_de_materiais') || lowerName.includes('compra de materiais') || lowerName.includes('compra_de_materiais')) {
        resolvedLayout = 'Materiais';
      }

      console.log(`[Upload] Arquivo original: "${file.originalname}" -> Decodificado: "${originalName}" -> Normalizado: "${normalizedName}" -> Layout: "${resolvedLayout}" -> Projeto: ${finalProjectId}`);

      const result = await db.run(
        'INSERT INTO arquivos_importados (empresa_id, nome_arquivo, tamanho, tipo_layout, caminho_arquivo, projeto_id) VALUES (?, ?, ?, ?, ?, ?)',
        [empresaId, originalName, file.size, resolvedLayout, file.path, finalProjectId]
      );
      insertedIds.push(result.lastID);

      if (resolvedLayout === 'Materiais') {
        try {
          await CarregarMateriais(file, finalProjectId, empresaId);
        } catch (parseErr) {
          console.error('Erro no upload ao invocar rotina CarregarMateriais:', parseErr);
        }
      }

      if (resolvedLayout === 'Modulo') {
        try {
          const pdfjs = await getPdfJs();
          const pdf = await getPdfParse();
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

          const fileBuffer = fs.readFileSync(file.path);
          const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
          if (instance.load) await instance.load();
          const pdfData = await instance.getText();
          const text = pdfData.text || '';
          
          const modules = parseModulesFromText(text);
          if (modules.length > 0 && finalProjectId) {
            await db.run('DELETE FROM Projeto_Modulo WHERE empresa_id = ? AND projeto_id = ?', [empresaId, finalProjectId]);
            
            for (let idx = 0; idx < modules.length; idx++) {
              const m = modules[idx];
              const base64Image = imageBase64List[idx] || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="80" height="80"><rect x="15" y="15" width="70" height="70" rx="4" fill="none" stroke="%2306b6d4" stroke-width="3" /><line x1="15" y1="45" x2="85" y2="45" stroke="%2306b6d4" stroke-width="2" /><line x1="50" y1="15" x2="50" y2="85" stroke="%2306b6d4" stroke-width="2" /><circle cx="43" cy="30" r="2.5" fill="%2306b6d4" /><circle cx="57" cy="30" r="2.5" fill="%2306b6d4" /><circle cx="43" cy="65" r="2.5" fill="%2306b6d4" /><circle cx="57" cy="65" r="2.5" fill="%2306b6d4" /></svg>`;

              await db.run(
                'INSERT INTO Projeto_Modulo (empresa_id, projeto_id, modulo, peca, imagem) VALUES (?, ?, ?, ?, ?)',
                [empresaId, finalProjectId, m.modulo, m.peca, base64Image]
              );
            }
            console.log(`[Modules] Gravados ${modules.length} módulos (com ${imageBase64List.length} imagens reais) para o projeto ID ${finalProjectId}`);

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

            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE empresa_id = ? AND projeto_id = ? AND referencia = 'FAB.MON.CXA'",
              [validModuloCount, empresaId, finalProjectId]
            );
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE empresa_id = ? AND projeto_id = ? AND referencia = 'FAB.ESP.PCA'",
              [especialModuloCount, empresaId, finalProjectId]
            );
            const totalEmbalagem = validModuloCount + especialModuloCount;
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE empresa_id = ? AND projeto_id = ? AND referencia = 'FAB.EMB.UND'",
              [totalEmbalagem, empresaId, finalProjectId]
            );
          }
        } catch (parseErr) {
          console.error('Erro ao fazer parse ou salvar módulos do PDF:', parseErr);
        }
      }

      if (resolvedLayout === 'PlanoCorte') {
        try {
          const pdf = await getPdfParse();
          const fileBuffer = fs.readFileSync(file.path);
          const instance = new pdf.PDFParse(new Uint8Array(fileBuffer));
          if (instance.load) await instance.load();
          const pdfData = await instance.getText();
          
          const chapas = parsePdfText(pdfData.pages);
          if (chapas.length > 0 && finalProjectId) {
            await db.run('DELETE FROM Projeto_Chapa WHERE empresa_id = ? AND projeto_id = ?', [empresaId, finalProjectId]);
            
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
                  'INSERT INTO Projeto_Chapa (empresa_id, projeto_id, chapa, acabamento, DescChapa, item, descricao, dimensao) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                  [empresaId, finalProjectId, c.chapa, updatedAcabamento, c.descChapa || null, p.item, p.descricao, p.dimensao]
                );
              }
            }
            console.log(`[Cuts] Gravados ${chapas.reduce((acc, c) => acc + c.pecas.length, 0)} cortes para o projeto ID ${finalProjectId}`);
            
            await db.run(
              "UPDATE Projeto_Materiais SET qtd = ? WHERE empresa_id = ? AND projeto_id = ? AND referencia = 'FAB.USI.CHP'",
              [chapas.length, empresaId, finalProjectId]
            );

            const totalPecas = chapas.reduce((acc, c) => acc + c.pecas.length, 0);
            await db.run(
              'UPDATE projetos SET ProjetoQtdPecas = ? WHERE empresa_id = ? AND id = ?',
              [totalPecas, empresaId, finalProjectId]
            );
          }
        } catch (parseErr) {
          console.error('Erro ao fazer parse ou salvar plano de corte do PDF:', parseErr);
        }
      }

      if (resolvedLayout === 'Etiqueta') {
        try {
          await CarregarPecas(file, finalProjectId, empresaId);
        } catch (parseErr) {
          console.error('Erro no upload ao invocar rotina CarregarPecas:', parseErr);
        }
      }
    }

    await db.run('COMMIT');

    const uploadedFiles = await db.all(
      `SELECT * FROM arquivos_importados WHERE empresa_id = ? AND id IN (${insertedIds.map(() => '?').join(',')})`,
      [empresaId, ...insertedIds]
    );
    res.status(201).json(uploadedFiles);
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch (e) {}
    console.error('UPLOAD LAYOUTS ERROR:', error);
    res.status(500).json({ error: 'Erro ao registrar arquivos no banco de dados.' });
  }
});

app.get('/api/arquivos-importados/download/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const file = await db.get('SELECT * FROM arquivos_importados WHERE empresa_id = ? AND id = ?', [empresaId, id]);
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const file = await db.get('SELECT * FROM arquivos_importados WHERE empresa_id = ? AND id = ?', [empresaId, id]);
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
    await db.run('DELETE FROM arquivos_importados WHERE empresa_id = ? AND id = ?', [empresaId, id]);

    // Se for layout Etiqueta, remove as peças vinculadas se não houver outro arquivo de etiqueta para este projeto
    if (file.tipo_layout === 'Etiqueta' && file.projeto_id) {
      const remaining = await db.get(
        "SELECT id FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ? AND tipo_layout = 'Etiqueta' AND id != ?",
        [empresaId, file.projeto_id, id]
      );
      if (!remaining) {
        await db.run('DELETE FROM Projeto_Pecas WHERE empresa_id = ? AND projeto_id = ?', [empresaId, file.projeto_id]);
        await db.run('UPDATE projetos SET ProjetoQtdPecas = 0 WHERE empresa_id = ? AND id = ?', [empresaId, file.projeto_id]);
      }
    }

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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const proj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!proj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    const list = await db.all(
      `SELECT * FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ? ORDER BY criado_em DESC, id DESC`,
      [empresaId, id]
    );
    res.json(list);
  } catch (error) {
    console.error('GET PROJETO ANEXOS ERROR:', error);
    res.status(500).json({ error: 'Erro ao listar anexos do projeto.' });
  }
});

// POST /api/projetos/:id/anexos - Upload de anexos para o projeto
app.post('/api/projetos/:id/anexos', authenticateToken, uploadAnexos.array('arquivos'), async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const exibirNaProposta = req.body?.exibir_na_proposta === 'Nao' ? 'Nao' : 'Sim';
  try {
    const proj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!proj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const userName = req.auth.nome || req.user?.nome || req.user?.name || req.user?.login || 'Usuário';
    const inserted = [];

    for (const file of req.files) {
      let originalName = file.originalname || '';
      try {
        originalName = Buffer.from(originalName, 'latin1').toString('utf8');
      } catch (e) {}

      const relativePath = `uploads/empresa_${empresaId}/anexos/${file.filename}`;
      const result = await db.run(
        `INSERT INTO projeto_anexos (empresa_id, projeto_id, nome_original, nome_arquivo, caminho, tipo_mime, tamanho, exibir_na_proposta, criado_por_nome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [empresaId, id, originalName, file.filename, relativePath, file.mimetype, file.size, exibirNaProposta, userName]
      );

      const item = await db.get('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND id = ?', [empresaId, result.lastID]);
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { exibir_na_proposta, nome_original } = req.body;
  try {
    const anexo = await db.get('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    const newExibir = exibir_na_proposta !== undefined ? (exibir_na_proposta === 'Sim' || exibir_na_proposta === true ? 'Sim' : 'Nao') : anexo.exibir_na_proposta;
    const newNome = nome_original || anexo.nome_original;

    await db.run(
      `UPDATE projeto_anexos SET exibir_na_proposta = ?, nome_original = ? WHERE empresa_id = ? AND id = ?`,
      [newExibir, newNome, empresaId, id]
    );

    const updated = await db.get('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(updated);
  } catch (error) {
    console.error('UPDATE ANEXO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar anexo.' });
  }
});

// GET /api/projetos/anexos/download/:id - Download de anexo do projeto
app.get('/api/projetos/anexos/download/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const anexo = await db.get('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    const fullPath = getUploadPhysicalPath(anexo.caminho) || path.resolve(anexo.caminho);
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const anexo = await db.get('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    try {
      const fullPath = getUploadPhysicalPath(anexo.caminho) || path.resolve(anexo.caminho);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (e) {
      console.error('Erro ao excluir arquivo físico de anexo:', e);
    }

    await db.run('DELETE FROM projeto_anexos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ message: 'Anexo excluído com sucesso.' });
  } catch (error) {
    console.error('DELETE ANEXO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir anexo.' });
  }
});

app.get('/api/projetos/:projeto_id/materiais', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { projeto_id } = req.params;
  try {
    const proj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, projeto_id]);
    if (!proj) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const list = await db.all('SELECT * FROM Projeto_Materiais WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [empresaId, projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT MATERIALS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar materiais do projeto.' });
  }
});

app.get('/api/projetos/:projeto_id/modulos', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { projeto_id } = req.params;
  try {
    const proj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, projeto_id]);
    if (!proj) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const list = await db.all('SELECT * FROM Projeto_Modulo WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [empresaId, projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT MODULES ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar módulos do projeto.' });
  }
});

app.get('/api/projetos/:projeto_id/chapas', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { projeto_id } = req.params;
  try {
    const proj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, projeto_id]);
    if (!proj) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const list = await db.all('SELECT * FROM Projeto_Chapa WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [empresaId, projeto_id]);
    res.json(list);
  } catch (error) {
    console.error('GET PROJECT CHAPAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar chapas do projeto.' });
  }
});

app.get('/api/projetos/:projeto_id/pecas', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { projeto_id } = req.params;
  try {
    const proj = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, projeto_id]);
    if (!proj) return res.status(404).json({ error: 'Projeto não encontrado.' });

    let list = await db.all('SELECT * FROM Projeto_Pecas WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [empresaId, projeto_id]);
    
    // Auto-recuperação: Se a tabela estiver vazia, mas existir um arquivo de Etiqueta importado para este projeto, carrega automaticamente
    if (list.length === 0) {
      const etiquetaFile = await db.get(
        "SELECT * FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ? AND tipo_layout = 'Etiqueta' ORDER BY id DESC LIMIT 1",
        [empresaId, projeto_id]
      );
      if (etiquetaFile && fs.existsSync(etiquetaFile.caminho_arquivo)) {
        console.log(`[GET /pecas] Auto-recuperando peças do arquivo "${etiquetaFile.nome_arquivo}" para o projeto ${projeto_id}...`);
        try {
          await CarregarPecas({ path: etiquetaFile.caminho_arquivo }, projeto_id, empresaId);
          list = await db.all('SELECT * FROM Projeto_Pecas WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [empresaId, projeto_id]);
        } catch (procErr) {
          console.error('[GET /pecas] Erro ao auto-processar peças:', procErr);
        }
      }
    }

    res.json(list);
  } catch (error) {
    console.error('GET PROJECT PECAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar peças do projeto.' });
  }
});

// 9. Budget Routes (Orçamentos)
app.get('/api/orcamentos', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  try {
    await ensureOrcamentosSchema(db);
    const list = await db.all(`
      SELECT 
        o.numero,
        o.empresa_id,
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
        o.fluxo_efetivado,
        o.data_assinatura,
        o.assinatura_responsavel,
        o.usuario_assinatura_nome,
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
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoMaterial,
        COALESCE((
          SELECT SUM(p.CustoProducao)
          FROM projetos p
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoProducao,
        COALESCE((
          SELECT SUM(COALESCE(p.CustoTotal, (COALESCE(p.CustoMaterial, 0) + COALESCE(p.CustoProducao, 0))))
          FROM projetos p
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoTotal
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id AND c.empresa_id = o.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = o.empresa_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = o.empresa_id
      WHERE o.empresa_id = ?
      ORDER BY o.numero DESC
    `, [empresaId]);
    res.json(list);
  } catch (error) {
    console.error('GET BUDGETS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar orçamentos.' });
  }
});

app.post('/api/orcamentos', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { cliente_id, descricao, status, parametro_financeiro_id } = req.body;
  if (!cliente_id) {
    return res.status(400).json({ error: 'O cliente é obrigatório.' });
  }

  try {
    // Valida que o cliente pertence à empresa autenticada
    const ownedClient = await db.get('SELECT id FROM clientes WHERE empresa_id = ? AND id = ?', [empresaId, parseInt(cliente_id, 10)]);
    if (!ownedClient) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    // Resolve e valida o parâmetro financeiro na empresa autenticada
    let paramIdVal = null;
    if (parametro_financeiro_id !== undefined && parametro_financeiro_id !== null && parametro_financeiro_id !== '') {
      const ownedParam = await db.get(
        'SELECT id FROM Parametro_Financeiro WHERE empresa_id = ? AND id = ?',
        [empresaId, parseInt(parametro_financeiro_id, 10)]
      );
      if (!ownedParam) {
        return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
      }
      paramIdVal = ownedParam.id;
    } else {
      const defaultParam = await db.get(
        'SELECT id FROM Parametro_Financeiro WHERE empresa_id = ? ORDER BY id ASC LIMIT 1',
        [empresaId]
      );
      paramIdVal = defaultParam ? defaultParam.id : null;
    }

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

    await db.run(
      'INSERT INTO orcamentos (empresa_id, numero, cliente_id, descricao, status, parametro_financeiro_id) VALUES (?, ?, ?, ?, ?, ?)',
      [empresaId, orcamentoNumero, parseInt(cliente_id, 10), descricao || null, status || 'Em Aberto', paramIdVal]
    );

    const newBudget = await db.get(`
      SELECT 
        o.numero,
        o.empresa_id,
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
      JOIN clientes c ON o.cliente_id = c.id AND c.empresa_id = o.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = o.empresa_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = o.empresa_id
      WHERE o.empresa_id = ? AND o.numero = ?
    `, [empresaId, orcamentoNumero]);
    res.status(201).json(newBudget);
  } catch (error) {
    console.error('CREATE BUDGET ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar orçamento.' });
  }
});

app.put('/api/orcamentos/:numero', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  const { cliente_id, descricao, status, forma_pagamento_selecionada, anotacoes_cliente, parametro_financeiro_id } = req.body;
  try {
    const budget = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const updatedClienteId = cliente_id !== undefined ? parseInt(cliente_id, 10) : budget.cliente_id;
    if (cliente_id !== undefined) {
      const ownedClient = await db.get('SELECT id FROM clientes WHERE empresa_id = ? AND id = ?', [empresaId, updatedClienteId]);
      if (!ownedClient) {
        return res.status(404).json({ error: 'Cliente não encontrado.' });
      }
    }

    const updatedDescricao = descricao !== undefined ? descricao : budget.descricao;
    const updatedStatus = status !== undefined ? status : (budget.status || 'Em Aberto');
    const updatedFormaPag = forma_pagamento_selecionada !== undefined ? forma_pagamento_selecionada : budget.forma_pagamento_selecionada;
    const updatedAnotacoes = anotacoes_cliente !== undefined ? anotacoes_cliente : budget.anotacoes_cliente;
    const isBudgetEmAberto = !budget.status || budget.status === 'Em Aberto' || budget.status === 'Em Negociação' || budget.status === 'Pendente';
    let updatedParamId = budget.parametro_financeiro_id;
    if (isBudgetEmAberto && parametro_financeiro_id !== undefined && parametro_financeiro_id !== null) {
      const ownedParam = await db.get('SELECT id FROM Parametro_Financeiro WHERE empresa_id = ? AND id = ?', [empresaId, parseInt(parametro_financeiro_id, 10)]);
      if (!ownedParam) {
        return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
      }
      updatedParamId = ownedParam.id;
    }

    const dataAprovacao = (updatedStatus === 'Aprovado' && !budget.data_aprovacao)
      ? formatDateTimeForMySQL(new Date())
      : (updatedStatus !== 'Aprovado' && updatedStatus !== 'Efetivado' ? null : budget.data_aprovacao);

    const fluxoEfetivadoVal = (updatedStatus === 'Em Aberto' || updatedStatus === 'Recusado') ? 0 : budget.fluxo_efetivado;
    const updatedFluxoFinanceiro = (req.body.fluxo_financeiro !== undefined)
      ? (typeof req.body.fluxo_financeiro === 'string' ? req.body.fluxo_financeiro : JSON.stringify(req.body.fluxo_financeiro))
      : budget.fluxo_financeiro;

    // Se o contrato já foi assinado, o fluxo financeiro não pode ser alterado
    if (budget.data_assinatura && req.body.fluxo_financeiro !== undefined && updatedStatus !== 'Em Aberto') {
      return res.status(400).json({ error: 'O fluxo financeiro não pode ser alterado pois o contrato deste orçamento já foi assinado.' });
    }

    if (updatedStatus === 'Em Aberto') {
      // Se retornar para Em Aberto, exclui parcelas do fluxo financeiro e limpa assinatura
      await db.run('DELETE FROM FluxoRecebimento WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);
    }

    const dataAssinaturaVal = updatedStatus === 'Em Aberto' ? null : budget.data_assinatura;
    const assinaturaRespVal = updatedStatus === 'Em Aberto' ? null : budget.assinatura_responsavel;
    const usuarioAssinaturaVal = updatedStatus === 'Em Aberto' ? null : budget.usuario_assinatura_nome;

    await db.run(
      'UPDATE orcamentos SET cliente_id = ?, descricao = ?, status = ?, forma_pagamento_selecionada = ?, anotacoes_cliente = ?, data_aprovacao = ?, fluxo_efetivado = ?, parametro_financeiro_id = ?, fluxo_financeiro = ?, data_assinatura = ?, assinatura_responsavel = ?, usuario_assinatura_nome = ? WHERE empresa_id = ? AND numero = ?',
      [updatedClienteId, updatedDescricao, updatedStatus, updatedFormaPag, updatedAnotacoes, dataAprovacao, fluxoEfetivadoVal, updatedParamId, updatedFluxoFinanceiro, dataAssinaturaVal, assinaturaRespVal, usuarioAssinaturaVal, empresaId, numero]
    );

    const updated = await db.get(`
      SELECT 
        o.numero,
        o.empresa_id,
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
        o.fluxo_financeiro,
        o.fluxo_efetivado,
        o.data_assinatura,
        o.assinatura_responsavel,
        o.usuario_assinatura_nome,
        c.nome as cliente_nome,
        COALESCE((
          SELECT SUM(p.CustoMaterial)
          FROM projetos p
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoMaterial,
        COALESCE((
          SELECT SUM(p.CustoProducao)
          FROM projetos p
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoProducao
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id AND c.empresa_id = o.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = o.empresa_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = o.empresa_id
      WHERE o.empresa_id = ? AND o.numero = ?
    `, [empresaId, numero]);

    res.json(updated);
  } catch (error) {
    console.error('UPDATE BUDGET ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar orçamento.' });
  }
});

app.delete('/api/orcamentos/:numero', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  try {
    const budget = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    // 1. Buscar todos os projetos do orçamento para excluir seus dados subordinados e arquivos
    const projs = await db.all('SELECT id FROM projetos WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);
    for (const p of projs) {
      const anexos = await db.all('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);
      for (const a of anexos) {
        try {
          if (a.caminho) {
            const fullPath = resolveSafeUploadPath(uploadsBaseDir, a.caminho) || path.resolve(a.caminho);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          }
        } catch (e) {}
      }
      await db.run('DELETE FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);

      const arquivos = await db.all('SELECT * FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);
      for (const f of arquivos) {
        try {
          if (f.caminho_arquivo && fs.existsSync(f.caminho_arquivo)) fs.unlinkSync(f.caminho_arquivo);
        } catch (e) {}
      }
      await db.run('DELETE FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);

      await db.run('DELETE FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, p.id]);
      await db.run('DELETE FROM Projeto_Materiais WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);
      await db.run('DELETE FROM Projeto_Pecas WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);
      await db.run('DELETE FROM Projeto_Modulo WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);
      await db.run('DELETE FROM Projeto_Chapa WHERE empresa_id = ? AND projeto_id = ?', [empresaId, p.id]);
    }

    // 2. Excluir links de compartilhamento, fluxo de recebimento e histórico de propostas
    await db.run('DELETE FROM FluxoRecebimento WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);
    await db.run('DELETE FROM proposta_compartilhamentos WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);
    await db.run('DELETE FROM propostas WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);

    // 3. Excluir os projetos do orçamento
    await db.run('DELETE FROM projetos WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);

    // 4. Excluir o orçamento
    await db.run('DELETE FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);

    res.json({ message: 'Orçamento, seus projetos e todos os dados subordinados foram removidos com sucesso.' });
  } catch (error) {
    console.error('DELETE BUDGET ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir orçamento e seus dados subordinados.' });
  }
});

app.get('/api/orcamentos/:numero', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  try {
    await ensureOrcamentosSchema(db);
    const budget = await db.get(`
      SELECT 
        o.numero,
        o.empresa_id,
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
        o.fluxo_efetivado,
        o.data_assinatura,
        o.assinatura_responsavel,
        o.usuario_assinatura_nome,
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
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoMaterial,
        COALESCE((
          SELECT SUM(p.CustoProducao)
          FROM projetos p
          WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero
        ), 0.0) as CustoProducao
      FROM orcamentos o
      JOIN clientes c ON o.cliente_id = c.id AND c.empresa_id = o.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = o.empresa_id
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = o.empresa_id
      WHERE o.empresa_id = ? AND o.numero = ?
    `, [empresaId, numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }
    res.json(budget);
  } catch (error) {
    console.error('GET BUDGET DETAIL ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes do orçamento.' });
  }
});

// POST /api/orcamentos/:numero/assinar-contrato - Assinatura digital do contrato pelo usuário logado / empresa
app.post('/api/orcamentos/:numero/assinar-contrato', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  try {
    const budget = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const userId = req.auth.userId;
    let userAssinatura = null;
    let userName = req.auth.nome || '';

    if (userId) {
      const userRow = await db.get('SELECT * FROM usuarios WHERE empresa_id = ? AND id = ?', [empresaId, userId]);
      if (userRow) {
        userAssinatura = userRow.assinatura || null;
        userName = userRow.nome || userName;
      }
    }

    // Se o usuário não tiver assinatura cadastrada, buscar na tabela de parâmetros a imagem da chave "EMP_ASS"
    if (!userAssinatura) {
      try {
        const paramRow = await db.get('SELECT conteudo FROM parametros_empresa WHERE empresa_id = ? AND chave = ?', [empresaId, 'EMP_ASS']);
        userAssinatura = paramRow?.conteudo || req.body.assinatura || '';
      } catch (paramErr) {
        userAssinatura = req.body.assinatura || '';
      }
    }

    const dataAssinatura = formatDateTimeForMySQL(new Date());

    await db.run(`
      UPDATE orcamentos 
      SET 
        data_assinatura = ?, 
        assinatura_responsavel = ?, 
        usuario_assinatura_nome = ? 
      WHERE empresa_id = ? AND numero = ?
    `, [dataAssinatura, userAssinatura, userName, empresaId, numero]);

    const updated = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    res.json({
      message: 'Contrato assinado com sucesso!',
      data_assinatura: dataAssinatura,
      assinatura_responsavel: userAssinatura,
      usuario_assinatura_nome: userName,
      orcamento: updated
    });
  } catch (error) {
    console.error('ERRO AO ASSINAR CONTRATO:', error);
    res.status(500).json({ error: 'Erro ao registrar assinatura do contrato: ' + (error.message || '') });
  }
});

// POST /api/orcamentos/:numero/conclusao - Conclusão e fechamento de proposta com descontos e forma de pagamento
app.post('/api/orcamentos/:numero/conclusao', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
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
    const budget = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const currentStatus = (budget.status || 'Em Aberto').trim().toLowerCase();
    if (currentStatus !== 'em aberto') {
      return res.status(400).json({ error: 'Não é permitido alterar proposta de orçamento que não esteja Em Aberto.' });
    }

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
        situacao = ?,
        data_aprovacao = ?,
        data_entrada = ?,
        fluxo_financeiro = ?
      WHERE empresa_id = ? AND numero = ?
    `, [descPerc, descVlr, precoFinal, formaPag, anotacoesCli, anotacoesConc, novoStatus, novoStatus, dataAprovacao, dataEntrada, fluxoFinanceiro, empresaId, numero]);

    // Sincronizar com a versão mais recente da proposta se houver
    if (formaPag || novoStatus === 'Aprovado') {
      const propStatus = novoStatus === 'Aprovado' ? 'Aprovada' : undefined;
      if (propStatus) {
        await db.run(
          `UPDATE propostas 
           SET status = ?, 
               forma_pagamento_selecionada = COALESCE(?, forma_pagamento_selecionada) 
           WHERE empresa_id = ? AND orcamento_numero = ? 
           ORDER BY versao DESC, id DESC LIMIT 1`,
          [propStatus, formaPag, empresaId, numero]
        );
      } else if (formaPag) {
        await db.run(
          `UPDATE propostas 
           SET forma_pagamento_selecionada = ? 
           WHERE empresa_id = ? AND orcamento_numero = ? 
           ORDER BY versao DESC, id DESC LIMIT 1`,
          [formaPag, empresaId, numero]
        );
      }
    }

    // Se houver projetos e um novo preço final, distribui proporcionalmente no preco_venda_final dos projetos
    const projetos = await db.all('SELECT * FROM projetos WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY id ASC', [empresaId, numero]);
    if (projetos.length > 0 && precoFinal !== null && precoFinal > 0) {
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
        await db.run('UPDATE projetos SET preco_venda_final = ? WHERE empresa_id = ? AND id = ?', [novoPrecoProj, empresaId, p.id]);
      }
    }

    const updatedBudget = await db.get(`
      SELECT 
        o.numero,
        o.empresa_id,
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
        COALESCE((SELECT SUM(p.CustoMaterial) FROM projetos p WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero), 0.0) as CustoMaterial,
        COALESCE((SELECT SUM(p.CustoProducao) FROM projetos p WHERE p.empresa_id = o.empresa_id AND p.orcamento_numero = o.numero), 0.0) as CustoProducao
      FROM orcamentos o
      LEFT JOIN clientes c ON o.cliente_id = c.id AND c.empresa_id = o.empresa_id
      WHERE o.empresa_id = ? AND o.numero = ?
    `, [empresaId, numero]);

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
async function ensureProjetoItemsPopulated(projectId, empresaId = null) {
  let resolvedEmpresaId = empresaId;
  if (!resolvedEmpresaId) {
    const pRow = await db.get('SELECT empresa_id FROM projetos WHERE id = ?', [projectId]);
    if (!pRow) return;
    resolvedEmpresaId = pRow.empresa_id;
  }

  const countRow = await db.get('SELECT COUNT(*) as count FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [resolvedEmpresaId, projectId]);
  if (!countRow || countRow.count === 0) {
    const materials = await db.all('SELECT * FROM Projeto_Materiais WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [resolvedEmpresaId, projectId]);
    if (materials && materials.length > 0) {
      let currentSeq = 1;
      const monItem = materials.find(m => m.referencia === 'FAB.MON.CXA');
      const espItem = materials.find(m => m.referencia === 'FAB.ESP.PCA');
      const qtdMonCxa = monItem ? (parseFloat(monItem.qtd) || 0.0) : 0.0;
      const qtdEspPca = espItem ? (parseFloat(espItem.qtd) || 0.0) : 0.0;
      const qtdEmbUnd = qtdMonCxa + qtdEspPca;

      for (const m of materials) {
        if (m.referencia === 'FAB.QTD.PCA') continue;
        let globalMat = await db.get('SELECT * FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?', [resolvedEmpresaId, m.referencia]);
        if (!globalMat) {
          let normUn = (m.un || '').toUpperCase().trim();
          if (normUn === 'UN') normUn = 'UNI';
          const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
          if (!allowedUnits.includes(normUn)) normUn = 'UNI';
          const matTipo = (m.tipo || (m.referencia && m.referencia.startsWith('FAB.') ? 'Serviço' : 'Produto'));
          await db.run(
            `INSERT INTO Material (empresa_id, MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [resolvedEmpresaId, m.referencia, m.descricao || m.referencia, normUn, 0.0, null, 8, matTipo, 0]
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
          `INSERT INTO ProjetoItem (empresa_id, ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [resolvedEmpresaId, projectId, currentSeq, m.referencia, vlrUnit, unidade, qtd, total, tempo, duracao]
        );
        currentSeq++;
      }
    }
  }
}

// Recalculate consolidated project costs (Material vs. Production) and total duration
async function recalculateProjectCosts(projectId, empresaId = null) {
  try {
    let resolvedEmpresaId = empresaId;
    if (!resolvedEmpresaId) {
      const pRow = await db.get('SELECT empresa_id FROM projetos WHERE id = ?', [projectId]);
      if (!pRow) return;
      resolvedEmpresaId = pRow.empresa_id;
    }

    // 1. Garantir que ProjetoItem está populado se Projeto_Materiais tiver registros
    await ensureProjetoItemsPopulated(projectId, resolvedEmpresaId);

    // 2. Se o orçamento não estiver aprovado, sincroniza os preços/tempos unitários de ProjetoItem com o cadastro Material da empresa
    const projData = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [resolvedEmpresaId, projectId]);
    if (projData && projData.orcamento_numero) {
      const budgetCheck = await db.get('SELECT status FROM orcamentos WHERE empresa_id = ? AND numero = ?', [resolvedEmpresaId, projData.orcamento_numero]);
      if (budgetCheck?.status !== 'Aprovado') {
        await db.run(`
          UPDATE ProjetoItem pi
          JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
          SET 
            pi.ProjetoItemVlrUnit = m.MaterialValorUnitario,
            pi.ProjetoItemTotal = pi.ProjetoItemQtd * m.MaterialValorUnitario,
            pi.ProjetoItemTempo = m.MaterialTempo,
            pi.ProjetoItemDuracao = ROUND(m.MaterialTempo * pi.ProjetoItemQtd)
          WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
        `, [resolvedEmpresaId, projectId]);
      }
    }

    const monCliItem = await db.get(
      "SELECT ROUND(ProjetoItemQtd) as diasMontagem FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = 'FAB.MON.CLI'",
      [resolvedEmpresaId, projectId]
    );

    let updateQuery = `
      UPDATE projetos 
      SET 
        CustoMaterial = COALESCE((
          SELECT SUM(pi.ProjetoItemTotal)
          FROM ProjetoItem pi
          LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
          WHERE pi.empresa_id = ? AND pi.ProjetoID = ? AND (m.MaterialTipo = 'Produto' OR m.MaterialTipo IS NULL)
        ), 0.0),
        CustoProducao = COALESCE((
          SELECT SUM(pi.ProjetoItemTotal)
          FROM ProjetoItem pi
          LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
          WHERE pi.empresa_id = ? AND pi.ProjetoID = ? AND m.MaterialTipo = 'Serviço'
        ), 0.0),
        CustoTotal = COALESCE((
          SELECT SUM(pi.ProjetoItemTotal)
          FROM ProjetoItem pi
          WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
        ), 0.0),
        DuracaoFabricacao = COALESCE((
          SELECT SUM(pi.ProjetoItemDuracao)
          FROM ProjetoItem pi
          WHERE pi.empresa_id = ? AND pi.ProjetoID = ? AND pi.MaterialReferencia != 'FAB.MON.CLI'
        ), 0)
    `;
    const params = [
      resolvedEmpresaId, projectId,
      resolvedEmpresaId, projectId,
      resolvedEmpresaId, projectId,
      resolvedEmpresaId, projectId
    ];

    const diasMontagemVal = monCliItem && monCliItem.diasMontagem !== null && monCliItem.diasMontagem !== undefined
      ? parseInt(monCliItem.diasMontagem, 10)
      : null;

    if (diasMontagemVal !== null && !isNaN(diasMontagemVal)) {
      updateQuery += `, DuracaoMontagem = ? WHERE empresa_id = ? AND id = ?`;
      params.push(diasMontagemVal, resolvedEmpresaId, projectId);
    } else {
      updateQuery += ` WHERE empresa_id = ? AND id = ?`;
      params.push(resolvedEmpresaId, projectId);
    }

    await db.run(updateQuery, params);

    // Recalcular Preço de Venda Sugerido e Final do Projeto e atualizar o Orçamento
    const updatedProj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [resolvedEmpresaId, projectId]);
    if (updatedProj && updatedProj.orcamento_numero) {
      const custoTotal = parseFloat(updatedProj.CustoTotal) || 0.0;
      const budget = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [resolvedEmpresaId, updatedProj.orcamento_numero]);
      const paramId = (budget && budget.parametro_financeiro_id) ? budget.parametro_financeiro_id : updatedProj.parametro_financeiro_id;
      let paramConfig = null;
      if (paramId) {
        paramConfig = await db.get('SELECT * FROM configuracoes_financeiras WHERE empresa_id = ? AND parametro_id = ?', [resolvedEmpresaId, paramId]);
      }
      if (!paramConfig) {
        paramConfig = await db.get('SELECT * FROM configuracoes_financeiras WHERE empresa_id = ? ORDER BY id ASC LIMIT 1', [resolvedEmpresaId]);
      }

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
          WHERE empresa_id = ? AND id = ?
        `, [precoSugerido, precoSugerido, resolvedEmpresaId, projectId]);
      } else {
        await db.run(`
          UPDATE projetos 
          SET 
            preco_venda_sugerido = ?
          WHERE empresa_id = ? AND id = ?
        `, [precoSugerido, resolvedEmpresaId, projectId]);
      }

      // Atualiza o total consolidado de venda do orçamento
      const sumProjs = await db.get(`
        SELECT SUM(COALESCE(preco_venda_final, preco_venda_sugerido, 0.0)) as somaVenda
        FROM projetos
        WHERE empresa_id = ? AND orcamento_numero = ?
      `, [resolvedEmpresaId, updatedProj.orcamento_numero]);
      const novoTotalVenda = sumProjs && sumProjs.somaVenda ? parseFloat(sumProjs.somaVenda) : 0.0;

      await db.run(`
        UPDATE orcamentos
        SET 
          total_venda = ?
        WHERE empresa_id = ? AND numero = ?
      `, [novoTotalVenda, resolvedEmpresaId, updatedProj.orcamento_numero]);
    }
  } catch (error) {
    console.error('Error recalculating project costs:', error);
    throw error;
  }
}

// POST /api/projetos/:id/recalcular - Forçar recálculo completo de custos e preço de venda
app.post('/api/projetos/:id/recalcular', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const ownedProj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!ownedProj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    await recalculateProjectCosts(id, empresaId);
    const updatedProj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    const budget = updatedProj ? await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, updatedProj.orcamento_numero]) : null;
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
  const empresaId = req.auth.empresaId;
  const { orcamento_numero } = req.query;
  try {
    let query = `
      SELECT 
        p.*, 
        COALESCE(o.status, 'Em Aberto') AS orcamento_status,
        COALESCE(o.status, 'Em Aberto') AS orcamento_situacao,
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao,
        (SELECT COUNT(*) FROM projeto_anexos pa WHERE pa.empresa_id = p.empresa_id AND pa.projeto_id = p.id) AS total_anexos
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero AND o.empresa_id = p.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = p.empresa_id
      WHERE p.empresa_id = ?
    `;
    let params = [empresaId];
    if (orcamento_numero) {
      query += ' AND p.orcamento_numero = ?';
      params.push(parseInt(orcamento_numero, 10));
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const query = `
      SELECT 
        p.*, 
        COALESCE(o.status, 'Em Aberto') AS orcamento_status,
        COALESCE(o.status, 'Em Aberto') AS orcamento_situacao,
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao,
        (SELECT COUNT(*) FROM projeto_anexos pa WHERE pa.empresa_id = p.empresa_id AND pa.projeto_id = p.id) AS total_anexos
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero AND o.empresa_id = p.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = p.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `;
    const proj = await db.get(query, [empresaId, id]);
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
  const empresaId = req.auth.empresaId;
  const { orcamento_numero, nome, descricao, DuracaoMontagem, ProjetoURL } = req.body;
  if (!orcamento_numero || !nome) {
    return res.status(400).json({ error: 'O número do orçamento e o nome do projeto são obrigatórios.' });
  }

  try {
    // Check if budget exists in the authenticated company
    const budget = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, orcamento_numero]);
    if (!budget) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const durMontagemVal = parseInt(DuracaoMontagem, 10) || 0;
    const qtdPecasVal = req.body.ProjetoQtdPecas !== undefined ? (parseInt(req.body.ProjetoQtdPecas, 10) || 0) : 0;

    const result = await db.run(
      'INSERT INTO projetos (empresa_id, orcamento_numero, nome, descricao, DuracaoMontagem, ProjetoURL, ProjetoQtdPecas) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [empresaId, parseInt(orcamento_numero, 10), nome, descricao || null, durMontagemVal, ProjetoURL || null, qtdPecasVal]
    );

    const newProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero AND o.empresa_id = p.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = p.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, result.lastID]);

    res.status(201).json(newProject);
  } catch (error) {
    console.error('CREATE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar projeto.' });
  }
});

app.put('/api/projetos/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { nome, descricao, DuracaoMontagem, ProjetoURL, ProjetoQtdPecas } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
  }

  try {
    const project = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    const durMontagemVal = DuracaoMontagem !== undefined ? (parseInt(DuracaoMontagem, 10) || 0) : (project.DuracaoMontagem || 0);
    const projetoUrlVal = ProjetoURL !== undefined ? (ProjetoURL || null) : (project.ProjetoURL || null);
    const qtdPecasVal = ProjetoQtdPecas !== undefined ? (parseInt(ProjetoQtdPecas, 10) || 0) : (project.ProjetoQtdPecas || 0);

    await db.run(
      'UPDATE projetos SET nome = ?, descricao = ?, DuracaoMontagem = ?, ProjetoURL = ?, ProjetoQtdPecas = ? WHERE empresa_id = ? AND id = ?',
      [nome, descricao || null, durMontagemVal, projetoUrlVal, qtdPecasVal, empresaId, id]
    );

    // Se FAB.MON.CLI existir em ProjetoItem para este projeto, sincroniza a quantidade
    const monCliItem = await db.get("SELECT * FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = 'FAB.MON.CLI'", [empresaId, id]);
    if (monCliItem) {
      const vlrUnit = monCliItem.ProjetoItemVlrUnit || 0.0;
      const newTotal = vlrUnit * durMontagemVal;
      const tempo = parseInt(monCliItem.ProjetoItemTempo, 10) || 0;
      const duracao = Math.round(tempo * durMontagemVal);
      await db.run(
        'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemDuracao = ? WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?',
        [durMontagemVal, newTotal, duracao, empresaId, id, 'FAB.MON.CLI']
      );
      await recalculateProjectCosts(id, empresaId);
    }

    const updatedProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero AND o.empresa_id = p.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = p.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);

    res.json(updatedProject);
  } catch (error) {
    console.error('UPDATE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar projeto.' });
  }
});

app.delete('/api/projetos/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const project = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    // 1. Excluir arquivos físicos de anexos
    const anexos = await db.all('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);
    for (const a of anexos) {
      try {
        if (a.caminho) {
          const fullPath = getUploadPhysicalPath(a.caminho) || path.resolve(a.caminho);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch (e) {
        console.error('Erro ao excluir arquivo físico de anexo:', e);
      }
    }
    await db.run('DELETE FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);

    // 2. Excluir arquivos físicos de arquivos_importados
    const arquivos = await db.all('SELECT * FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);
    for (const f of arquivos) {
      try {
        if (f.caminho_arquivo && fs.existsSync(f.caminho_arquivo)) {
          fs.unlinkSync(f.caminho_arquivo);
        }
      } catch (e) {
        console.error('Erro ao excluir arquivo físico de layout importado:', e);
      }
    }
    await db.run('DELETE FROM arquivos_importados WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);

    // 3. Excluir dados subordinados das tabelas filhas
    await db.run('DELETE FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, id]);
    await db.run('DELETE FROM Projeto_Materiais WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);
    await db.run('DELETE FROM Projeto_Pecas WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);
    await db.run('DELETE FROM Projeto_Modulo WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);
    await db.run('DELETE FROM Projeto_Chapa WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);

    // 4. Excluir o projeto principal
    await db.run('DELETE FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);

    res.json({ message: 'Projeto e todos os seus dados subordinados foram removidos com sucesso.' });
  } catch (error) {
    console.error('DELETE PROJECT ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir projeto e seus dados subordinados.' });
  }
});

// PUT /api/projetos/:id/precificacao
app.put('/api/projetos/:id/precificacao', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
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
    const project = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
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
      WHERE empresa_id = ? AND id = ?
    `, [
      perc_imposto !== undefined && perc_imposto !== null ? parseFloat(perc_imposto) : null,
      perc_comissao !== undefined && perc_comissao !== null ? parseFloat(perc_comissao) : null,
      perc_custo_financeiro !== undefined && perc_custo_financeiro !== null ? parseFloat(perc_custo_financeiro) : null,
      perc_markup_lucro !== undefined && perc_markup_lucro !== null ? parseFloat(perc_markup_lucro) : null,
      preco_venda_sugerido !== undefined && preco_venda_sugerido !== null ? parseFloat(preco_venda_sugerido) : 0,
      preco_venda_final !== undefined && preco_venda_final !== null ? parseFloat(preco_venda_final) : 0,
      empresaId,
      id
    ]);

    const updatedProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero AND o.empresa_id = p.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = p.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);

    res.json(updatedProject);
  } catch (error) {
    console.error('UPDATE PROJECT PRICING ERROR:', error);
    res.status(500).json({ error: 'Erro ao salvar precificação do projeto.' });
  }
});

// Função para gerar descrição detalhada do projeto
async function buildProjectDescriptionFromDB(projectId, empresaId = null) {
  try {
    let resolvedEmpresaId = empresaId;
    if (!resolvedEmpresaId) {
      const pRow = await db.get('SELECT empresa_id FROM projetos WHERE id = ?', [projectId]);
      if (!pRow) return '';
      resolvedEmpresaId = pRow.empresa_id;
    }

    const proj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [resolvedEmpresaId, projectId]);
    if (!proj) return '';

    const chapas = await db.all('SELECT * FROM Projeto_Chapa WHERE empresa_id = ? AND projeto_id = ?', [resolvedEmpresaId, projectId]);

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
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
      WHERE pi.empresa_id = ? AND pi.ProjetoID = ? 
        AND pi.ProjetoItemQtd > 0
        AND (
          COALESCE(m.ProdutoGrupo, 8) = 1 
          OR m.MaterialDescricao LIKE 'MDF%' 
          OR m.MaterialDescricao LIKE 'MDP%' 
          OR m.MaterialDescricao LIKE 'Chapa MDF%'
          OR COALESCE(m.ExibirNaProposta, 'Nao') = 'Sim'
        )
      ORDER BY pi.ProjetoItemID ASC
    `, [resolvedEmpresaId, projectId]);

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
        LEFT JOIN Material m ON pm.referencia = m.MaterialReferencia AND pm.empresa_id = m.empresa_id
        WHERE pm.empresa_id = ? AND pm.projeto_id = ?
          AND pm.qtd > 0
          AND (
            COALESCE(m.ProdutoGrupo, 8) = 1 
            OR pm.descricao LIKE 'MDF%' 
            OR pm.descricao LIKE 'MDP%' 
            OR pm.descricao LIKE 'Chapa MDF%'
            OR COALESCE(m.ExibirNaProposta, 'Nao') = 'Sim'
          )
        ORDER BY pm.id ASC
      `, [resolvedEmpresaId, projectId]);
    }

    const cleanMdfName = (str) => {
      if (!str) return '';
      let s = str.replace(/\\/g, ' ');
      s = s.replace(/^(chapa\s+)?(mdf|mdp)\s*[-:]?\s*/i, '');
      s = s.replace(/^\d+\s*-\s*/, '');
      s = s.replace(/espessura\s*\d+\s*mm/gi, '');
      s = s.replace(/\s*-\s*\d+\s*mm\b/gi, '');
      s = s.replace(/\b\d+\s*mm\b/gi, '');
      s = s.replace(/\b(horizontal|vertical)\b/gi, '');
      s = s.replace(/natrual/gi, 'Natural');
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

    const mdfItems = items.filter(i => 
      (i.ProdutoGrupo === 1 || /^(mdf|mdp|chapa\s+mdf)/i.test(i.MaterialDescricao || '')) && 
      i.MaterialTipo !== 'Serviço'
    );
    let mdfNames = mdfItems.map(i => cleanMdfName(i.MaterialDescricao)).filter(Boolean);

    if (chapas.length > 0) {
      chapas.forEach(c => {
        const name = cleanMdfName(c.acabamento || c.DescChapa || c.chapa);
        if (name) mdfNames.push(name);
      });
    }
    
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const owned = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!owned) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const descricao = await buildProjectDescriptionFromDB(id, empresaId);
    res.json({ descricao });
  } catch (error) {
    console.error('GET DESCRICAO SUGERIDA ERROR:', error);
    res.status(500).json({ error: 'Erro ao gerar descrição sugerida do projeto.' });
  }
});

// POST /api/projetos/:id/gerar-descricao
app.post('/api/projetos/:id/gerar-descricao', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const owned = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!owned) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const descricao = await buildProjectDescriptionFromDB(id, empresaId);
    if (descricao) {
      await db.run('UPDATE projetos SET descricao = ? WHERE empresa_id = ? AND id = ?', [descricao, empresaId, id]);
    }
    const updatedProj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(updatedProj);
  } catch (error) {
    console.error('POST GERAR DESCRICAO ERROR:', error);
    res.status(500).json({ error: 'Erro ao gerar e salvar descrição do projeto.' });
  }
});

// Helper para associar sequência da tabela de servicos aos itens de projeto
async function enrichProjectItemsWithServicoSequencia(items, empresaId = 1) {
  if (!items || !Array.isArray(items) || items.length === 0) return items;
  try {
    const servicosList = await db.all('SELECT id, nome, unidade, tempo, sequencia FROM servicos WHERE empresa_id = ? ORDER BY sequencia ASC, id ASC', [empresaId]);
    
    const normalize = (str) => (str || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .trim();

    return items.map(item => {
      const isServico = item.MaterialTipo === 'Serviço' || (item.MaterialReferencia && item.MaterialReferencia.startsWith('FAB.'));
      if (!isServico) {
        return {
          ...item,
          sequencia: null,
          servico_sequencia: null,
          servico_id: null
        };
      }

      const itemDescNorm = normalize(item.MaterialDescricao);
      const itemRefNorm = normalize(item.MaterialReferencia);

      let matchedServico = servicosList.find(s => {
        const sNomeNorm = normalize(s.nome);
        if (sNomeNorm === itemDescNorm) return true;
        if (itemDescNorm.includes(sNomeNorm) || sNomeNorm.includes(itemDescNorm)) return true;
        
        if ((itemRefNorm.includes('cor') || itemRefNorm.includes('sep') || itemDescNorm.includes('corte') || itemDescNorm.includes('separacao')) && (sNomeNorm.includes('separacao') || sNomeNorm.includes('corte'))) return true;
        if ((itemRefNorm.includes('usi') || itemDescNorm.includes('usinagem')) && sNomeNorm.includes('usinagem')) return true;
        if ((itemRefNorm.includes('fit') || itemDescNorm.includes('fitagem')) && sNomeNorm.includes('fitagem')) return true;
        if ((itemRefNorm.includes('mon cxa') || itemRefNorm.includes('mon') || itemDescNorm.includes('montagem de caixa') || itemDescNorm.includes('montagem caixa')) && (sNomeNorm.includes('montagem de caixa') || sNomeNorm.includes('montagem'))) return true;
        if ((itemRefNorm.includes('esp') || itemDescNorm.includes('especial')) && sNomeNorm.includes('especial')) return true;
        if ((itemRefNorm.includes('emb') || itemDescNorm.includes('embalagem')) && sNomeNorm.includes('embalagem')) return true;

        return false;
      });

      const seq = matchedServico && matchedServico.sequencia !== undefined && matchedServico.sequencia !== null
        ? matchedServico.sequencia
        : 999;

      return {
        ...item,
        sequencia: seq,
        servico_sequencia: seq,
        servico_id: matchedServico ? matchedServico.id : null,
        servico_nome: matchedServico ? matchedServico.nome : item.MaterialDescricao
      };
    });
  } catch (err) {
    console.error('Erro ao enriquecer itens com sequencia de servicos:', err);
    return items;
  }
}

// GET /api/projetos/:id/itens
app.get('/api/projetos/:id/itens', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const owned = await db.get('SELECT id FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!owned) return res.status(404).json({ error: 'Projeto não encontrado.' });

    // Garante que a tabela ProjetoItem está populada a partir de Projeto_Materiais se necessário
    await ensureProjetoItemsPopulated(id, empresaId);

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
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
      WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
      ORDER BY pi.ProjetoItemID ASC
    `, [empresaId, id]);

    const enrichedList = await enrichProjectItemsWithServicoSequencia(list, empresaId);
    res.json(enrichedList);
  } catch (error) {
    console.error('GET PROJECT ITEMS ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar itens do orçamento do projeto.' });
  }
});

// POST /api/projetos/:id/itens
app.post('/api/projetos/:id/itens', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { MaterialReferencia, ProjetoItemQtd } = req.body;
  if (!MaterialReferencia || ProjetoItemQtd === undefined) {
    return res.status(400).json({ error: 'Material e quantidade são obrigatórios.' });
  }

  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      LEFT JOIN orcamentos o ON p.orcamento_numero = o.numero AND p.empresa_id = o.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);
    if (!projCheck) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    if (projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter novos itens adicionados.' });
    }

    const mat = await db.get('SELECT * FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?', [empresaId, MaterialReferencia]);
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
      const monItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.MON.CXA']);
      const espItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.ESP.PCA']);
      const sumQtd = (monItem ? (parseFloat(monItem.ProjetoItemQtd) || 0) : 0) + (espItem ? (parseFloat(espItem.ProjetoItemQtd) || 0) : 0);
      if (sumQtd > 0 || qtd === 0) {
        qtd = sumQtd;
      }
    }

    const total = vlrUnit * qtd;
    const tempo = parseInt(mat.MaterialTempo, 10) || 0;
    const duracao = Math.round(tempo * qtd);

    const seqRow = await db.get('SELECT MAX(ProjetoItemID) as maxSeq FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, id]);
    const nextSeq = seqRow && seqRow.maxSeq ? seqRow.maxSeq + 1 : 1;

    await db.run(
      `INSERT INTO ProjetoItem (empresa_id, ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [empresaId, id, nextSeq, MaterialReferencia, vlrUnit, unidade, qtd, total, tempo, duracao]
    );

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id, empresaId);

    const proj = await db.get('SELECT CustoTotal, DuracaoFabricacao FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    const newTotal = proj ? (proj.CustoTotal || 0.0) : 0.0;

    res.status(201).json({
      ProjetoID: parseInt(id, 10),
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
  const empresaId = req.auth.empresaId;
  const { id, itemId } = req.params;
  const { ProjetoItemQtd } = req.body;
  if (ProjetoItemQtd === undefined) {
    return res.status(400).json({ error: 'A quantidade é obrigatória.' });
  }

  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      LEFT JOIN orcamentos o ON p.orcamento_numero = o.numero AND p.empresa_id = o.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);
    if (!projCheck) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    if (projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter seus itens alterados.' });
    }

    const item = await db.get('SELECT * FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID = ?', [empresaId, id, itemId]);
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
      const mat = await db.get('SELECT MaterialTempo FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?', [empresaId, item.MaterialReferencia]);
      tempo = mat ? (parseInt(mat.MaterialTempo, 10) || 0) : 0;
    }
    const duracao = Math.round((parseInt(tempo, 10) || 0) * qtd);

    await db.run(
      'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemTempo = ?, ProjetoItemDuracao = ? WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID = ?',
      [qtd, total, tempo, duracao, empresaId, id, itemId]
    );

    // Se a quantidade de FAB.MON.CXA ou FAB.ESP.PCA for alterada, recalcula automaticamente FAB.EMB.UND na tabela ProjetoItem
    if (item.MaterialReferencia === 'FAB.MON.CXA' || item.MaterialReferencia === 'FAB.ESP.PCA') {
      const embItem = await db.get('SELECT * FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.EMB.UND']);
      if (embItem) {
        const monItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.MON.CXA']);
        const espItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.ESP.PCA']);
        const sumQtd = (monItem ? (parseFloat(monItem.ProjetoItemQtd) || 0) : 0) + (espItem ? (parseFloat(espItem.ProjetoItemQtd) || 0) : 0);
        const embVlrUnit = embItem.ProjetoItemVlrUnit || 0.0;
        const embTotal = embVlrUnit * sumQtd;
        const embTempo = parseInt(embItem.ProjetoItemTempo, 10) || 0;
        const embDuracao = Math.round(embTempo * sumQtd);
        await db.run(
          'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemDuracao = ? WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?',
          [sumQtd, embTotal, embDuracao, empresaId, id, 'FAB.EMB.UND']
        );
      }
    }

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id, empresaId);

    const proj = await db.get('SELECT CustoTotal, DuracaoFabricacao FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    const newTotal = proj ? (proj.CustoTotal || 0.0) : 0.0;

    res.json({
      success: true,
      ProjetoID: parseInt(id, 10),
      ProjetoItemID: parseInt(itemId, 10),
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
  const empresaId = req.auth.empresaId;
  const { id, itemId } = req.params;
  try {
    const projCheck = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      LEFT JOIN orcamentos o ON p.orcamento_numero = o.numero AND p.empresa_id = o.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);
    if (!projCheck) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    if (projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter seus itens removidos.' });
    }

    const item = await db.get('SELECT * FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID = ?', [empresaId, id, itemId]);
    if (!item) {
      return res.status(404).json({ error: 'Item não encontrado.' });
    }

    await db.run('DELETE FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID = ?', [empresaId, id, itemId]);

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id, empresaId);
    
    const sumRow = await db.get('SELECT SUM(ProjetoItemTotal) as sumTotal FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, id]);
    const newTotal = sumRow && sumRow.sumTotal ? sumRow.sumTotal : 0.0;

    res.json({ success: true, message: 'Item removido com sucesso.', CustoTotal: newTotal });
  } catch (error) {
    console.error('DELETE PROJECT ITEM ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir item do projeto.' });
  }
});

// POST /api/projetos/:id/substituir-materiais - Substituição em lote de materiais em itens do projeto
app.post('/api/projetos/:id/substituir-materiais', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
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
      LEFT JOIN orcamentos o ON p.orcamento_numero = o.numero AND p.empresa_id = o.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);
    
    if (!projCheck) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    if (projCheck.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter seus materiais alterados.' });
    }

    const mat = await db.get('SELECT * FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?', [empresaId, novoMaterialReferencia]);
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
      const sumRow = await db.get(`SELECT SUM(ProjetoItemQtd) as totalQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID IN (${placeholders})`, [empresaId, id, ...itemIds]);
      qtdToInsert = sumRow && sumRow.totalQtd ? parseFloat(sumRow.totalQtd) : 1;
    }

    const total = vlrUnit * qtdToInsert;
    const duracao = Math.round(tempo * qtdToInsert);

    // 1. Obter próximo ProjetoItemID
    const seqRow = await db.get('SELECT MAX(ProjetoItemID) as maxSeq FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, id]);
    const nextSeq = seqRow && seqRow.maxSeq ? seqRow.maxSeq + 1 : 1;

    // 2. Incluir o novo material consolidado na lista de ProjetoItem
    await db.run(
      `INSERT INTO ProjetoItem (empresa_id, ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [empresaId, id, nextSeq, novoMaterialReferencia, vlrUnit, unidade, qtdToInsert, total, tempo, duracao]
    );

    // 3. Excluir os itens substituídos da lista de materiais inseridos
    const delPlaceholders = itemIds.map(() => '?').join(',');
    await db.run(
      `DELETE FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND ProjetoItemID IN (${delPlaceholders})`,
      [empresaId, id, ...itemIds]
    );

    // 4. Se o serviço for FAB.MON.CXA ou FAB.ESP.PCA, ajusta FAB.EMB.UND
    const monItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.MON.CXA']);
    const espItem = await db.get('SELECT ProjetoItemQtd FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.ESP.PCA']);
    const embItem = await db.get('SELECT * FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?', [empresaId, id, 'FAB.EMB.UND']);
    if (embItem) {
      const sumQtd = (monItem ? (parseFloat(monItem.ProjetoItemQtd) || 0) : 0) + (espItem ? (parseFloat(espItem.ProjetoItemQtd) || 0) : 0);
      const embVlrUnit = embItem.ProjetoItemVlrUnit || 0.0;
      const embTotal = embVlrUnit * sumQtd;
      const embTempo = parseInt(embItem.ProjetoItemTempo, 10) || 0;
      const embDuracao = Math.round(embTempo * sumQtd);
      await db.run(
        'UPDATE ProjetoItem SET ProjetoItemQtd = ?, ProjetoItemTotal = ?, ProjetoItemDuracao = ? WHERE empresa_id = ? AND ProjetoID = ? AND MaterialReferencia = ?',
        [sumQtd, embTotal, embDuracao, empresaId, id, 'FAB.EMB.UND']
      );
    }

    // 5. Recalcular custos consolidados do projeto
    await recalculateProjectCosts(id, empresaId);

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
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
      WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
      ORDER BY pi.ProjetoItemID ASC
    `, [empresaId, id]);

    const proj = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);

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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const proj = await db.get(`
      SELECT p.*, o.status as orcamento_status 
      FROM projetos p 
      LEFT JOIN orcamentos o ON p.orcamento_numero = o.numero AND p.empresa_id = o.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);

    if (!proj) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    if (proj.orcamento_status === 'Aprovado') {
      return res.status(400).json({ error: 'Orçamentos Aprovados não podem ter os preços de seus materiais alterados.' });
    }

    // Update ProjetoItem with latest MaterialValorUnitario from the same company
    await db.run(`
      UPDATE ProjetoItem pi
      JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
      SET 
        pi.ProjetoItemVlrUnit = COALESCE(m.MaterialValorUnitario, pi.ProjetoItemVlrUnit),
        pi.ProjetoItemTotal = pi.ProjetoItemQtd * COALESCE(m.MaterialValorUnitario, pi.ProjetoItemVlrUnit)
      WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
    `, [empresaId, id]);

    // Recalculate project consolidated costs
    await recalculateProjectCosts(id, empresaId);

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
      LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
      WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
      ORDER BY pi.ProjetoItemID ASC
    `, [empresaId, id]);

    const finalProject = await db.get(`
      SELECT 
        p.*, 
        pf.nome AS parametro_nome,
        pf.situacao AS parametro_situacao
      FROM projetos p
      LEFT JOIN orcamentos o ON o.numero = p.orcamento_numero AND o.empresa_id = p.empresa_id
      LEFT JOIN Parametro_Financeiro pf ON pf.id = o.parametro_financeiro_id AND pf.empresa_id = p.empresa_id
      WHERE p.empresa_id = ? AND p.id = ?
    `, [empresaId, id]);

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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const project = await db.get('SELECT * FROM projetos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    const materials = await db.all('SELECT * FROM Projeto_Materiais WHERE empresa_id = ? AND projeto_id = ?', [empresaId, id]);

    await db.run('BEGIN TRANSACTION');

    // 1 - Limpa itens antigos para este projeto na tabela ProjetoItem
    await db.run('DELETE FROM ProjetoItem WHERE empresa_id = ? AND ProjetoID = ?', [empresaId, id]);

    let currentSeq = 1;
    let custoTotal = 0;

    // Calcula a quantidade de FAB.EMB.UND com base na soma de FAB.MON.CXA + FAB.ESP.PCA
    const monItem = materials.find(m => m.referencia === 'FAB.MON.CXA');
    const espItem = materials.find(m => m.referencia === 'FAB.ESP.PCA');
    const qtdMonCxa = monItem ? (parseFloat(monItem.qtd) || 0.0) : 0.0;
    const qtdEspPca = espItem ? (parseFloat(espItem.qtd) || 0.0) : 0.0;
    const qtdEmbUnd = qtdMonCxa + qtdEspPca;

    for (const m of materials) {
      if (m.referencia === 'FAB.QTD.PCA') continue;

      let globalMat = await db.get('SELECT * FROM Material WHERE empresa_id = ? AND MaterialReferencia = ?', [empresaId, m.referencia]);
      
      if (!globalMat) {
        let normUn = (m.un || '').toUpperCase().trim();
        if (normUn === 'UN') normUn = 'UNI';
        const allowedUnits = ['CHP', 'M2', 'M', 'L', 'UNI', 'PAR', 'KG', 'CXA', 'VAR', 'DIA'];
        if (!allowedUnits.includes(normUn)) {
          normUn = 'UNI';
        }
        const matTipo = (m.tipo || (m.referencia && m.referencia.startsWith('FAB.') ? 'Serviço' : 'Produto'));
        await db.run(
          `INSERT INTO Material (empresa_id, MaterialReferencia, MaterialDescricao, MaterialUnidade, MaterialValorUnitario, GrupoSigla, ProdutoGrupo, MaterialTipo, MaterialTempo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [empresaId, m.referencia, m.descricao || m.referencia, normUn, 0.0, null, 8, matTipo, 0]
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
        `INSERT INTO ProjetoItem (empresa_id, ProjetoID, ProjetoItemID, MaterialReferencia, ProjetoItemVlrUnit, ProjetoItemUnidade, ProjetoItemQtd, ProjetoItemTotal, ProjetoItemTempo, ProjetoItemDuracao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [empresaId, id, currentSeq, m.referencia, vlrUnit, unidade, qtd, total, tempo, duracao]
      );
      custoTotal += total;
      currentSeq++;
    }

    // Recalculate project consolidated costs and total duration
    await recalculateProjectCosts(id, empresaId);

    // Auto-generate project description if empty
    if (!project.descricao || project.descricao.trim() === '') {
      const autoDesc = await buildProjectDescriptionFromDB(id, empresaId);
      if (autoDesc) {
        await db.run('UPDATE projetos SET descricao = ? WHERE empresa_id = ? AND id = ?', [autoDesc, empresaId, id]);
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
  const empresaId = req.auth.empresaId;
  const { situacao } = req.query;
  try {
    let query = `
      SELECT 
        pf.id, 
        pf.empresa_id,
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
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = pf.empresa_id
      WHERE pf.empresa_id = ?
    `;
    const params = [empresaId];
    if (situacao) {
      query += ` AND pf.situacao = ?`;
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const item = await db.get(`
      SELECT 
        pf.id, 
        pf.empresa_id,
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
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = pf.empresa_id
      WHERE pf.empresa_id = ? AND pf.id = ?
    `, [empresaId, id]);
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
  const empresaId = req.auth.empresaId;
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
      'INSERT INTO Parametro_Financeiro (empresa_id, nome, situacao) VALUES (?, ?, ?)',
      [empresaId, nome.trim(), situacao || 'Ativado']
    );
    const parametroId = result.lastID;

    await db.run(`
      INSERT INTO configuracoes_financeiras (empresa_id, parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      empresaId,
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
        pf.empresa_id,
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
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = pf.empresa_id
      WHERE pf.empresa_id = ? AND pf.id = ?
    `, [empresaId, parametroId]);

    res.status(201).json(created);
  } catch (error) {
    console.error('CREATE PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar parâmetro financeiro.' });
  }
});

app.put('/api/parametros-financeiros/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
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
    const existing = await db.get('SELECT * FROM Parametro_Financeiro WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!existing) {
      return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
    }

    await db.run(
      'UPDATE Parametro_Financeiro SET nome = ?, situacao = ? WHERE empresa_id = ? AND id = ?',
      [nome.trim(), situacao || 'Ativado', empresaId, id]
    );

    const conf = await db.get('SELECT * FROM configuracoes_financeiras WHERE empresa_id = ? AND parametro_id = ?', [empresaId, id]);
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
        WHERE empresa_id = ? AND parametro_id = ?
      `, [
        parseFloat(perc_imposto) || 0,
        parseFloat(perc_comissao) || 0,
        parseFloat(perc_custo_financeiro) || 0,
        parseFloat(perc_markup_lucro) || 0,
        parseFloat(perc_margem_minima) || 0,
        metodo_calculo || 'divisor',
        empresaId,
        id
      ]);
    } else {
      await db.run(`
        INSERT INTO configuracoes_financeiras (empresa_id, parametro_id, perc_imposto, perc_comissao, perc_custo_financeiro, perc_markup_lucro, perc_margem_minima, metodo_calculo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        empresaId,
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
        pf.empresa_id,
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
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = pf.empresa_id
      WHERE pf.empresa_id = ? AND pf.id = ?
    `, [empresaId, id]);

    res.json(updated);
  } catch (error) {
    console.error('UPDATE PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar parâmetro financeiro.' });
  }
});

app.delete('/api/parametros-financeiros/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM Parametro_Financeiro WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!existing) {
      return res.status(404).json({ error: 'Parâmetro financeiro não encontrado.' });
    }

    const inUse = await db.get('SELECT COUNT(*) as count FROM orcamentos WHERE empresa_id = ? AND parametro_financeiro_id = ?', [empresaId, id]);
    if (inUse && inUse.count > 0) {
      return res.status(400).json({ error: `Este parâmetro está vinculado a ${inUse.count} orçamento(s) e não pode ser excluído. Em vez disso, altere a situação para 'Desativado'.` });
    }

    await db.run('DELETE FROM configuracoes_financeiras WHERE empresa_id = ? AND parametro_id = ?', [empresaId, id]);
    await db.run('DELETE FROM Parametro_Financeiro WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ message: 'Parâmetro financeiro removido com sucesso.' });
  } catch (error) {
    console.error('DELETE PARAMETRO FINANCEIRO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir parâmetro financeiro.' });
  }
});

app.get('/api/configuracoes/financeiro', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  try {
    let config = await db.get(`
      SELECT 
        pf.id, 
        pf.empresa_id,
        pf.nome, 
        pf.situacao, 
        cf.perc_imposto, 
        cf.perc_comissao, 
        cf.perc_custo_financeiro, 
        cf.perc_markup_lucro, 
        cf.perc_margem_minima, 
        cf.metodo_calculo
      FROM Parametro_Financeiro pf
      LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = pf.empresa_id
      WHERE pf.empresa_id = ? AND pf.situacao = 'Ativado'
      ORDER BY pf.id ASC
      LIMIT 1
    `, [empresaId]);
    if (!config) {
      config = await db.get(`
        SELECT 
          pf.id, 
          pf.empresa_id,
          pf.nome, 
          pf.situacao, 
          cf.perc_imposto, 
          cf.perc_comissao, 
          cf.perc_custo_financeiro, 
          cf.perc_markup_lucro, 
          cf.perc_margem_minima, 
          cf.metodo_calculo
        FROM Parametro_Financeiro pf
        LEFT JOIN configuracoes_financeiras cf ON cf.parametro_id = pf.id AND cf.empresa_id = pf.empresa_id
        WHERE pf.empresa_id = ?
        ORDER BY pf.id ASC
        LIMIT 1
      `, [empresaId]);
    }
    res.json(config || {
      id: 1,
      empresa_id: empresaId,
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
  const empresaId = req.auth.empresaId;
  try {
    const formas = await db.all('SELECT * FROM formas_pagamento WHERE empresa_id = ? ORDER BY ordem ASC, id ASC', [empresaId]);
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? ORDER BY ordem ASC, id ASC', [empresaId]);

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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const forma = await db.get('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!forma) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND forma_pagamento_id = ? ORDER BY ordem ASC, id ASC', [empresaId, id]);
    res.json({ ...forma, condicoes });
  } catch (error) {
    console.error('GET FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar forma de pagamento.' });
  }
});

// POST /api/formas-pagamento
app.post('/api/formas-pagamento', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
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
      `INSERT INTO formas_pagamento (empresa_id, nome, descricao, valor_minimo, valor_maximo, ativo, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [empresaId, nome.trim(), (descricao || '').trim(), vMin, vMax, isAtivo, ord]
    );

    const formaId = result.lastID;

    if (Array.isArray(condicoes) && condicoes.length > 0) {
      for (let i = 0; i < condicoes.length; i++) {
        const c = condicoes[i];
        if (c.descricao && c.descricao.trim()) {
          await db.run(
            `INSERT INTO condicoes_pagamento (empresa_id, forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              empresaId,
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

    const createdForma = await db.get('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, formaId]);
    const createdCondicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND forma_pagamento_id = ? ORDER BY ordem ASC, id ASC', [empresaId, formaId]);
    res.status(201).json({ ...createdForma, condicoes: createdCondicoes });
  } catch (error) {
    console.error('POST FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar forma de pagamento.' });
  }
});

// PUT /api/formas-pagamento/:id
app.put('/api/formas-pagamento/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { nome, descricao, valor_minimo, valor_maximo, ativo, ordem } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'Nome da forma de pagamento é obrigatório.' });
  }

  try {
    const existing = await db.get('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
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
       WHERE empresa_id = ? AND id = ?`,
      [nome.trim(), (descricao !== undefined ? descricao : existing.descricao || '').trim(), vMin, vMax, isAtivo, ord, empresaId, id]
    );

    const updated = await db.get('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND forma_pagamento_id = ? ORDER BY ordem ASC, id ASC', [empresaId, id]);
    res.json({ ...updated, condicoes });
  } catch (error) {
    console.error('PUT FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar forma de pagamento.' });
  }
});

// DELETE /api/formas-pagamento/:id
app.delete('/api/formas-pagamento/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!existing) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }

    await db.run('DELETE FROM condicoes_pagamento WHERE empresa_id = ? AND forma_pagamento_id = ?', [empresaId, id]);
    await db.run('DELETE FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ message: 'Forma de pagamento excluída com sucesso.' });
  } catch (error) {
    console.error('DELETE FORMA PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir forma de pagamento.' });
  }
});

// POST /api/formas-pagamento/:id/condicoes
app.post('/api/formas-pagamento/:id/condicoes', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ error: 'Descrição da condição é obrigatória.' });
  }

  try {
    const forma = await db.get('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!forma) {
      return res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    }

    const result = await db.run(
      `INSERT INTO condicoes_pagamento (empresa_id, forma_pagamento_id, perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empresaId,
        id,
        parseFloat(perc_entrada) || 0,
        parseInt(num_parcelas, 10) || 0,
        parseFloat(perc_desconto) || 0,
        (meio_pagamento || '').trim(),
        descricao.trim(),
        parseInt(ordem, 10) || 1
      ]
    );

    const createdCondicao = await db.get('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, result.lastID]);
    res.status(201).json(createdCondicao);
  } catch (error) {
    console.error('POST CONDICAO PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao criar condição de pagamento.' });
  }
});

// PUT /api/condicoes-pagamento/:id
app.put('/api/condicoes-pagamento/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { perc_entrada, num_parcelas, perc_desconto, meio_pagamento, descricao, ordem } = req.body;

  if (!descricao || !descricao.trim()) {
    return res.status(400).json({ error: 'Descrição da condição é obrigatória.' });
  }

  try {
    const existing = await db.get('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!existing) {
      return res.status(404).json({ error: 'Condição de pagamento não encontrada.' });
    }

    await db.run(
      `UPDATE condicoes_pagamento 
       SET perc_entrada = ?, num_parcelas = ?, perc_desconto = ?, meio_pagamento = ?, descricao = ?, ordem = ?
       WHERE empresa_id = ? AND id = ?`,
      [
        perc_entrada !== undefined ? (parseFloat(perc_entrada) || 0) : existing.perc_entrada,
        num_parcelas !== undefined ? (parseInt(num_parcelas, 10) || 0) : existing.num_parcelas,
        perc_desconto !== undefined ? (parseFloat(perc_desconto) || 0) : existing.perc_desconto,
        meio_pagamento !== undefined ? (meio_pagamento || '').trim() : existing.meio_pagamento,
        descricao.trim(),
        ordem !== undefined ? (parseInt(ordem, 10) || 1) : existing.ordem,
        empresaId,
        id
      ]
    );

    const updated = await db.get('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(updated);
  } catch (error) {
    console.error('PUT CONDICAO PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar condição de pagamento.' });
  }
});

// DELETE /api/condicoes-pagamento/:id
app.delete('/api/condicoes-pagamento/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!existing) {
      return res.status(404).json({ error: 'Condição de pagamento não encontrada.' });
    }

    await db.run('DELETE FROM condicoes_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ message: 'Condição de pagamento excluída com sucesso.' });
  } catch (error) {
    console.error('DELETE CONDICAO PAGAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir condição de pagamento.' });
  }
});

// ==========================================
// GESTÃO E HISTÓRICO DE PROPOSTAS COMERCIAIS
// ==========================================

// GET /api/orcamentos/:numero/propostas - Listar todas as propostas salvas do orçamento
app.get('/api/orcamentos/:numero/propostas', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  try {
    const orc = await db.get('SELECT numero FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!orc) return res.status(404).json({ error: 'Orçamento não encontrado.' });

    const list = await db.all(
      `SELECT id, empresa_id, orcamento_numero, versao, codigo, titulo, descricao, valor_total, 
              desconto_percentual, desconto_valor, valor_final, forma_pagamento_selecionada, 
              status, observacoes, criado_por, criado_por_nome, criado_em, updated_at
       FROM propostas 
       WHERE empresa_id = ? AND orcamento_numero = ? 
       ORDER BY versao DESC, id DESC`,
      [empresaId, numero]
    );
    res.json(list || []);
  } catch (error) {
    console.error('GET ORCAMENTO PROPOSTAS ERROR:', error);
    res.status(500).json({ error: 'Erro ao listar propostas do orçamento.' });
  }
});

// POST /api/orcamentos/:numero/propostas - Gerar nova versão da proposta para o orçamento
app.post('/api/orcamentos/:numero/propostas', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  const { titulo, observacoes, status } = req.body || {};
  try {
    const orc = await db.get(
      `SELECT o.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.email as cliente_email,
              c.documento as cliente_documento, c.endereco as cliente_endereco
       FROM orcamentos o 
       LEFT JOIN clientes c ON o.cliente_id = c.id AND o.empresa_id = c.empresa_id
       WHERE o.empresa_id = ? AND o.numero = ?`,
      [empresaId, numero]
    );
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    // Buscar projetos do orçamento
    const projetos = await db.all('SELECT * FROM projetos WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY id ASC', [empresaId, numero]);

    // Buscar itens e anexos dos projetos
    const itensPorProjeto = {};
    const anexosPorProjeto = {};
    for (const p of projetos) {
      let itens = await db.all(`
        SELECT 
          pi.ProjetoID, pi.ProjetoItemID, pi.MaterialReferencia, m.MaterialDescricao,
          m.MaterialTipo AS MaterialTipo, m.MaterialImagem,
          COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
          COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
          pi.ProjetoItemVlrUnit, pi.ProjetoItemUnidade, pi.ProjetoItemQtd,
          pi.ProjetoItemTotal, pi.ProjetoItemTempo, pi.ProjetoItemDuracao
        FROM ProjetoItem pi
        LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
        WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
        ORDER BY pi.ProjetoItemID ASC
      `, [empresaId, p.id]);

      if (!itens || itens.length === 0) {
        itens = await db.all(`
          SELECT 
            pm.projeto_id AS ProjetoID, pm.id AS ProjetoItemID, pm.referencia AS MaterialReferencia,
            COALESCE(m.MaterialDescricao, pm.descricao) AS MaterialDescricao,
            m.MaterialTipo AS MaterialTipo, m.MaterialImagem,
            COALESCE(m.ExibirNaProposta, 'Nao') AS ExibirNaProposta,
            COALESCE(m.ProdutoGrupo, 8) AS ProdutoGrupo,
            COALESCE(m.MaterialValorUnitario, 0.0) AS ProjetoItemVlrUnit,
            COALESCE(m.MaterialUnidade, pm.un, 'UN') AS ProjetoItemUnidade,
            pm.qtd AS ProjetoItemQtd,
            (pm.qtd * COALESCE(m.MaterialValorUnitario, 0.0)) AS ProjetoItemTotal,
            COALESCE(m.MaterialTempo, 0) AS ProjetoItemTempo,
            0 AS ProjetoItemDuracao
          FROM Projeto_Materiais pm
          LEFT JOIN Material m ON pm.referencia = m.MaterialReferencia AND pm.empresa_id = m.empresa_id
          WHERE pm.empresa_id = ? AND pm.projeto_id = ?
          ORDER BY pm.id ASC
        `, [empresaId, p.id]);
      }
      itensPorProjeto[p.id] = itens || [];

      const anexos = await db.all('SELECT * FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ? ORDER BY id ASC', [empresaId, p.id]);
      anexosPorProjeto[p.id] = anexos || [];
    }

    // Buscar Formas de Pagamento e Condições da empresa
    const formas = await db.all('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND ativo = "Sim" ORDER BY ordem ASC, id ASC', [empresaId]);
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? ORDER BY ordem ASC, id ASC', [empresaId]);
    const formasComCondicoes = (formas || []).map(f => ({
      ...f,
      condicoes: (condicoes || []).filter(c => c.forma_pagamento_id === f.id)
    }));

    // Buscar parâmetros da empresa
    const empresaParamsList = await db.all('SELECT chave, conteudo FROM parametros_empresa WHERE empresa_id = ?', [empresaId]);
    const empresaParams = {};
    (empresaParamsList || []).forEach(p => {
      empresaParams[p.chave] = p.conteudo;
    });

    // Calcular próxima versão
    const lastVersaoRow = await db.get('SELECT MAX(versao) as max_versao FROM propostas WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);
    const novaVersao = (lastVersaoRow?.max_versao ? parseInt(lastVersaoRow.max_versao, 10) : 0) + 1;

    // Calcular valores
    const totalPreco = (projetos || []).reduce((sum, p) => sum + (parseFloat(p.preco_venda_final) || 0), 0) || (parseFloat(orc.total_venda) || 0);
    const descPerc = parseFloat(orc.desconto_percentual) || 0;
    const descValor = parseFloat(orc.desconto_valor) || (totalPreco * (descPerc / 100)) || 0;
    const valorFinal = Math.max(0, totalPreco - descValor);

    const codigo = `PROP-${numero}-v${novaVersao}`;
    const tituloFinal = titulo || `Proposta Comercial #${numero} (v${novaVersao})`;
    const statusFinal = status || 'Gerada';
    const userId = req.auth.userId || null;
    const userNome = req.auth.nome || req.user?.nome || req.user?.name || req.user?.login || 'Usuário';

    // Montar snapshot completo
    const snapshot = {
      versao: novaVersao,
      codigo,
      geradoEm: new Date().toISOString(),
      geradoPorNome: userNome,
      orcamento: {
        numero: orc.numero,
        empresa_id: empresaId,
        data_criacao: orc.data_criacao,
        cliente_id: orc.cliente_id,
        cliente_nome: orc.cliente_nome,
        cliente_telefone: orc.cliente_telefone,
        cliente_email: orc.cliente_email,
        cliente_documento: orc.cliente_documento,
        cliente_endereco: orc.cliente_endereco,
        descricao: orc.descricao,
        status: orc.status,
        total_venda: orc.total_venda,
        desconto_percentual: orc.desconto_percentual,
        desconto_valor: orc.desconto_valor,
        forma_pagamento_selecionada: orc.forma_pagamento_selecionada,
        anotacoes_cliente: orc.anotacoes_cliente,
        anotacoes_conclusao: orc.anotacoes_conclusao
      },
      projetos,
      itensPorProjeto,
      anexosPorProjeto,
      formasPagamento: formasComCondicoes,
      empresaParams,
      valores: {
        valor_total: totalPreco,
        desconto_percentual: descPerc,
        desconto_valor: descValor,
        valor_final: valorFinal
      }
    };

    const result = await db.run(
      `INSERT INTO propostas (
        empresa_id, orcamento_numero, versao, codigo, titulo, descricao, valor_total,
        desconto_percentual, desconto_valor, valor_final, forma_pagamento_selecionada,
        dados_snapshot, status, observacoes, criado_por, criado_por_nome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empresaId,
        numero,
        novaVersao,
        codigo,
        tituloFinal,
        orc.descricao || '',
        totalPreco,
        descPerc,
        descValor,
        valorFinal,
        orc.forma_pagamento_selecionada || null,
        JSON.stringify(snapshot),
        statusFinal,
        observacoes || null,
        userId,
        userNome
      ]
    );

    const insertedId = result.lastID;
    const createdProp = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, insertedId]);

    const todasPropostas = await db.all(
      `SELECT id, empresa_id, orcamento_numero, versao, codigo, titulo, descricao, valor_total, 
              desconto_percentual, desconto_valor, valor_final, forma_pagamento_selecionada, 
              status, observacoes, criado_por, criado_por_nome, criado_em, updated_at
       FROM propostas 
       WHERE empresa_id = ? AND orcamento_numero = ? 
       ORDER BY versao DESC, id DESC`,
      [empresaId, numero]
    );

    res.status(201).json({
      ...createdProp,
      propostas: todasPropostas,
      message: `Proposta (Versão ${novaVersao}) gerada com sucesso!`
    });
  } catch (error) {
    console.error('POST GERAR PROPOSTA ERROR:', error);
    res.status(500).json({ error: error.message || 'Erro ao gerar proposta.' });
  }
});

// GET /api/propostas/:id - Detalhes completos da proposta pelo ID (incluindo snapshot)
app.get('/api/propostas/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const prop = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!prop) {
      return res.status(404).json({ error: 'Proposta não encontrada.' });
    }

    let parsedSnapshot = null;
    if (prop.dados_snapshot) {
      try {
        parsedSnapshot = JSON.parse(prop.dados_snapshot);
      } catch (e) {
        parsedSnapshot = null;
      }
    }

    res.json({
      ...prop,
      snapshot: parsedSnapshot
    });
  } catch (error) {
    console.error('GET PROPOSTA DETAIL ERROR:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes da proposta.' });
  }
});

// PUT /api/propostas/:id - Atualizar status, título ou observações da proposta
app.put('/api/propostas/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { status, observacoes, titulo } = req.body || {};
  try {
    const prop = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!prop) {
      return res.status(404).json({ error: 'Proposta não encontrada.' });
    }

    const newStatus = status !== undefined ? status : prop.status;
    const newObs = observacoes !== undefined ? observacoes : prop.observacoes;
    const newTitulo = titulo !== undefined ? titulo : prop.titulo;

    await db.run(
      'UPDATE propostas SET status = ?, observacoes = ?, titulo = ? WHERE empresa_id = ? AND id = ?',
      [newStatus, newObs, newTitulo, empresaId, id]
    );

    // Se o status foi alterado para Aprovada, sincronizar no orçamento
    if (newStatus === 'Aprovada') {
      const orc = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, prop.orcamento_numero]);
      const formaToSet = prop.forma_pagamento_selecionada || orc?.forma_pagamento_selecionada;
      await db.run(
        `UPDATE orcamentos 
         SET status = 'Aprovado', 
             situacao = 'Aprovado',
             data_aprovacao = COALESCE(data_aprovacao, CURRENT_TIMESTAMP),
             forma_pagamento_selecionada = COALESCE(?, forma_pagamento_selecionada)
         WHERE empresa_id = ? AND numero = ?`,
        [formaToSet || null, empresaId, prop.orcamento_numero]
      );
    }

    const updated = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(updated);
  } catch (error) {
    console.error('PUT PROPOSTA ERROR:', error);
    res.status(500).json({ error: 'Erro ao atualizar proposta.' });
  }
});

// DELETE /api/propostas/:id - Excluir versão de proposta
app.delete('/api/propostas/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const prop = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!prop) {
      return res.status(404).json({ error: 'Proposta não encontrada.' });
    }

    await db.run('DELETE FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ message: 'Proposta excluída com sucesso.', id: prop.id, orcamento_numero: prop.orcamento_numero });
  } catch (error) {
    console.error('DELETE PROPOSTA ERROR:', error);
    res.status(500).json({ error: 'Erro ao excluir proposta.' });
  }
});

// ==========================================
// COMPARTILHAMENTO DE PROPOSTA ENDPOINTS
// ==========================================

// POST /api/orcamentos/:numero/compartilhar - Gerar novo token com validade configurável e registrar histórico
app.post('/api/orcamentos/:numero/compartilhar', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  const { diasValidade, proposta_id } = req.body || {};
  try {
    const orc = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const agora = new Date();
    const dias = parseInt(diasValidade, 10) > 0 ? parseInt(diasValidade, 10) : 3;
    const expiraEmDate = new Date(agora.getTime() + dias * 24 * 60 * 60 * 1000);
    const expiraEm = formatDateTimeForMySQL(expiraEmDate);
    const userId = req.auth.userId || null;
    const userNome = req.auth.nome || req.user?.nome || req.user?.name || req.user?.login || 'Usuário';

    let finalPropostaId = proposta_id ? parseInt(proposta_id, 10) : null;
    if (finalPropostaId) {
      const ownedProp = await db.get('SELECT id FROM propostas WHERE empresa_id = ? AND id = ? AND orcamento_numero = ?', [empresaId, finalPropostaId, numero]);
      if (!ownedProp) {
        return res.status(404).json({ error: 'Proposta não encontrada.' });
      }
    } else {
      const latestProp = await db.get('SELECT id FROM propostas WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY versao DESC, id DESC LIMIT 1', [empresaId, numero]);
      if (latestProp?.id) {
        finalPropostaId = latestProp.id;
      }
    }

    const result = await db.run(
      `INSERT INTO proposta_compartilhamentos (empresa_id, orcamento_numero, token, criado_por, criado_por_nome, expira_em, acessos_count, status, proposta_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'Ativo', ?)`,
      [empresaId, numero, token, userId, userNome, expiraEm, finalPropostaId]
    );

    const shareId = result.lastID;
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE empresa_id = ? AND id = ?', [empresaId, shareId]);

    res.status(201).json({
      ...share,
      token,
      proposta_id: finalPropostaId,
      diasValidade: dias,
      message: 'Token de compartilhamento gerado com sucesso.'
    });
  } catch (error) {
    console.error('POST COMPARTILHAR ORCAMENTO ERROR:', error);
    res.status(500).json({ error: error.message || 'Erro ao gerar link de compartilhamento.' });
  }
});

// GET /api/orcamentos/:numero/compartilhamentos - Histórico de compartilhamentos do orçamento
app.get('/api/orcamentos/:numero/compartilhamentos', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  try {
    const orc = await db.get('SELECT numero FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!orc) return res.status(404).json({ error: 'Orçamento não encontrado.' });

    const list = await db.all(
      `SELECT pc.*, p.versao as proposta_versao, p.codigo as proposta_codigo
       FROM proposta_compartilhamentos pc
       LEFT JOIN propostas p ON pc.proposta_id = p.id AND pc.empresa_id = p.empresa_id
       WHERE pc.empresa_id = ? AND pc.orcamento_numero = ? 
       ORDER BY pc.criado_em DESC, pc.id DESC`,
      [empresaId, numero]
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
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const existing = await db.get('SELECT * FROM proposta_compartilhamentos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!existing) {
      return res.status(404).json({ error: 'Registro de compartilhamento não encontrado.' });
    }

    await db.run("UPDATE proposta_compartilhamentos SET status = 'Revogado' WHERE empresa_id = ? AND id = ?", [empresaId, id]);
    const updated = await db.get('SELECT * FROM proposta_compartilhamentos WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(updated);
  } catch (error) {
    console.error('REVOGAR COMPARTILHAMENTO ERROR:', error);
    res.status(500).json({ error: 'Erro ao revogar link compartilhado.' });
  }
});

// GET /api/public/propostas/:token - Acesso público à proposta via Token (exceção controlada: resolve empresa_id exclusivamente pelo token no servidor)
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

    const empresaId = share.empresa_id;

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

    // Registrar e incrementar acesso restrito à empresa do compartilhamento
    await db.run(
      `UPDATE proposta_compartilhamentos 
       SET acessos_count = acessos_count + 1, ultimo_acesso = CURRENT_TIMESTAMP 
       WHERE empresa_id = ? AND id = ?`,
      [empresaId, share.id]
    );

    // Se houver uma versão vinculada ou existente na mesma empresa, utilizar o snapshot da versão gravada
    let propRecord = null;
    if (share.proposta_id) {
      propRecord = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND id = ?', [empresaId, share.proposta_id]);
    }
    if (!propRecord) {
      propRecord = await db.get('SELECT * FROM propostas WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY versao DESC, id DESC LIMIT 1', [empresaId, share.orcamento_numero]);
    }

    let parsedSnapshot = null;
    if (propRecord?.dados_snapshot) {
      try {
        parsedSnapshot = JSON.parse(propRecord.dados_snapshot);
      } catch (e) {
        parsedSnapshot = null;
      }
    }

    // Buscar dados em tempo real do orçamento da mesma empresa
    const orc = await db.get(
      `SELECT o.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.email as cliente_email,
              c.documento as cliente_documento, c.endereco as cliente_endereco
       FROM orcamentos o 
       LEFT JOIN clientes c ON o.cliente_id = c.id AND o.empresa_id = c.empresa_id
       WHERE o.empresa_id = ? AND o.numero = ?`,
      [empresaId, share.orcamento_numero]
    );

    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    if (parsedSnapshot) {
      const formaPagFinal = share.forma_pagamento_selecionada || orc.forma_pagamento_selecionada || parsedSnapshot.orcamento?.forma_pagamento_selecionada;
      const statusFinal = (share.status === 'Aprovado' || orc.status === 'Aprovado' || propRecord?.status === 'Aprovada') ? 'Aprovado' : (orc.status || parsedSnapshot.orcamento?.status || 'Em Aberto');

      const orcSnapshot = {
        ...parsedSnapshot.orcamento,
        status: statusFinal,
        situacao: statusFinal,
        forma_pagamento_selecionada: formaPagFinal,
        anotacoes_cliente: share.anotacoes_cliente || orc.anotacoes_cliente || parsedSnapshot.orcamento?.anotacoes_cliente
      };

      const empresaParams = parsedSnapshot.empresaParams || {};
      const paramMap = {};
      Object.keys(empresaParams).forEach(k => {
        paramMap[k.toUpperCase()] = empresaParams[k] || '';
      });

      return res.json({
        orcamento: orcSnapshot,
        projetos: parsedSnapshot.projetos || [],
        itensPorProjeto: parsedSnapshot.itensPorProjeto || {},
        anexosPorProjeto: parsedSnapshot.anexosPorProjeto || {},
        formas_pagamento: parsedSnapshot.formasPagamento || [],
        empresa_logo: paramMap['EMP_LOGO'] || paramMap['LOGO_EMP'] || '',
        empresa_assinatura: paramMap['EMP_ASS'] || '',
        empresa_razao_social: paramMap['RAZAO_SOC'] || paramMap['NOME_FANT'] || '',
        empresa_cnpj: paramMap['CNPJ'] || '',
        valores: parsedSnapshot.valores,
        versao: propRecord.versao,
        codigo: propRecord.codigo,
        geradoEm: parsedSnapshot.geradoEm || propRecord.criado_em,
        isSnapshot: true,
        compartilhamento: {
          token: share.token,
          criado_em: share.criado_em,
          expira_em: share.expira_em,
          acessos_count: (share.acessos_count || 0) + 1,
          aprovado_em: share.aprovado_em,
          forma_pagamento_selecionada: formaPagFinal,
          anotacoes_cliente: share.anotacoes_cliente || orc.anotacoes_cliente,
          proposta_id: share.proposta_id,
          status: (share.status === 'Aprovado' || orc.status === 'Aprovado') ? 'Aprovado' : share.status
        }
      });
    }

    // Buscar projetos do orçamento na mesma empresa
    const projetos = await db.all('SELECT * FROM projetos WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY id ASC', [empresaId, share.orcamento_numero]);

    // Buscar itens e imagens dos projetos na mesma empresa
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
        LEFT JOIN Material m ON pi.MaterialReferencia = m.MaterialReferencia AND pi.empresa_id = m.empresa_id
        WHERE pi.empresa_id = ? AND pi.ProjetoID = ?
        ORDER BY pi.ProjetoItemID ASC
      `, [empresaId, p.id]);

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
          LEFT JOIN Material m ON pm.referencia = m.MaterialReferencia AND pm.empresa_id = m.empresa_id
          WHERE pm.empresa_id = ? AND pm.projeto_id = ?
          ORDER BY pm.id ASC
        `, [empresaId, p.id]);
      }

      itensPorProjeto[p.id] = itens || [];
    }

    // Buscar Formas de Pagamento ativas e suas condições na mesma empresa
    const formas = await db.all('SELECT * FROM formas_pagamento WHERE empresa_id = ? AND ativo = "Sim" ORDER BY ordem ASC, id ASC', [empresaId]);
    const condicoes = await db.all('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? ORDER BY ordem ASC, id ASC', [empresaId]);
    const formasComCondicoes = formas.map(f => ({
      ...f,
      condicoes: condicoes.filter(c => c.forma_pagamento_id === f.id)
    }));

    // Buscar anexos dos projetos marcados para exibição na proposta na mesma empresa
    const anexosPorProjeto = {};
    for (const p of projetos) {
      const anexos = await db.all(
        `SELECT * FROM projeto_anexos WHERE empresa_id = ? AND projeto_id = ? AND COALESCE(exibir_na_proposta, 'Sim') = 'Sim' ORDER BY id ASC`,
        [empresaId, p.id]
      );
      anexosPorProjeto[p.id] = anexos || [];
    }

    // Buscar parâmetros da empresa (logomarca e assinatura) para exibição na proposta pública
    const empresaParams = await db.all("SELECT chave, conteudo FROM parametros_empresa WHERE empresa_id = ? AND chave IN ('EMP_LOGO', 'EMP_ASS', 'LOGO_EMP', 'RAZAO_SOC', 'NOME_FANT', 'CNPJ')", [empresaId]);
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
      isSnapshot: false,
      compartilhamento: {
        token: share.token,
        criado_em: share.criado_em,
        expira_em: share.expira_em,
        acessos_count: (share.acessos_count || 0) + 1,
        aprovado_em: share.aprovado_em,
        forma_pagamento_selecionada: share.forma_pagamento_selecionada,
        anotacoes_cliente: share.anotacoes_cliente,
        proposta_id: share.proposta_id
      }
    });
  } catch (error) {
    console.error('GET PUBLIC PROPOSTA ERROR:', error);
    res.status(500).json({ error: 'Erro ao carregar proposta pública.' });
  }
});

// Função utilitária para gerar o fluxo financeiro com base em uma condição de pagamento
function gerarFluxoFinanceiroDeCondicao(cond, totalVenda, dataEntrada, meioFallback = 'PIX') {
  if (!totalVenda || totalVenda <= 0) return [];
  const baseDt = (dataEntrada || new Date().toISOString().split('T')[0]).split('T')[0];
  const result = [];

  if (!cond) {
    result.push({
      id: 1,
      tipo: 'À Vista',
      descricao: 'Pagamento Integral',
      data: baseDt,
      percentual: 100,
      valor: Math.round(totalVenda * 100) / 100,
      meio_pagamento: meioFallback || 'PIX'
    });
    return result;
  }

  const percEntrada = parseFloat(cond.perc_entrada) || 0;
  const numParcelas = parseInt(cond.num_parcelas, 10) || 0;
  const percDesc = parseFloat(cond.perc_desconto) || 0;
  const vlrDesconto = totalVenda * (percDesc / 100);
  const totalComDesc = Math.round((totalVenda - vlrDesconto) * 100) / 100;

  const vlrEntrada = Math.round((totalComDesc * (percEntrada / 100)) * 100) / 100;
  const vlrSaldo = Math.max(0, Math.round((totalComDesc - vlrEntrada) * 100) / 100);
  const meio = (cond.meio_pagamento || meioFallback || 'PIX').trim();

  if (percEntrada >= 100) {
    result.push({
      id: 1,
      tipo: 'À Vista',
      descricao: percDesc > 0 ? `Pagamento Integral à Vista (${percDesc}% desc)` : 'Pagamento Integral à Vista',
      data: baseDt,
      percentual: 100,
      valor: totalComDesc,
      meio_pagamento: meio
    });
    return result;
  }

  if (percEntrada > 0) {
    result.push({
      id: 1,
      tipo: 'Entrada',
      descricao: `Entrada (${percEntrada}%)`,
      data: baseDt,
      percentual: percEntrada,
      valor: vlrEntrada,
      meio_pagamento: meio
    });
  }

  if (numParcelas > 0) {
    const vlrParcelaBase = Math.floor((vlrSaldo / numParcelas) * 100) / 100;
    const percSaldo = 100 - percEntrada;
    const percParcelaBase = Math.floor((percSaldo / numParcelas) * 100) / 100;
    let somaVlr = 0;
    let somaPerc = 0;

    for (let i = 1; i <= numParcelas; i++) {
      let dataVenc = baseDt;
      try {
        const d = new Date(baseDt + 'T12:00:00');
        d.setDate(d.getDate() + (30 * i));
        dataVenc = d.toISOString().split('T')[0];
      } catch (e) {}

      const isLast = (i === numParcelas);
      const val = isLast ? Math.round((vlrSaldo - somaVlr) * 100) / 100 : vlrParcelaBase;
      const pct = isLast ? Math.round((percSaldo - somaPerc) * 100) / 100 : percParcelaBase;
      somaVlr += val;
      somaPerc += pct;

      result.push({
        id: (percEntrada > 0 ? 1 : 0) + i,
        tipo: numParcelas === 1 && percEntrada > 0 ? 'Saldo na Entrega' : 'Parcela',
        descricao: numParcelas === 1 && percEntrada > 0 ? 'Saldo na Entrega' : `Parcela ${i}/${numParcelas}`,
        data: dataVenc,
        percentual: pct,
        valor: val,
        meio_pagamento: meio
      });
    }
  } else if (percEntrada === 0) {
    result.push({
      id: 1,
      tipo: 'À Vista',
      descricao: 'Pagamento Integral',
      data: baseDt,
      percentual: 100,
      valor: totalComDesc,
      meio_pagamento: meio
    });
  }

  return result;
}

// POST /api/public/propostas/:token/anotacoes - Gravação de anotações/observações e forma de pagamento na proposta digital
app.post('/api/public/propostas/:token/anotacoes', async (req, res) => {
  const { token } = req.params;
  const { anotacoes, forma_pagamento_descricao } = req.body || {};
  try {
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE token = ?', [token]);
    if (!share) {
      return res.status(404).json({ error: 'Link de proposta não encontrado.' });
    }

    const empresaId = share.empresa_id;

    if (share.status === 'Revogado') {
      return res.status(410).json({ error: 'Este link de proposta foi revogado.' });
    }

    const agora = new Date();
    const dataExpiracao = new Date(share.expira_em);
    if (dataExpiracao < agora) {
      return res.status(410).json({ error: 'Este link de proposta expirou.' });
    }

    const orc = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, share.orcamento_numero]);
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const notes = typeof anotacoes === 'string' ? anotacoes.trim() : (orc.anotacoes_cliente || null);
    const formaDesc = typeof forma_pagamento_descricao === 'string' && forma_pagamento_descricao.trim() 
      ? forma_pagamento_descricao.trim() 
      : (orc.forma_pagamento_selecionada || null);

    // Atualiza o orçamento da mesma empresa
    await db.run(
      `UPDATE orcamentos 
       SET anotacoes_cliente = ?, 
           forma_pagamento_selecionada = ?, 
           status = CASE WHEN status = 'Aprovado' THEN status ELSE 'Em Negociação' END,
           situacao = CASE WHEN situacao = 'Aprovado' THEN situacao ELSE 'Em Negociação' END
       WHERE empresa_id = ? AND numero = ?`,
      [notes, formaDesc, empresaId, share.orcamento_numero]
    );

    // Atualiza o registro de compartilhamento da mesma empresa
    await db.run(
      `UPDATE proposta_compartilhamentos 
       SET anotacoes_cliente = ?, 
           forma_pagamento_selecionada = ? 
       WHERE empresa_id = ? AND id = ?`,
      [notes, formaDesc, empresaId, share.id]
    );

    // Sincroniza na versão da proposta da mesma empresa
    if (formaDesc) {
      if (share.proposta_id) {
        await db.run(
          `UPDATE propostas SET forma_pagamento_selecionada = ? WHERE empresa_id = ? AND id = ?`,
          [formaDesc, empresaId, share.proposta_id]
        );
      } else {
        await db.run(
          `UPDATE propostas SET forma_pagamento_selecionada = ? WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY versao DESC, id DESC LIMIT 1`,
          [formaDesc, empresaId, share.orcamento_numero]
        );
      }
    }

    const updatedOrc = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, share.orcamento_numero]);

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

// POST /api/public/propostas/:token/aprovar - Aprovação online da proposta pelo cliente com forma de pagamento
app.post('/api/public/propostas/:token/aprovar', async (req, res) => {
  const { token } = req.params;
  const { forma_pagamento_descricao, condicao_id, anotacoes } = req.body || {};
  try {
    const share = await db.get('SELECT * FROM proposta_compartilhamentos WHERE token = ?', [token]);
    if (!share) {
      return res.status(404).json({ error: 'Link de proposta não encontrado.' });
    }

    const empresaId = share.empresa_id;

    if (share.status === 'Revogado') {
      return res.status(410).json({ error: 'Este link de proposta foi revogado.' });
    }

    const agora = new Date();
    const dataExpiracao = new Date(share.expira_em);
    if (dataExpiracao < agora) {
      return res.status(410).json({ error: 'Este link de proposta expirou.' });
    }

    const orc = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, share.orcamento_numero]);
    if (!orc) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    const formaDesc = (forma_pagamento_descricao || '').trim() || (share.forma_pagamento_selecionada || '').trim() || (orc.forma_pagamento_selecionada || '').trim() || null;
    const notes = typeof anotacoes === 'string' ? anotacoes.trim() : (orc.anotacoes_cliente || null);

    // Buscar a condição de pagamento correspondente exclusivamente na empresa do orçamento
    let matchedCond = null;
    if (condicao_id) {
      matchedCond = await db.get('SELECT * FROM condicoes_pagamento WHERE empresa_id = ? AND id = ?', [empresaId, condicao_id]);
    }
    if (!matchedCond && formaDesc) {
      const condicoes = await db.all(`
        SELECT c.*, f.nome as forma_nome 
        FROM condicoes_pagamento c
        JOIN formas_pagamento f ON c.forma_pagamento_id = f.id AND c.empresa_id = f.empresa_id
        WHERE c.empresa_id = ?
      `, [empresaId]);
      if (condicoes && condicoes.length > 0) {
        matchedCond = condicoes.find(c => {
          const descCompleta = `${c.forma_nome} - ${c.descricao || c.meio_pagamento || ''}`.trim().toLowerCase();
          const fpLower = formaDesc.toLowerCase();
          const descLower = (c.descricao || '').toLowerCase();
          return descCompleta === fpLower || descLower === fpLower || fpLower.includes(descLower);
        });
      }
    }

    const totalVendaOrc = parseFloat(orc.total_venda) || (
      (await db.all('SELECT preco_venda_final FROM projetos WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, orc.numero]))
        .reduce((sum, p) => sum + (parseFloat(p.preco_venda_final) || 0), 0)
    );

    const dataEntradaOrc = orc.data_entrada || new Date().toISOString().split('T')[0];
    const fluxoGerado = gerarFluxoFinanceiroDeCondicao(matchedCond, totalVendaOrc, dataEntradaOrc, matchedCond?.meio_pagamento || formaDesc);
    const fluxoJson = JSON.stringify(fluxoGerado);

    // 1. Atualiza o status do orçamento para "Aprovado" na empresa correspondente
    await db.run(
      `UPDATE orcamentos 
       SET status = 'Aprovado', 
           situacao = 'Aprovado',
           forma_pagamento_selecionada = ?, 
           anotacoes_cliente = ?, 
           data_aprovacao = CURRENT_TIMESTAMP,
           fluxo_financeiro = ?
       WHERE empresa_id = ? AND numero = ?`,
      [formaDesc, notes, fluxoJson, empresaId, share.orcamento_numero]
    );

    // 2. Registra a aprovação no histórico do link compartilhado
    await db.run(
      `UPDATE proposta_compartilhamentos 
       SET status = 'Aprovado',
           aprovado_em = CURRENT_TIMESTAMP, 
           forma_pagamento_selecionada = ?, 
           anotacoes_cliente = ? 
       WHERE empresa_id = ? AND id = ?`,
      [formaDesc, notes, empresaId, share.id]
    );

    // 3. Atualiza o status e a forma de pagamento na tabela de propostas da empresa
    if (share.proposta_id) {
      await db.run(
        `UPDATE propostas 
         SET status = 'Aprovada', 
             forma_pagamento_selecionada = ? 
         WHERE empresa_id = ? AND id = ?`,
        [formaDesc, empresaId, share.proposta_id]
      );
    } else {
      await db.run(
        `UPDATE propostas 
         SET status = 'Aprovada', 
             forma_pagamento_selecionada = ? 
         WHERE empresa_id = ? AND orcamento_numero = ? 
         ORDER BY versao DESC, id DESC LIMIT 1`,
        [formaDesc, empresaId, share.orcamento_numero]
      );
    }

    const updatedOrc = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, share.orcamento_numero]);

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
    const empresaId = req.auth?.empresaId || req.user?.empresa_id || 1;
    cb(null, getTenantUploadDir(empresaId, 'parametros'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(sanitizeSafeFilename(file.originalname || '')).slice(0, 10);
    cb(null, 'param-' + uniqueSuffix + ext);
  }
});
const uploadParametros = multer({ storage: parametrosStorage });

app.post('/api/parametros-empresa/upload-imagem', authenticateToken, uploadParametros.single('imagem'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado.' });
    }
    const empresaId = req.auth.empresaId;
    const relativePath = `uploads/empresa_${empresaId}/parametros/${req.file.filename}`;
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
  const empresaId = req.auth.empresaId;
  try {
    const list = await db.all('SELECT * FROM parametros_empresa WHERE empresa_id = ? ORDER BY chave ASC', [empresaId]);
    res.json(list);
  } catch (err) {
    console.error('Erro ao listar parametros_empresa:', err);
    res.status(500).json({ error: 'Erro ao buscar parâmetros da empresa.' });
  }
});

// Buscar um Parâmetro por ID ou Chave
app.get('/api/parametros-empresa/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    let param;
    if (isNaN(id)) {
      param = await db.get('SELECT * FROM parametros_empresa WHERE empresa_id = ? AND chave = ?', [empresaId, id.toUpperCase()]);
    } else {
      param = await db.get('SELECT * FROM parametros_empresa WHERE empresa_id = ? AND (id = ? OR chave = ?)', [empresaId, id, id.toUpperCase()]);
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
  const empresaId = req.auth.empresaId;
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

    // Verificar unicidade da Chave dentro da empresa
    const existing = await db.get('SELECT id FROM parametros_empresa WHERE empresa_id = ? AND chave = ?', [empresaId, chaveFormatada]);
    if (existing) {
      return res.status(400).json({ error: `Já existe um parâmetro com a chave "${chaveFormatada}".` });
    }

    const result = await db.run(
      `INSERT INTO parametros_empresa (empresa_id, chave, tipo, conteudo, descricao) VALUES (?, ?, ?, ?, ?)`,
      [empresaId, chaveFormatada, tipoNum, conteudoStr, descricao ? descricao.trim() : null]
    );

    const newParam = await db.get('SELECT * FROM parametros_empresa WHERE empresa_id = ? AND id = ?', [empresaId, result.lastID]);
    res.status(201).json(newParam);
  } catch (err) {
    console.error('Erro ao criar parâmetro:', err);
    res.status(500).json({ error: 'Erro ao cadastrar parâmetro da empresa.' });
  }
});

// Atualizar Parâmetro Existente
app.put('/api/parametros-empresa/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { chave, tipo, conteudo, descricao } = req.body;
  try {
    const current = await db.get('SELECT * FROM parametros_empresa WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!current) {
      return res.status(404).json({ error: 'Parâmetro não encontrado.' });
    }

    let chaveFormatada = current.chave;
    if (chave && typeof chave === 'string') {
      chaveFormatada = chave.trim().toUpperCase();
      if (chaveFormatada.length > 10) {
        return res.status(400).json({ error: 'A Chave deve ter no máximo 10 caracteres.' });
      }

      if (chaveFormatada !== current.chave) {
        const existing = await db.get('SELECT id FROM parametros_empresa WHERE empresa_id = ? AND chave = ? AND id != ?', [empresaId, chaveFormatada, id]);
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
       WHERE empresa_id = ? AND id = ?`,
      [chaveFormatada, tipoNum, conteudoStr, descStr, empresaId, id]
    );

    const updated = await db.get('SELECT * FROM parametros_empresa WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(updated);
  } catch (err) {
    console.error('Erro ao atualizar parâmetro:', err);
    res.status(500).json({ error: 'Erro ao atualizar parâmetro da empresa.' });
  }
});

// Excluir Parâmetro
app.delete('/api/parametros-empresa/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  try {
    const current = await db.get('SELECT * FROM parametros_empresa WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!current) {
      return res.status(404).json({ error: 'Parâmetro não encontrado.' });
    }

    await db.run('DELETE FROM parametros_empresa WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ success: true, message: `Parâmetro "${current.chave}" removido com sucesso.` });
  } catch (err) {
    console.error('Erro ao excluir parâmetro:', err);
    res.status(500).json({ error: 'Erro ao excluir parâmetro da empresa.' });
  }
});

// =============================================================
// FLUXO DE RECEBIMENTO
// =============================================================

// Listar lançamentos do Fluxo de Recebimento (com dados do cliente e filtros)
app.get('/api/fluxo-recebimento', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  try {
    const { status, orcamento_numero, cliente_id, data_inicio, data_fim, busca } = req.query;
    let query = `
      SELECT 
        fr.*,
        c.nome AS cliente_razao_social,
        c.documento AS cliente_cnpj_cpf,
        c.tipo_pessoa AS cliente_tipo_pessoa,
        c.telefone AS cliente_telefone,
        c.email AS cliente_email
      FROM FluxoRecebimento fr
      LEFT JOIN clientes c ON c.id = fr.cliente_id AND c.empresa_id = fr.empresa_id
      WHERE fr.empresa_id = ?
    `;
    const params = [empresaId];

    if (status && status !== 'TODOS') {
      if (status === 'ATRASADO') {
        query += ` AND UPPER(fr.status) = 'PENDENTE' AND fr.data_vencimento < CURRENT_DATE()`;
      } else {
        query += ` AND UPPER(fr.status) = UPPER(?)`;
        params.push(status);
      }
    }

    if (orcamento_numero) {
      query += ` AND fr.orcamento_numero = ?`;
      params.push(orcamento_numero);
    }

    if (cliente_id) {
      query += ` AND fr.cliente_id = ?`;
      params.push(cliente_id);
    }

    if (data_inicio) {
      query += ` AND fr.data_vencimento >= ?`;
      params.push(data_inicio);
    }

    if (data_fim) {
      query += ` AND fr.data_vencimento <= ?`;
      params.push(data_fim);
    }

    if (busca) {
      query += ` AND (fr.orcamento_numero LIKE ? OR fr.cliente_nome LIKE ? OR fr.descricao LIKE ? OR c.nome LIKE ?)`;
      const term = `%${busca}%`;
      params.push(term, term, term, term);
    }

    query += ` ORDER BY fr.data_vencimento ASC, fr.id ASC`;

    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao listar fluxo de recebimento:', err);
    res.status(500).json({ error: 'Erro ao consultar fluxo de recebimento.' });
  }
});

// Efetivar fluxo de um orçamento
app.post('/api/orcamentos/:numero/efetivar-fluxo', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  const { parcelas, observacoes } = req.body;

  try {
    const orcamento = await db.get(
      `SELECT o.*, c.nome as cliente_nome 
       FROM orcamentos o 
       LEFT JOIN clientes c ON o.cliente_id = c.id AND o.empresa_id = c.empresa_id
       WHERE o.empresa_id = ? AND o.numero = ?`,
      [empresaId, numero]
    );
    if (!orcamento) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    if (!orcamento.data_assinatura) {
      return res.status(400).json({ error: 'O contrato do projeto precisa estar assinado para que o fluxo financeiro possa ser efetivado.' });
    }

    if (!parcelas || !Array.isArray(parcelas) || parcelas.length === 0) {
      return res.status(400).json({ error: 'Nenhuma parcela informada para efetivar o fluxo.' });
    }

    // Remover parcelas pendentes anteriores deste orçamento na empresa
    await db.run('DELETE FROM FluxoRecebimento WHERE empresa_id = ? AND orcamento_numero = ? AND status = "PENDENTE"', [empresaId, numero]);

    const totalParcelas = parcelas.length;
    let inseridas = 0;

    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const numParc = p.numero_parcela || (i + 1);
      const desc = p.descricao || `Parcela ${numParc}/${totalParcelas} - Orç. ${numero}`;
      const tipo = p.tipo || 'PARCELA';
      const perc = parseFloat(p.percentual) || 0;
      const val = parseFloat(p.valor) || 0;
      const dtVenc = p.data_vencimento || new Date().toISOString().split('T')[0];
      const meioPag = p.meio_pagamento || orcamento.forma_pagamento_selecionada || 'PIX';
      const obs = p.observacoes || observacoes || null;

      await db.run(
        `INSERT INTO FluxoRecebimento (
          empresa_id, orcamento_numero, cliente_id, cliente_nome, descricao, tipo,
          numero_parcela, total_parcelas, percentual, valor, valor_recebido,
          data_vencimento, meio_pagamento, status, recibo_emitido, observacoes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'PENDENTE', 0, ?)`,
        [
          empresaId,
          numero,
          orcamento.cliente_id || null,
          orcamento.cliente_nome || 'Cliente não identificado',
          desc,
          tipo,
          numParc,
          totalParcelas,
          perc,
          val,
          dtVenc,
          meioPag,
          obs
        ]
      );
      inseridas++;
    }

    // Marcar orçamento como status = 'Efetivado' e fluxo_efetivado = 1
    await db.run('UPDATE orcamentos SET status = "Efetivado", fluxo_efetivado = 1 WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);

    // Inserir registros na tabela Ordem_Servico para cada projeto do orçamento na empresa
    const responsavel = (req.auth.email || req.auth.nome || 'Sistema').slice(0, 20);
    const dataCriacao = new Date().toISOString().split('T')[0];

    const projs = await db.all('SELECT * FROM projetos WHERE empresa_id = ? AND orcamento_numero = ? ORDER BY id ASC', [empresaId, numero]);

    if (projs && projs.length > 0) {
      for (let i = 0; i < projs.length; i++) {
        const p = projs[i];
        const projId = (i + 1);
        const nomeProj = p.nome || `Projeto ${projId}`;
        const tempoTotal = (parseInt(p.DuracaoFabricacao, 10) || 0) + (parseInt(p.DuracaoMontagem, 10) || 0);

        const existingOS = await db.get(
          'SELECT Numero FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
          [empresaId, numero, projId]
        );
        if (!existingOS) {
          await db.run(
            'INSERT INTO Ordem_Servico (empresa_id, Numero, ProjetoID, DataCriacao, DataConclusao, Situacao, Responsavel, NomeProjeto, Tempo) VALUES (?, ?, ?, ?, NULL, "Aberta", ?, ?, ?)',
            [empresaId, numero, projId, dataCriacao, responsavel, nomeProj, tempoTotal]
          );
        } else {
          await db.run(
            'UPDATE Ordem_Servico SET NomeProjeto = ?, Tempo = ? WHERE empresa_id = ? AND Numero = ? AND ProjetoID = ?',
            [nomeProj, tempoTotal, empresaId, numero, projId]
          );
        }
      }
    } else {
      const existingOS = await db.get(
        'SELECT Numero FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ? AND ProjetoID = 1',
        [empresaId, numero]
      );
      if (!existingOS) {
        await db.run(
          'INSERT INTO Ordem_Servico (empresa_id, Numero, ProjetoID, DataCriacao, DataConclusao, Situacao, Responsavel, NomeProjeto, Tempo) VALUES (?, ?, 1, ?, NULL, "Aberta", ?, ?, 0)',
          [empresaId, numero, dataCriacao, responsavel, orcamento.descricao || 'Projeto Geral']
        );
      }
    }

    res.json({
      success: true,
      message: `${inseridas} parcela(s) efetivada(s) no Fluxo de Recebimento com sucesso e Ordem de Serviço #${numero} gerada!`,
      totalInseridas: inseridas
    });
  } catch (err) {
    console.error('Erro ao efetivar fluxo do orçamento:', err);
    res.status(500).json({ error: 'Erro ao efetivar fluxo de recebimento do orçamento.' });
  }
});

// Desfazer efetivação do orçamento (exclui o fluxo financeiro e retorna para Em Aberto)
app.post('/api/orcamentos/:numero/desfazer-efetivacao', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { numero } = req.params;
  try {
    const orcamento = await db.get('SELECT * FROM orcamentos WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    if (!orcamento) {
      return res.status(404).json({ error: 'Orçamento não encontrado.' });
    }

    // Exclui todos os lançamentos do fluxo financeiro deste orçamento na empresa
    await db.run('DELETE FROM FluxoRecebimento WHERE empresa_id = ? AND orcamento_numero = ?', [empresaId, numero]);

    // Exclui checklist e registros da Ordem_Servico deste orçamento na empresa
    await db.run('DELETE FROM ordem_servico_checklist WHERE empresa_id = ? AND numero = ?', [empresaId, numero]);
    await db.run('DELETE FROM Ordem_Servico WHERE empresa_id = ? AND Numero = ?', [empresaId, numero]);

    // Retorna o orçamento para a situação Em Aberto e limpa a flag de fluxo efetivado
    await db.run(
      'UPDATE orcamentos SET status = "Em Aberto", fluxo_efetivado = 0, data_aprovacao = NULL WHERE empresa_id = ? AND numero = ?',
      [empresaId, numero]
    );

    res.json({
      success: true,
      message: `Efetivação do Orçamento #${numero} desfeita com sucesso e lançamentos financeiros excluídos.`
    });
  } catch (err) {
    console.error('Erro ao desfazer efetivação do orçamento:', err);
    res.status(500).json({ error: 'Erro ao desfazer efetivação do orçamento.' });
  }
});

// Atualizar dados de um lançamento no Fluxo de Recebimento
app.put('/api/fluxo-recebimento/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { descricao, valor, data_vencimento, meio_pagamento, observacoes, status } = req.body;

  try {
    const registro = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!registro) {
      return res.status(404).json({ error: 'Registro de fluxo não encontrado.' });
    }

    await db.run(
      `UPDATE FluxoRecebimento 
       SET descricao = COALESCE(?, descricao),
           valor = COALESCE(?, valor),
           data_vencimento = COALESCE(?, data_vencimento),
           meio_pagamento = COALESCE(?, meio_pagamento),
           observacoes = COALESCE(?, observacoes),
           status = COALESCE(?, status)
       WHERE empresa_id = ? AND id = ?`,
      [descricao, valor, data_vencimento, meio_pagamento, observacoes, status, empresaId, id]
    );

    const atualizado = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json(atualizado);
  } catch (err) {
    console.error('Erro ao atualizar fluxo de recebimento:', err);
    res.status(500).json({ error: 'Erro ao atualizar registro de recebimento.' });
  }
});

// Confirmar Baixa / Recebimento de Parcela
app.post('/api/fluxo-recebimento/:id/baixar', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;
  const { valor_recebido, data_recebimento, meio_pagamento, observacoes } = req.body;

  try {
    const registro = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!registro) {
      return res.status(404).json({ error: 'Registro de fluxo não encontrado.' });
    }

    const vlr = valor_recebido !== undefined ? parseFloat(valor_recebido) : registro.valor;
    const dtRec = data_recebimento || new Date().toISOString().split('T')[0];
    const meio = meio_pagamento || registro.meio_pagamento;

    await db.run(
      `UPDATE FluxoRecebimento 
       SET status = 'RECEBIDO',
           valor_recebido = ?,
           data_recebimento = ?,
           meio_pagamento = ?,
           observacoes = COALESCE(?, observacoes)
       WHERE empresa_id = ? AND id = ?`,
      [vlr, dtRec, meio, observacoes, empresaId, id]
    );

    const atualizado = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ success: true, message: 'Recebimento baixado com sucesso!', registro: atualizado });
  } catch (err) {
    console.error('Erro ao baixar recebimento:', err);
    res.status(500).json({ error: 'Erro ao confirmar baixa de recebimento.' });
  }
});

// Estornar Baixa de Parcela (voltar para PENDENTE)
app.post('/api/fluxo-recebimento/:id/estornar', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;

  try {
    const registro = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!registro) {
      return res.status(404).json({ error: 'Registro de fluxo não encontrado.' });
    }

    await db.run(
      `UPDATE FluxoRecebimento 
       SET status = 'PENDENTE',
           valor_recebido = 0,
           data_recebimento = NULL
       WHERE empresa_id = ? AND id = ?`,
      [empresaId, id]
    );

    const atualizado = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ success: true, message: 'Recebimento estornado para pendente!', registro: atualizado });
  } catch (err) {
    console.error('Erro ao estornar recebimento:', err);
    res.status(500).json({ error: 'Erro ao estornar recebimento.' });
  }
});

// Marcar Recibo como Emitido
app.post('/api/fluxo-recebimento/:id/marcar-recibo', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;

  try {
    const registro = await db.get('SELECT id FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!registro) {
      return res.status(404).json({ error: 'Registro de fluxo não encontrado.' });
    }
    await db.run('UPDATE FluxoRecebimento SET recibo_emitido = 1 WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ success: true, message: 'Recibo marcado como emitido.' });
  } catch (err) {
    console.error('Erro ao marcar recibo:', err);
    res.status(500).json({ error: 'Erro ao registrar emissão de recibo.' });
  }
});

// Excluir Lançamento do Fluxo de Recebimento
app.delete('/api/fluxo-recebimento/:id', authenticateToken, async (req, res) => {
  const empresaId = req.auth.empresaId;
  const { id } = req.params;

  try {
    const registro = await db.get('SELECT * FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    if (!registro) {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }

    await db.run('DELETE FROM FluxoRecebimento WHERE empresa_id = ? AND id = ?', [empresaId, id]);
    res.json({ success: true, message: 'Lançamento excluído com sucesso.' });
  } catch (err) {
    console.error('Erro ao excluir fluxo:', err);
    res.status(500).json({ error: 'Erro ao excluir lançamento de fluxo.' });
  }
});

// -------------------------------------------------------------
// Servir Frontend Estático e SPA Fallback (Produção / Hostinger)
// -------------------------------------------------------------
const candidateDistPaths = [
  process.env.FRONTEND_DIST_PATH,
  path.resolve(__dirname, '../../frontend/dist'),
  path.resolve(__dirname, '../frontend/dist'),
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
  console.log('[Frontend] Diretório frontend/dist não encontrado. Servindo rota diagnóstica na raiz.');
  app.get('/', (req, res) => {
    res.status(200).send('Servidor Node.js (ChaoDeFabrica ERP) está online. O diretório frontend/dist não foi encontrado; execute npm run build.');
  });
}

// Start Server (unless imported by integration test runner)
let httpServer = null;
if (process.env.NODE_ENV !== 'test') {
  httpServer = app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
  });
}

export { app, dbReadyPromise, httpServer };

