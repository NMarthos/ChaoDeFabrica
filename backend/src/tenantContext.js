import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';

const SENSITIVE_KEYS = /senha|password|token|secret|authorization|private_key|cookie/i;

export function sanitizeAuditPayload(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeAuditPayload);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeAuditPayload(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Middleware que atribui um request_id único a cada requisição para rastreabilidade e auditoria.
 */
export function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  req.requestId = (typeof incomingId === 'string' && incomingId.trim().length > 0 && incomingId.length <= 64)
    ? incomingId.trim()
    : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/**
 * Registra evento de auditoria no banco sem expor credenciais, senhas ou tokens.
 */
export async function logAuditoria(db, req, { empresaId, usuarioId, acao, recurso, recursoId = null, detalhes = null }) {
  try {
    if (!db) return;
    const resolvedEmpresaId = empresaId ?? req?.auth?.empresaId ?? null;
    const resolvedUsuarioId = usuarioId ?? req?.auth?.userId ?? null;
    const requestId = req?.requestId || null;
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    const safeDetalhes = detalhes
      ? (typeof detalhes === 'string' ? detalhes : JSON.stringify(sanitizeAuditPayload(detalhes)))
      : null;

    await db.run(
      `INSERT INTO auditoria_logs (empresa_id, usuario_id, acao, recurso, recurso_id, detalhes, request_id, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolvedEmpresaId,
        resolvedUsuarioId,
        String(acao || 'ACAO').substring(0, 100),
        String(recurso || 'SISTEMA').substring(0, 100),
        recursoId !== null && recursoId !== undefined ? String(recursoId).substring(0, 100) : null,
        safeDetalhes,
        requestId,
        ip
      ]
    );
  } catch (err) {
    console.warn('[Auditoria] Falha ao gravar log de auditoria:', err.message);
  }
}

/**
 * Camada reutilizável de acesso a dados isolada por empresa (TenantRepository).
 * Exige empresaId inteiro positivo em qualquer instância ou operação.
 */
export class TenantRepository {
  constructor(dbAdapter, empresaId, connection = null) {
    const parsedId = Number(empresaId);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      const err = new Error('Contexto de empresa inválido ou ausente. Operação recusada.');
      err.status = 403;
      err.code = 'TENANT_CONTEXT_REQUIRED';
      throw err;
    }
    this.db = dbAdapter;
    this.empresaId = parsedId;
    this.connection = connection;
  }

  async _rawQuery(sql, params = []) {
    if (!sql || typeof sql !== 'string') {
      throw new Error('Comando SQL inválido.');
    }
    if (this.connection) {
      return this.connection.query(sql, params);
    }
    return this.db.query(sql, params);
  }

  async get(sql, params = []) {
    const [rows] = await this._rawQuery(sql, params);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  async all(sql, params = []) {
    const [rows] = await this._rawQuery(sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  async run(sql, params = []) {
    const [result] = await this._rawQuery(sql, params);
    return {
      lastID: result && result.insertId ? result.insertId : 0,
      changes: result && typeof result.affectedRows === 'number' ? result.affectedRows : 0
    };
  }

  async findById(table, idValue, pkCol = 'id') {
    return this.get(
      `SELECT * FROM \`${table}\` WHERE \`empresa_id\` = ? AND \`${pkCol}\` = ? LIMIT 1`,
      [this.empresaId, idValue]
    );
  }

  async assertOwned(table, idValue, pkCol = 'id', notFoundMessage = 'Registro não encontrado.') {
    const row = await this.findById(table, idValue, pkCol);
    if (!row) {
      const err = new Error(notFoundMessage);
      err.status = 404;
      throw err;
    }
    return row;
  }

  async deleteById(table, idValue, pkCol = 'id') {
    return this.run(
      `DELETE FROM \`${table}\` WHERE \`empresa_id\` = ? AND \`${pkCol}\` = ?`,
      [this.empresaId, idValue]
    );
  }

  /**
   * Executa operação transacional preservando estritamente o mesmo contexto de empresa
   * em todos os comandos e na mesma conexão física do pool.
   */
  async transaction(workFn) {
    if (this.connection) {
      // Já está dentro de uma transação ativa
      return workFn(this);
    }
    const conn = await this.db.pool.getConnection();
    try {
      await conn.beginTransaction();
      const txRepo = new TenantRepository(this.db, this.empresaId, conn);
      const result = await workFn(txRepo);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}

/**
 * Verifica se o cliente tentou enviar um empresa_id divergente no body, query, params ou headers.
 */
export function checkDivergentClientTenant(req, authenticatedEmpresaId) {
  const candidates = [
    { source: 'body.empresa_id', val: req.body?.empresa_id },
    { source: 'body.empresaId', val: req.body?.empresaId },
    { source: 'query.empresa_id', val: req.query?.empresa_id },
    { source: 'query.empresaId', val: req.query?.empresaId },
    { source: 'params.empresa_id', val: req.params?.empresa_id },
    { source: 'headers.x-empresa-id', val: req.headers?.['x-empresa-id'] }
  ];

  for (const c of candidates) {
    if (c.val !== undefined) {
      const parsed = Number(c.val);
      if (c.val === null || c.val === '' || !Number.isInteger(parsed) || parsed !== Number(authenticatedEmpresaId)) {
        return { divergent: true, source: c.source, attemptedValue: c.val };
      }
    }
  }

  // Remove qualquer campo empresa_id do body para impedir mass assignment
  if (req.body && typeof req.body === 'object') {
    delete req.body.empresa_id;
    delete req.body.empresaId;
  }

  return { divergent: false };
}

/**
 * Cria o middleware central de autenticação e resolução segura do contexto da empresa.
 */
export function createAuthMiddleware(getDb, jwtSecret) {
  return async function authenticateToken(req, res, next) {
    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json({ error: 'Serviço de banco de dados indisponível.' });
      }

      const authHeader = req.headers['authorization'];
      let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

      // Suporte seguro a token em query APENAS para carregamento de mídia/downloads autenticados no navegador
      if (!token && req.query?.token && (req.path.startsWith('/uploads/') || req.baseUrl === '/uploads' || req.path.includes('/anexos/') || req.path.includes('/download'))) {
        token = String(req.query.token).trim();
      }

      if (!token) {
        return res.status(401).json({ error: 'Token de autenticação não fornecido.' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, jwtSecret);
      } catch (jwtErr) {
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
      }

      if (!decoded || !decoded.id) {
        return res.status(401).json({ error: 'Token malformado: identificador de usuário ausente.' });
      }

      // Confirma no servidor que usuário e empresa existem, estão vinculados e ativos
      const userRecord = await db.get(
        `SELECT u.id, u.empresa_id, u.perfil_id, u.nome, u.email, u.login, u.situacao, u.role, u.ativo AS usuario_ativo,
                e.razao_social AS empresa_razao_social, e.nome_fantasia AS empresa_nome_fantasia,
                e.status AS empresa_status, e.ativo AS empresa_ativo,
                p.nome AS perfil_nome, p.ativo AS perfil_ativo
         FROM usuarios u
         INNER JOIN empresas e ON e.id = u.empresa_id
         LEFT JOIN perfis p ON p.empresa_id = u.empresa_id AND p.id = u.perfil_id
         WHERE u.id = ?
         LIMIT 1`,
        [decoded.id]
      );

      if (!userRecord || !userRecord.empresa_id) {
        await logAuditoria(db, req, {
          empresaId: null,
          usuarioId: decoded.id,
          acao: 'AUTH_NEGADO_USUARIO_INEXISTENTE',
          recurso: 'AUTH',
          recursoId: decoded.id
        });
        return res.status(401).json({ error: 'Usuário ou vínculo de empresa inválido.' });
      }

      // Valida correspondência estrita do empresa_id do JWT com o vínculo vigente no banco
      if (decoded.empresa_id !== undefined && Number(decoded.empresa_id) !== Number(userRecord.empresa_id)) {
        await logAuditoria(db, req, {
          empresaId: userRecord.empresa_id,
          usuarioId: userRecord.id,
          acao: 'AUTH_NEGADO_TOKEN_EMPRESA_DIVERGENTE',
          recurso: 'AUTH',
          recursoId: userRecord.id,
          detalhes: { tokenEmpresaId: decoded.empresa_id, dbEmpresaId: userRecord.empresa_id }
        });
        return res.status(401).json({ error: 'Sessão invalidada por alteração de vínculo empresarial. Faça login novamente.' });
      }

      // Exige empresa_id explícito no token emitido na arquitetura multiempresa
      if (decoded.empresa_id === undefined || decoded.empresa_id === null) {
        return res.status(401).json({ error: 'Token legado sem contexto de empresa. Faça login novamente.' });
      }

      const isUserAtivo = Number(userRecord.usuario_ativo) === 1 && String(userRecord.situacao || 'Ativado').toLowerCase() === 'ativado';
      if (!isUserAtivo) {
        await logAuditoria(db, req, {
          empresaId: userRecord.empresa_id,
          usuarioId: userRecord.id,
          acao: 'AUTH_NEGADO_USUARIO_INATIVO',
          recurso: 'AUTH',
          recursoId: userRecord.id
        });
        return res.status(403).json({ error: 'Usuário inativo ou sem acesso autorizado.' });
      }

      const empresaStatusOk = String(userRecord.empresa_status || 'Ativo').trim().toLowerCase() === 'ativo';
      if (Number(userRecord.empresa_ativo) !== 1 || !empresaStatusOk) {
        await logAuditoria(db, req, {
          empresaId: userRecord.empresa_id,
          usuarioId: userRecord.id,
          acao: 'AUTH_NEGADO_EMPRESA_INATIVA',
          recurso: 'AUTH',
          recursoId: userRecord.empresa_id
        });
        return res.status(403).json({ error: 'Empresa inativa ou suspensa.' });
      }

      // Carrega permissões do perfil vinculado na mesma empresa
      let permissoes = [];
      const isAdmin = String(userRecord.role || '').toLowerCase() === 'admin'
        || String(userRecord.perfil_nome || '').toLowerCase() === 'administrador'
        || String(userRecord.perfil_nome || '').toLowerCase() === 'master';
      if (isAdmin) {
        const allFuncs = await db.all(`SELECT codigo FROM funcoes`);
        permissoes = allFuncs.map(f => f.codigo);
      } else if (userRecord.perfil_id && Number(userRecord.perfil_ativo) === 1) {
        const pfRows = await db.all(
          `SELECT f.codigo
           FROM perfil_funcoes pf
           INNER JOIN funcoes f ON f.id = pf.funcao_id
           WHERE pf.empresa_id = ? AND pf.perfil_id = ?`,
          [userRecord.empresa_id, userRecord.perfil_id]
        );
        permissoes = pfRows.map(r => r.codigo);
      }

      const empresaId = Number(userRecord.empresa_id);
      const userId = Number(userRecord.id);

      // Rejeita tentativas de injetar um empresa_id divergente na requisição
      const divergence = checkDivergentClientTenant(req, empresaId);
      if (divergence.divergent) {
        await logAuditoria(db, req, {
          empresaId,
          usuarioId: userId,
          acao: 'TENTATIVA_INJECAO_EMPRESA_ID',
          recurso: req.originalUrl || req.path,
          detalhes: divergence
        });
        return res.status(403).json({
          error: 'Operação negada: não é permitido informar uma empresa divergente da empresa autenticada.'
        });
      }

      const authContext = Object.freeze({
        userId,
        empresaId,
        empresaNome: userRecord.empresa_nome_fantasia || userRecord.empresa_razao_social,
        role: isAdmin ? 'admin' : userRecord.role,
        perfilId: userRecord.perfil_id ? Number(userRecord.perfil_id) : null,
        perfilNome: userRecord.perfil_nome || null,
        permissoes: Object.freeze([...permissoes]),
        nome: userRecord.nome,
        login: userRecord.login || userRecord.email,
        email: userRecord.email,
        isMasterSupport: Boolean(decoded.is_master_support)
      });

      req.auth = authContext;
      req.user = {
        id: userId,
        empresa_id: empresaId,
        empresaId,
        role: authContext.role,
        perfil_id: authContext.perfilId,
        perfilNome: authContext.perfilNome,
        permissoes: authContext.permissoes,
        nome: userRecord.nome,
        email: userRecord.email
      };
      req.tenantDb = new TenantRepository(db, empresaId);

      next();
    } catch (err) {
      console.error('[AuthMiddleware] Erro inesperado:', err);
      return res.status(500).json({ error: 'Erro interno ao validar contexto de autenticação.' });
    }
  };
}

/**
 * Middleware de verificação de permissão RBAC dentro da empresa autenticada.
 */
export function requirePermission(...requiredCodes) {
  return (req, res, next) => {
    if (!req.auth || !req.auth.empresaId) {
      return res.status(401).json({ error: 'Contexto de empresa não autenticado.' });
    }
    if (req.auth.role === 'admin') {
      return next();
    }
    const userPerms = req.auth.permissoes || [];
    const hasPerm = requiredCodes.every(code => userPerms.includes(code));
    if (!hasPerm) {
      return res.status(403).json({ error: 'Permissão insuficiente para executar esta operação.' });
    }
    next();
  };
}

/**
 * Middleware que exige perfil Administrador da própria empresa.
 */
export function requireCompanyAdmin(getDb) {
  return async (req, res, next) => {
    if (!req.auth || !req.auth.empresaId) {
      return res.status(401).json({ error: 'Contexto de empresa não autenticado.' });
    }
    if (req.auth.role !== 'admin') {
      const db = getDb ? getDb() : null;
      await logAuditoria(db, req, {
        acao: 'ACESSO_ADMIN_NEGADO',
        recurso: req.originalUrl || req.path,
        detalhes: { role: req.auth.role }
      });
      return res.status(403).json({ error: 'Acesso restrito aos administradores da empresa.' });
    }
    next();
  };
}

/**
 * Sanitiza nomes de arquivos e valida contenção estrita dentro do diretório base de uploads
 * para impedir ataques de Path Traversal (../, ..\, caminhos absolutos ou bytes nulos).
 */
export function sanitizeSafeFilename(originalName, prefix = 'file') {
  const base = path.basename(String(originalName || 'arquivo').replace(/\0/g, ''));
  const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const safeToken = crypto.randomBytes(12).toString('hex');
  return `${prefix}-${Date.now()}-${safeToken}${ext || '.bin'}`;
}

export function resolveSafeUploadPath(uploadsBaseDir, relativeOrStoredPath) {
  if (!relativeOrStoredPath || typeof relativeOrStoredPath !== 'string') return null;
  if (relativeOrStoredPath.includes('\0')) return null;

  const baseResolved = path.resolve(uploadsBaseDir);
  // Remove eventual prefixo /uploads/ ou uploads/
  const cleanRel = relativeOrStoredPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^uploads\/+/i, '');

  // Bloqueia segmentos '..' explícitos antes mesmo de resolver
  const segments = cleanRel.split('/');
  if (segments.some(seg => seg === '..')) {
    return null;
  }

  const targetResolved = path.resolve(baseResolved, cleanRel);
  const relativeCheck = path.relative(baseResolved, targetResolved);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    return null;
  }
  return {
    fullPath: targetResolved,
    normalizedRelPath: `uploads/${cleanRel}`
  };
}

