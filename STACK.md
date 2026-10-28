# Stack Tecnológica e Arquitetura — Chão de Fábrica ERP

Este documento descreve a pilha tecnológica (*tech stack*), as bibliotecas, a estrutura de diretórios e a arquitetura de execução e implantação do sistema **Chão de Fábrica ERP**.

---

## 1. Visão Geral da Arquitetura

O projeto utiliza uma arquitetura **Monorepo Full-Stack (SPA + API REST + Banco de Dados Relacional)** em JavaScript/ES Modules (`"type": "module"`):

- **Em Desenvolvimento (`npm run dev`):**
  - O **Frontend** roda no servidor de desenvolvimento do **Vite** (porta `5173`) com *Hot Module Replacement (HMR)* e proxy para `/api` e `/uploads`.
  - O **Backend** roda em **Node.js + Express** (porta `5000`) gerenciado pelo `nodemon`.
  - Ambos são iniciados simultaneamente via `concurrently`.

- **Em Produção / Hostinger (`npm run build` + `npm start`):**
  - O Vite compila o Frontend React em arquivos estáticos otimizados na pasta `frontend/dist/`.
  - O servidor **Node.js/Express** (`server.js` -> `backend/src/server.js`) atua como servidor unificado:
    1. Expõe todas as rotas da API REST sob o prefixo `/api/*`.
    2. Serve os arquivos e anexos enviados pelos usuários em `/uploads/*`.
    3. Serve o bundle estático do Frontend (`frontend/dist`) e redireciona rotas de navegação (SPA fallback) para `frontend/dist/index.html`.

```
+-------------------------------------------------------------------+
|                        Navegador (Cliente)                        |
|        React 18 + React Router 6 + Axios + Lucide Icons           |
|              Design System Dark Glassmorphism (CSS3)              |
+---------------------------------+---------------------------------+
                                  | HTTP / HTTPS (JSON / Multipart)
                                  v
+-------------------------------------------------------------------+
|                 Servidor de Aplicação (Node.js 22.x)              |
|                        Express 4 (server.js)                      |
|  +-----------------------+-------------------+-----------------+  |
|  |   Rotas REST (/api)   | Arquivos Estáticos| Uploads Locais  |  |
|  | JWT Auth, RBAC, PDF,  |  (frontend/dist)  |   (/uploads)    |  |
|  | Orçamentos, Produção  |   SPA Fallback    |  Multer Storage |  |
|  +-----------+-----------+-------------------+-----------------+  |
+--------------|----------------------------------------------------+
               |
               +----------------------------+
               | Pool de Conexões (mysql2)  | Integração Opcional (REST/OAuth2)
               v                            v
+------------------------------+  +---------------------------------+
|   Banco de Dados Relacional  |  |       Google Drive API v3       |
|      MySQL 8.0 / 8.4         |  |   (googleapis - Armazenamento   |
|  (Auto-migração via db.js)   |  |    em nuvem de documentos)      |
+------------------------------+  +---------------------------------+
```

---

## 2. Stack Tecnológica Detalhada

### 2.1. Frontend (`/frontend`)
| Tecnologia / Biblioteca | Versão | Finalidade |
| :--- | :--- | :--- |
| **React** (`react`, `react-dom`) | `^18.2.0` | Biblioteca principal para construção da interface de usuário reativa baseada em componentes. |
| **Vite** (`vite`, `@vitejs/plugin-react`) | `^4.3.9` | Bundler de alta performance e servidor de desenvolvimento com HMR. |
| **React Router DOM** (`react-router-dom`) | `^6.11.2` | Roteamento SPA no cliente (rotas protegidas, navegação entre módulos e rota pública `/proposta/:token`). |
| **Axios** (`axios`) | `^1.4.0` | Cliente HTTP para comunicação com a API REST (`/api`) e interceptação de token JWT. |
| **Lucide React** (`lucide-react`) | `^0.221.0` | Biblioteca de ícones vetoriais SVG. |
| **CSS3 Nativo** (`frontend/src/index.css`) | — | Design System próprio (*Dark Glassmorphism*), variáveis CSS (`:root`), CSS Grid/Flexbox, layout responsivo para 100% de zoom e estilos dedicados de impressão (`@media print`). |

### 2.2. Backend (`/backend`)
| Tecnologia / Biblioteca | Versão | Finalidade |
| :--- | :--- | :--- |
| **Node.js** | `22.x` | Runtime JavaScript no servidor (configurado com ES Modules). |
| **Express** (`express`) | `^4.22.1` | Framework web para construção da API REST, middlewares e entrega do frontend compilado. |
| **MySQL2** (`mysql2/promise`) | `^3.9.7` | Driver assíncrono com pool de conexões para o banco de dados MySQL. |
| **JSON Web Token** (`jsonwebtoken`) | `^9.0.3` | Autenticação stateless via token Bearer JWT. |
| **Bcrypt.js** (`bcryptjs`) | `^2.4.3` | Hash criptográfico de senhas de usuários. |
| **Multer** (`multer`) | `^2.1.1` | Middleware para upload de arquivos `multipart/form-data` (layouts XML/PDF/TXT, imagens de projetos e anexos). |
| **PDF Parse & Extract** (`pdf-parse`, `pdf-extract-image`, `pngjs`) | `^2.4.5` / `^0.0.3` / `^6.0.0` | Leitura, extração de texto e extração de imagens de orçamentos/relatórios em PDF (ex.: integração Promob). |
| **Google APIs** (`googleapis`) | `^171.4.0` | Integração com Google Drive API para upload e armazenamento de documentos na nuvem. |
| **Dotenv** (`dotenv`) | `^16.6.1` | Carregamento de variáveis de ambiente a partir de arquivos `.env`. |
| **CORS** (`cors`) | `^2.8.6` | Controle de acesso Cross-Origin Resource Sharing. |

### 2.3. Banco de Dados e Infraestrutura
| Tecnologia | Versão | Finalidade |
| :--- | :--- | :--- |
| **MySQL** | `8.0` / `8.4` | Banco de dados relacional principal (`u510090903_erp` em produção / `erp_chaodefabrica` local). |
| **Docker Compose** (`docker-compose.yml`) | `3.8` | Provisionamento opcional de container MySQL 8.0 para ambiente local. |
| **Auto-Migração (`backend/src/db.js`)** | — | Inicialização automática de tabelas, colunas incrementais e dados sementes (*seeds*) na subida do servidor. |

---

## 3. Módulos Funcionais do Sistema

O sistema é dividido nos seguintes domínios de negócio:

1. **Autenticação e Segurança (`/api/login`, `/api/usuarios`, `/api/perfis`, `/api/funcoes`):**
   - Controle de acesso baseado em perfis e permissões granulares por tela/função (RBAC).
2. **Cadastros Gerais (`/api/clientes`, `/api/produtos`, `/api/servicos`, `/api/formas-pagamento`, `/api/contratos`, `/api/parametros-empresa`):**
   - Gestão de clientes, catálogo de materiais e insumos, serviços fabris com tempo padrão, modelos de minuta de contrato e parâmetros da empresa.
3. **Comercial e Orçamentos (`/api/orcamentos`, `/api/projetos`, `/proposta/:token`):**
   - Elaboração de orçamentos por ambiente/projeto, importação automática de listas de materiais/layouts (Promob XML/PDF/TXT), substituição em lote de materiais e perfis lineares, DRE do orçamento, compartilhamento de proposta pública via link/token com aprovação online e geração de minuta de contrato.
4. **Financeiro (`/api/fluxo-recebimento`, `/api/lancamentos`, `/api/plano-contas`):**
   - Geração e edição do fluxo financeiro de propostas aprovadas, controle de parcelas a receber, baixas/liquidações, emissão de recibos e livro caixa / plano de contas.
5. **Fábrica e Produção (`/api/ordens-servico`, `/api/revisao-tecnica`, `/api/planta-baixa`):**
   - Geração automática e acompanhamento de Ordens de Serviço (OS) por projeto, cronograma de serviços em gráfico de **Gantt** com dependências, **Revisão Técnica** (apontamento de play/pause/conclusão de etapas e materiais) e monitoramento visual em tempo real na **Planta Baixa** do chão de fábrica.

---

## 4. Estrutura de Diretórios

```text
ChaoDeFabrica/
├── backend/
│   ├── src/
│   │   ├── db.js                  # Pool de conexão MySQL e auto-migração do schema (initDb)
│   │   └── server.js              # Servidor Express, rotas da API REST e entrega do SPA
│   ├── .env                       # Variáveis de ambiente locais do backend
│   └── package.json               # Dependências e scripts do backend
├── frontend/
│   ├── src/
│   │   ├── App.jsx                # Componentes, páginas, modais e rotas do React
│   │   ├── index.css              # Design System e estilos globais responsivos
│   │   └── main.jsx               # Ponto de entrada da aplicação React
│   ├── index.html                 # Template HTML principal
│   ├── vite.config.js             # Configuração do Vite e proxy de desenvolvimento
│   └── package.json               # Dependências e scripts do frontend
├── uploads/                       # Armazenamento local de arquivos e imagens de projetos
├── database_hostinger.sql         # Script SQL completo para criação manual das tabelas no MySQL
├── docker-compose.yml             # Container MySQL 8.0 para desenvolvimento local
├── .env.example                   # Modelo de variáveis de ambiente (DB, JWT, Google Drive)
├── server.js                      # Entry point na raiz para hospedagem Node.js (Hostinger)
├── package.json                   # Manifesto raiz do monorepo (scripts de build e start)
└── STACK.md                       # Documentação da stack e arquitetura do sistema
```

