-- =============================================================================
-- SCRIPT DE CRIAÇÃO DO BANCO DE DADOS MULTIEMPRESA - ERP CHÃO DE FÁBRICA (MySQL)
-- Arquitetura: Banco compartilhado, tabelas compartilhadas e isolamento por empresa_id
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 0.1 Tabela de controle de versão de migrações (Plataforma)
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version` VARCHAR(100) PRIMARY KEY,
  `description` VARCHAR(255) NOT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'APPLIED',
  `details` LONGTEXT DEFAULT NULL,
  `applied_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 0.2 Tabela de Empresas (Plataforma)
CREATE TABLE IF NOT EXISTS `empresas` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `razao_social` VARCHAR(255) NOT NULL,
  `nome_fantasia` VARCHAR(255) NOT NULL,
  `tipo_pessoa` VARCHAR(20) NOT NULL DEFAULT 'Jurídica',
  `cnpj` VARCHAR(30) DEFAULT NULL UNIQUE,
  `cpf_cnpj` VARCHAR(30) DEFAULT NULL,
  `email` VARCHAR(255) DEFAULT NULL,
  `telefone` VARCHAR(50) DEFAULT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'Ativo',
  `ativo` TINYINT(1) NOT NULL DEFAULT 1,
  `data_cadastro` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `data_vigencia` DATETIME DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 0.3 Catálogo Global de Funções (Compartilhado / Somente Leitura para Admins de Empresa)
CREATE TABLE IF NOT EXISTS `funcoes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `chave` VARCHAR(100) NOT NULL UNIQUE,
  `nome` VARCHAR(255) NOT NULL,
  `modulo` VARCHAR(100) NOT NULL,
  `descricao` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 0.4 Perfis de Acesso por Empresa
CREATE TABLE IF NOT EXISTS `perfis` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `nome` VARCHAR(100) NOT NULL,
  `descricao` TEXT DEFAULT NULL,
  `is_admin` TINYINT(1) NOT NULL DEFAULT 0,
  `ativo` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_perfis_empresa_id` (`empresa_id`, `id`),
  UNIQUE KEY `uk_perfis_empresa_nome` (`empresa_id`, `nome`),
  FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 0.5 Vínculo Perfil x Funções por Empresa
CREATE TABLE IF NOT EXISTS `perfil_funcoes` (
  `empresa_id` INT NOT NULL,
  `perfil_id` INT NOT NULL,
  `funcao_id` INT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`empresa_id`, `perfil_id`, `funcao_id`),
  CONSTRAINT `fk_perfil_funcoes_perfil` FOREIGN KEY (`empresa_id`, `perfil_id`) REFERENCES `perfis`(`empresa_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_perfil_funcoes_funcao` FOREIGN KEY (`funcao_id`) REFERENCES `funcoes`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 0.6 Logs de Auditoria e Segurança Multiempresa
CREATE TABLE IF NOT EXISTS `auditoria_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `request_id` VARCHAR(64) NOT NULL,
  `empresa_id` INT DEFAULT NULL,
  `usuario_id` INT DEFAULT NULL,
  `acao` VARCHAR(100) NOT NULL,
  `recurso` VARCHAR(100) DEFAULT NULL,
  `recurso_id` VARCHAR(100) DEFAULT NULL,
  `status_code` INT DEFAULT NULL,
  `ip` VARCHAR(64) DEFAULT NULL,
  `detalhes` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_auditoria_empresa_data` (`empresa_id`, `created_at`),
  INDEX `idx_auditoria_acao` (`acao`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1. Tabela: usuarios
CREATE TABLE IF NOT EXISTS `usuarios` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `perfil_id` INT DEFAULT NULL,
  `nome` VARCHAR(255) NOT NULL,
  `login` VARCHAR(100) DEFAULT NULL UNIQUE,
  `email` VARCHAR(255) NOT NULL,
  `senha` VARCHAR(255) NOT NULL,
  `role` VARCHAR(50) NOT NULL DEFAULT 'user',
  `situacao` VARCHAR(20) NOT NULL DEFAULT 'Ativado',
  `ativo` TINYINT(1) NOT NULL DEFAULT 1,
  `data_cadastro` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `data_vigencia` DATETIME DEFAULT NULL,
  `assinatura` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_usuarios_empresa_id` (`empresa_id`, `id`),
  INDEX `idx_usuarios_empresa_email` (`empresa_id`, `email`),
  CONSTRAINT `fk_usuarios_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_usuarios_empresa_perfil` FOREIGN KEY (`empresa_id`, `perfil_id`) REFERENCES `perfis`(`empresa_id`, `id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabela: clientes
CREATE TABLE IF NOT EXISTS `clientes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `nome` VARCHAR(255) NOT NULL,
  `tipo_pessoa` VARCHAR(20) NOT NULL DEFAULT 'Física',
  `documento` VARCHAR(50) DEFAULT NULL,
  `email` VARCHAR(255) DEFAULT NULL,
  `telefone` VARCHAR(50) DEFAULT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'Ativo',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `rg` VARCHAR(50) DEFAULT NULL,
  `endereco` VARCHAR(255) DEFAULT NULL,
  `numero` VARCHAR(50) DEFAULT NULL,
  `complemento` VARCHAR(255) DEFAULT NULL,
  `bairro` VARCHAR(100) DEFAULT NULL,
  `cidade` VARCHAR(100) DEFAULT NULL,
  `uf` VARCHAR(10) DEFAULT NULL,
  `cep` VARCHAR(20) DEFAULT NULL,
  `entrega_endereco` VARCHAR(255) DEFAULT NULL,
  `entrega_numero` VARCHAR(50) DEFAULT NULL,
  `entrega_complemento` VARCHAR(255) DEFAULT NULL,
  `entrega_bairro` VARCHAR(100) DEFAULT NULL,
  `entrega_cidade` VARCHAR(100) DEFAULT NULL,
  `entrega_uf` VARCHAR(10) DEFAULT NULL,
  `entrega_cep` VARCHAR(20) DEFAULT NULL,
  UNIQUE KEY `uk_clientes_empresa_id` (`empresa_id`, `id`),
  INDEX `idx_clientes_empresa_nome` (`empresa_id`, `nome`),
  INDEX `idx_clientes_empresa_doc` (`empresa_id`, `documento`),
  CONSTRAINT `fk_clientes_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Tabela: contratos
CREATE TABLE IF NOT EXISTS `contratos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `cliente_id` INT NOT NULL,
  `numero` VARCHAR(100) NOT NULL,
  `valor` DECIMAL(15,2) NOT NULL,
  `data_inicio` VARCHAR(50) NOT NULL,
  `data_fim` VARCHAR(50) NOT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'Ativo',
  `drive_file_id` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_contratos_empresa_id` (`empresa_id`, `id`),
  UNIQUE KEY `uk_contratos_empresa_numero` (`empresa_id`, `numero`),
  INDEX `idx_contratos_empresa_cliente` (`empresa_id`, `cliente_id`),
  CONSTRAINT `fk_contratos_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_contratos_empresa_cliente` FOREIGN KEY (`empresa_id`, `cliente_id`) REFERENCES `clientes`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Tabela: servicos
CREATE TABLE IF NOT EXISTS `servicos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `nome` VARCHAR(255) NOT NULL,
  `unidade` INT NOT NULL DEFAULT 1,
  `tempo` INT NOT NULL,
  `sequencia` INT DEFAULT 0,
  UNIQUE KEY `uk_servicos_empresa_id` (`empresa_id`, `id`),
  INDEX `idx_servicos_empresa_seq` (`empresa_id`, `sequencia`),
  CONSTRAINT `fk_servicos_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Tabela: Ordem_Servico
CREATE TABLE IF NOT EXISTS `Ordem_Servico` (
  `empresa_id` INT NOT NULL,
  `Numero` BIGINT NOT NULL,
  `ProjetoID` INT NOT NULL DEFAULT 1,
  `DataCriacao` DATE DEFAULT NULL,
  `DataConclusao` DATE DEFAULT NULL,
  `Situacao` VARCHAR(20) NOT NULL DEFAULT 'Aberta',
  `Responsavel` VARCHAR(20) DEFAULT NULL,
  `NomeProjeto` VARCHAR(255) DEFAULT NULL,
  `Tempo` INT DEFAULT 0,
  PRIMARY KEY (`empresa_id`, `Numero`, `ProjetoID`),
  INDEX `idx_os_empresa_situacao` (`empresa_id`, `Situacao`),
  CONSTRAINT `fk_ordem_servico_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Tabela: Parametro_Financeiro
CREATE TABLE IF NOT EXISTS `Parametro_Financeiro` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `nome` VARCHAR(255) NOT NULL,
  `situacao` VARCHAR(50) DEFAULT 'Ativado',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_param_fin_empresa_id` (`empresa_id`, `id`),
  CONSTRAINT `fk_parametro_financeiro_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Tabela: configuracoes_financeiras
CREATE TABLE IF NOT EXISTS `configuracoes_financeiras` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `parametro_id` INT NOT NULL,
  `perc_imposto` DECIMAL(5,2) DEFAULT 6.00,
  `perc_comissao` DECIMAL(5,2) DEFAULT 5.00,
  `perc_custo_financeiro` DECIMAL(5,2) DEFAULT 4.00,
  `perc_markup_lucro` DECIMAL(5,2) DEFAULT 20.00,
  `perc_margem_minima` DECIMAL(5,2) DEFAULT 10.00,
  `metodo_calculo` VARCHAR(50) DEFAULT 'divisor',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_config_fin_empresa_param` (`empresa_id`, `parametro_id`),
  CONSTRAINT `fk_configuracoes_financeiras_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_config_fin_empresa_param` FOREIGN KEY (`empresa_id`, `parametro_id`) REFERENCES `Parametro_Financeiro`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Tabela: orcamentos
CREATE TABLE IF NOT EXISTS `orcamentos` (
  `numero` BIGINT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `data_criacao` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `cliente_id` INT NOT NULL,
  `descricao` TEXT,
  `status` VARCHAR(50) DEFAULT 'Em Aberto',
  `situacao` VARCHAR(50) DEFAULT 'Em Aberto',
  `parametro_financeiro_id` INT DEFAULT NULL,
  `desconto_percentual` DECIMAL(6,2) DEFAULT 0.00,
  `desconto_valor` DECIMAL(15,2) DEFAULT 0.00,
  `total_venda` DECIMAL(15,2) DEFAULT NULL,
  `forma_pagamento_selecionada` TEXT DEFAULT NULL,
  `anotacoes_cliente` TEXT DEFAULT NULL,
  `anotacoes_conclusao` TEXT DEFAULT NULL,
  `data_aprovacao` DATETIME DEFAULT NULL,
  `data_entrada` TEXT DEFAULT NULL,
  `fluxo_financeiro` TEXT DEFAULT NULL,
  `fluxo_efetivado` TINYINT DEFAULT 0,
  `data_assinatura` DATETIME DEFAULT NULL,
  `assinatura_responsavel` TEXT DEFAULT NULL,
  `usuario_assinatura_nome` VARCHAR(255) DEFAULT NULL,
  UNIQUE KEY `uk_orcamentos_empresa_numero` (`empresa_id`, `numero`),
  INDEX `idx_orcamentos_empresa_status` (`empresa_id`, `status`),
  INDEX `idx_orcamentos_empresa_cliente` (`empresa_id`, `cliente_id`),
  INDEX `idx_orcamentos_empresa_criacao` (`empresa_id`, `data_criacao`),
  CONSTRAINT `fk_orcamentos_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_orcamentos_empresa_cliente` FOREIGN KEY (`empresa_id`, `cliente_id`) REFERENCES `clientes`(`empresa_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_orcamentos_empresa_param_fin` FOREIGN KEY (`empresa_id`, `parametro_financeiro_id`) REFERENCES `Parametro_Financeiro`(`empresa_id`, `id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Tabela: projetos
CREATE TABLE IF NOT EXISTS `projetos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `orcamento_numero` BIGINT DEFAULT NULL,
  `nome` VARCHAR(255) NOT NULL,
  `descricao` TEXT,
  `ProjetoURL` TEXT DEFAULT NULL,
  `ProjetoQtdPecas` INT DEFAULT 0,
  `CustoTotal` DECIMAL(15,2) DEFAULT 0.00,
  `CustoMaterial` DECIMAL(15,2) DEFAULT 0.00,
  `CustoProducao` DECIMAL(15,2) DEFAULT 0.00,
  `DuracaoFabricacao` INT DEFAULT 0,
  `DuracaoMontagem` INT DEFAULT 0,
  `perc_imposto` DECIMAL(5,2) DEFAULT NULL,
  `perc_comissao` DECIMAL(5,2) DEFAULT NULL,
  `perc_custo_financeiro` DECIMAL(5,2) DEFAULT NULL,
  `perc_markup_lucro` DECIMAL(5,2) DEFAULT NULL,
  `preco_venda_sugerido` DECIMAL(15,2) DEFAULT 0.00,
  `preco_venda_final` DECIMAL(15,2) DEFAULT 0.00,
  `parametro_financeiro_id` INT DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_projetos_empresa_id` (`empresa_id`, `id`),
  INDEX `idx_projetos_empresa_orcamento` (`empresa_id`, `orcamento_numero`),
  CONSTRAINT `fk_projetos_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_projetos_empresa_orcamento` FOREIGN KEY (`empresa_id`, `orcamento_numero`) REFERENCES `orcamentos`(`empresa_id`, `numero`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Tabela: arquivos_importados
CREATE TABLE IF NOT EXISTS `arquivos_importados` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `nome_arquivo` VARCHAR(255) NOT NULL,
  `tamanho` INT NOT NULL,
  `tipo_layout` VARCHAR(50) NOT NULL,
  `caminho_arquivo` VARCHAR(500) NOT NULL,
  `projeto_id` INT DEFAULT NULL,
  `data_upload` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_arq_imp_empresa_projeto` (`empresa_id`, `projeto_id`),
  CONSTRAINT `fk_arquivos_importados_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_arquivos_importados_empresa_projeto` FOREIGN KEY (`empresa_id`, `projeto_id`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Tabela: Projeto_Materiais
CREATE TABLE IF NOT EXISTS `Projeto_Materiais` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `projeto_id` INT NOT NULL,
  `referencia` VARCHAR(255) NOT NULL,
  `descricao` TEXT NOT NULL,
  `qtd` DECIMAL(15,4) NOT NULL,
  `un` VARCHAR(50) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_proj_mat_empresa_projeto` (`empresa_id`, `projeto_id`),
  CONSTRAINT `fk_projeto_materiais_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_proj_materiais_empresa_projeto` FOREIGN KEY (`empresa_id`, `projeto_id`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Tabela: projeto_anexos
CREATE TABLE IF NOT EXISTS `projeto_anexos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `projeto_id` INT NOT NULL,
  `nome_original` VARCHAR(255) NOT NULL,
  `nome_arquivo` VARCHAR(255) NOT NULL,
  `caminho` VARCHAR(500) NOT NULL,
  `tipo_mime` VARCHAR(100) DEFAULT NULL,
  `tamanho` INT DEFAULT NULL,
  `exibir_na_proposta` VARCHAR(10) DEFAULT 'Sim',
  `criado_em` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `criado_por_nome` VARCHAR(255) DEFAULT NULL,
  INDEX `idx_proj_anexos_empresa_projeto` (`empresa_id`, `projeto_id`),
  CONSTRAINT `fk_projeto_anexos_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_proj_anexos_empresa_projeto` FOREIGN KEY (`empresa_id`, `projeto_id`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Tabela: Projeto_Modulo
CREATE TABLE IF NOT EXISTS `Projeto_Modulo` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `projeto_id` INT NOT NULL,
  `modulo` VARCHAR(255) NOT NULL,
  `peca` VARCHAR(255) NOT NULL,
  `imagem` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_proj_mod_empresa_projeto` (`empresa_id`, `projeto_id`),
  CONSTRAINT `fk_projeto_modulo_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_proj_modulo_empresa_projeto` FOREIGN KEY (`empresa_id`, `projeto_id`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. Tabela: Projeto_Chapa
CREATE TABLE IF NOT EXISTS `Projeto_Chapa` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `projeto_id` INT NOT NULL,
  `chapa` VARCHAR(255) NOT NULL,
  `acabamento` VARCHAR(255) NOT NULL,
  `DescChapa` TEXT DEFAULT NULL,
  `item` VARCHAR(255) NOT NULL,
  `descricao` TEXT NOT NULL,
  `dimensao` VARCHAR(255) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_proj_chapa_empresa_projeto` (`empresa_id`, `projeto_id`),
  CONSTRAINT `fk_projeto_chapa_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_proj_chapa_empresa_projeto` FOREIGN KEY (`empresa_id`, `projeto_id`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Tabela: Projeto_Pecas
CREATE TABLE IF NOT EXISTS `Projeto_Pecas` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `projeto_id` INT NOT NULL,
  `peca` VARCHAR(255) DEFAULT NULL,
  `etiqueta` VARCHAR(255) DEFAULT NULL,
  `dimen` VARCHAR(255) DEFAULT NULL,
  `chapa` VARCHAR(255) DEFAULT NULL,
  `modulo` VARCHAR(255) DEFAULT NULL,
  `cod_item` VARCHAR(255) DEFAULT NULL,
  `imagem` LONGTEXT DEFAULT NULL,
  `cor_barras` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_proj_pecas_empresa_projeto` (`empresa_id`, `projeto_id`),
  CONSTRAINT `fk_projeto_pecas_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_proj_pecas_empresa_projeto` FOREIGN KEY (`empresa_id`, `projeto_id`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. Tabela: Material
CREATE TABLE IF NOT EXISTS `Material` (
  `empresa_id` INT NOT NULL,
  `MaterialReferencia` VARCHAR(100) NOT NULL,
  `MaterialDescricao` VARCHAR(255) NOT NULL,
  `MaterialUnidade` VARCHAR(20) DEFAULT NULL,
  `MaterialValorUnitario` DECIMAL(15,4) DEFAULT 0.0000,
  `GrupoSigla` VARCHAR(50) DEFAULT NULL,
  `ProdutoGrupo` INT DEFAULT 8,
  `MaterialTipo` VARCHAR(50) DEFAULT 'Produto',
  `MaterialImagem` LONGTEXT DEFAULT NULL,
  `MaterialTempo` INT DEFAULT 0,
  `ExibirNaProposta` VARCHAR(10) DEFAULT 'Nao',
  PRIMARY KEY (`empresa_id`, `MaterialReferencia`),
  INDEX `idx_material_empresa_tipo` (`empresa_id`, `MaterialTipo`),
  CONSTRAINT `fk_material_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. Tabela: ProjetoItem
CREATE TABLE IF NOT EXISTS `ProjetoItem` (
  `empresa_id` INT NOT NULL,
  `ProjetoID` INT NOT NULL,
  `ProjetoItemID` INT NOT NULL,
  `MaterialReferencia` VARCHAR(100) NOT NULL,
  `ProjetoItemVlrUnit` DECIMAL(15,2) NOT NULL,
  `ProjetoItemUnidade` VARCHAR(10) NOT NULL,
  `ProjetoItemQtd` DECIMAL(15,4) NOT NULL,
  `ProjetoItemTotal` DECIMAL(15,2) NOT NULL,
  `ProjetoItemTempo` INT DEFAULT 0,
  `ProjetoItemDuracao` INT DEFAULT 0,
  PRIMARY KEY (`empresa_id`, `ProjetoID`, `ProjetoItemID`),
  CONSTRAINT `fk_projetoitem_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_projetoitem_empresa_projeto` FOREIGN KEY (`empresa_id`, `ProjetoID`) REFERENCES `projetos`(`empresa_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_projetoitem_empresa_material` FOREIGN KEY (`empresa_id`, `MaterialReferencia`) REFERENCES `Material`(`empresa_id`, `MaterialReferencia`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. Tabela: formas_pagamento
CREATE TABLE IF NOT EXISTS `formas_pagamento` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `nome` VARCHAR(255) NOT NULL,
  `descricao` TEXT DEFAULT NULL,
  `valor_minimo` DECIMAL(15,2) DEFAULT 0.00,
  `valor_maximo` DECIMAL(15,2) DEFAULT 0.00,
  `ativo` VARCHAR(10) NOT NULL DEFAULT 'Sim',
  `ordem` INT DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_formas_pag_empresa_id` (`empresa_id`, `id`),
  CONSTRAINT `fk_formas_pagamento_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. Tabela: condicoes_pagamento
CREATE TABLE IF NOT EXISTS `condicoes_pagamento` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `forma_pagamento_id` INT NOT NULL,
  `perc_entrada` DECIMAL(5,2) DEFAULT 0.00,
  `num_parcelas` INT DEFAULT 0,
  `perc_desconto` DECIMAL(5,2) DEFAULT 0.00,
  `meio_pagamento` VARCHAR(50) DEFAULT '',
  `descricao` VARCHAR(255) NOT NULL,
  `ordem` INT DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_condicoes_pagamento_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_condicoes_pag_empresa_forma` FOREIGN KEY (`empresa_id`, `forma_pagamento_id`) REFERENCES `formas_pagamento`(`empresa_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20. Tabela: propostas
CREATE TABLE IF NOT EXISTS `propostas` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `orcamento_numero` BIGINT NOT NULL,
  `versao` INT NOT NULL DEFAULT 1,
  `codigo` VARCHAR(50) DEFAULT '',
  `titulo` VARCHAR(255) DEFAULT '',
  `descricao` TEXT DEFAULT NULL,
  `valor_total` DECIMAL(15,2) DEFAULT 0.00,
  `desconto_percentual` DECIMAL(6,2) DEFAULT 0.00,
  `desconto_valor` DECIMAL(15,2) DEFAULT 0.00,
  `valor_final` DECIMAL(15,2) DEFAULT 0.00,
  `forma_pagamento_selecionada` TEXT DEFAULT NULL,
  `dados_snapshot` LONGTEXT DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'Gerada',
  `observacoes` TEXT DEFAULT NULL,
  `criado_por` INT DEFAULT NULL,
  `criado_por_nome` VARCHAR(255) DEFAULT NULL,
  `criado_em` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_propostas_empresa_id` (`empresa_id`, `id`),
  INDEX `idx_propostas_empresa_orc` (`empresa_id`, `orcamento_numero`),
  CONSTRAINT `fk_propostas_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_propostas_empresa_orcamento` FOREIGN KEY (`empresa_id`, `orcamento_numero`) REFERENCES `orcamentos`(`empresa_id`, `numero`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 21. Tabela: proposta_compartilhamentos
CREATE TABLE IF NOT EXISTS `proposta_compartilhamentos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `orcamento_numero` BIGINT NOT NULL,
  `proposta_id` INT DEFAULT NULL,
  `token` VARCHAR(255) UNIQUE NOT NULL,
  `criado_por` INT DEFAULT NULL,
  `criado_por_nome` VARCHAR(255) DEFAULT NULL,
  `criado_em` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `expira_em` DATETIME NOT NULL,
  `acessos_count` INT DEFAULT 0,
  `ultimo_acesso` DATETIME DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'Ativo',
  `aprovado_em` DATETIME DEFAULT NULL,
  `forma_pagamento_selecionada` TEXT DEFAULT NULL,
  `anotacoes_cliente` TEXT DEFAULT NULL,
  INDEX `idx_prop_comp_empresa_orc` (`empresa_id`, `orcamento_numero`),
  CONSTRAINT `fk_proposta_compartilhamentos_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_prop_comp_empresa_orcamento` FOREIGN KEY (`empresa_id`, `orcamento_numero`) REFERENCES `orcamentos`(`empresa_id`, `numero`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 22. Tabela: parametros_empresa
CREATE TABLE IF NOT EXISTS `parametros_empresa` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `chave` VARCHAR(50) NOT NULL,
  `tipo` INT NOT NULL,
  `conteudo` VARCHAR(255) DEFAULT NULL,
  `descricao` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_parametros_empresa_chave` (`empresa_id`, `chave`),
  CONSTRAINT `fk_parametros_empresa_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 23. Tabela: FluxoRecebimento
CREATE TABLE IF NOT EXISTS `FluxoRecebimento` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `orcamento_numero` BIGINT NOT NULL,
  `cliente_id` INT DEFAULT NULL,
  `cliente_nome` VARCHAR(255) DEFAULT NULL,
  `descricao` VARCHAR(255) NOT NULL,
  `tipo` VARCHAR(50) DEFAULT 'Parcela',
  `numero_parcela` INT DEFAULT 1,
  `total_parcelas` INT DEFAULT 1,
  `percentual` DECIMAL(6,2) DEFAULT 0.00,
  `valor` DECIMAL(15,2) NOT NULL,
  `valor_recebido` DECIMAL(15,2) DEFAULT 0.00,
  `data_vencimento` VARCHAR(50) NOT NULL,
  `data_recebimento` VARCHAR(50) DEFAULT NULL,
  `meio_pagamento` VARCHAR(100) DEFAULT 'PIX',
  `status` VARCHAR(50) NOT NULL DEFAULT 'Pendente',
  `recibo_emitido` VARCHAR(10) NOT NULL DEFAULT 'Nao',
  `observacoes` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_fluxo_empresa_status_venc` (`empresa_id`, `status`, `data_vencimento`),
  INDEX `idx_fluxo_empresa_orcamento` (`empresa_id`, `orcamento_numero`),
  CONSTRAINT `fk_fluxorecebimento_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_fluxo_empresa_orcamento` FOREIGN KEY (`empresa_id`, `orcamento_numero`) REFERENCES `orcamentos`(`empresa_id`, `numero`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 24. Tabela: ordem_servico_checklist
CREATE TABLE IF NOT EXISTS `ordem_servico_checklist` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `empresa_id` INT NOT NULL,
  `numero` BIGINT NOT NULL,
  `projeto_id` INT NOT NULL DEFAULT 1,
  `tarefa_key` VARCHAR(50) NOT NULL,
  `tarefa_texto` TEXT NOT NULL,
  `concluido` TINYINT DEFAULT 0,
  `data_conclusao` DATETIME DEFAULT NULL,
  `responsavel` VARCHAR(255) DEFAULT NULL,
  `observacao` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_os_checklist_empresa_tarefa` (`empresa_id`, `numero`, `projeto_id`, `tarefa_key`),
  INDEX `idx_os_checklist` (`empresa_id`, `numero`, `projeto_id`),
  CONSTRAINT `fk_ordem_servico_checklist_empresa` FOREIGN KEY (`empresa_id`) REFERENCES `empresas`(`id`),
  CONSTRAINT `fk_os_checklist_empresa_os` FOREIGN KEY (`empresa_id`, `numero`, `projeto_id`) REFERENCES `Ordem_Servico`(`empresa_id`, `Numero`, `ProjetoID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- DADOS INICIAIS (SEEDS PADRÃO MULTIEMPRESA)
-- =============================================================================

-- Empresa 1 Padrão
INSERT IGNORE INTO `empresas` (`id`, `razao_social`, `nome_fantasia`, `cnpj`, `status`) VALUES
(1, 'EZATTUS PLANEJADOS LTDA', 'EZATTUS PLANEJADOS', '12.345.678/0001-90', 'Ativo');

-- Catálogo Global de Funções
INSERT IGNORE INTO `funcoes` (`id`, `chave`, `nome`, `modulo`, `descricao`) VALUES
(1, 'dashboard.visualizar', 'Visualizar Dashboard', 'Dashboard', 'Acesso aos indicadores e totais da empresa'),
(2, 'clientes.gerenciar', 'Gerenciar Clientes', 'Comercial', 'Cadastro, edição e exclusão de clientes'),
(3, 'orcamentos.gerenciar', 'Gerenciar Orçamentos e Propostas', 'Comercial', 'Criação, aprovação e compartilhamento de orçamentos'),
(4, 'contratos.gerenciar', 'Gerenciar Contratos', 'Comercial', 'Emissão e assinatura de contratos'),
(5, 'projetos.gerenciar', 'Gerenciar Projetos e Itens', 'Engenharia', 'Gestão de projetos, materiais, peças e layouts'),
(6, 'materiais.gerenciar', 'Gerenciar Catálogo de Materiais', 'Suprimentos', 'Cadastro e precificação de materiais e chapas'),
(7, 'servicos.gerenciar', 'Gerenciar Serviços de Fábrica', 'Produção', 'Configuração de serviços e tempos de fabricação'),
(8, 'ordens_servico.gerenciar', 'Gerenciar Ordens de Serviço e Revisão', 'Produção', 'Controle de OS, revisão técnica e apontamentos'),
(9, 'financeiro.gerenciar', 'Gerenciar Fluxo de Recebimento e Parâmetros', 'Financeiro', 'Baixa de parcelas, recibos e parâmetros financeiros'),
(10, 'usuarios.gerenciar', 'Administrar Usuários e Perfis da Empresa', 'Administração', 'Gestão de usuários e perfis da própria empresa'),
(11, 'parametros.gerenciar', 'Configurar Parâmetros da Empresa', 'Administração', 'Configuração de logomarca, assinatura e dados da empresa');

-- Perfis padrão da Empresa 1
INSERT IGNORE INTO `perfis` (`id`, `empresa_id`, `nome`, `descricao`, `is_admin`, `ativo`) VALUES
(1, 1, 'Administrador', 'Acesso administrativo completo na empresa', 1, 1),
(2, 1, 'Operador', 'Acesso operacional padrão na empresa', 0, 1);

-- Usuário Administrador padrão da Empresa 1: admin@erp.com / Senha: admin123
INSERT IGNORE INTO `usuarios` (`id`, `empresa_id`, `perfil_id`, `nome`, `email`, `senha`, `role`, `ativo`) VALUES
(1, 1, 1, 'Administrador', 'admin@erp.com', '$2a$10$54lyxgdvKMMm1oGkriwodOmhubpGxAEbXWCi.w29LIV1IkGXgg0jS', 'admin', 1);

-- Parâmetro Financeiro Padrão (Empresa 1)
INSERT IGNORE INTO `Parametro_Financeiro` (`id`, `empresa_id`, `nome`, `situacao`) VALUES
(1, 1, 'Padrão Fábrica', 'Ativado');

INSERT IGNORE INTO `configuracoes_financeiras` (`id`, `empresa_id`, `parametro_id`, `perc_imposto`, `perc_comissao`, `perc_custo_financeiro`, `perc_markup_lucro`, `perc_margem_minima`, `metodo_calculo`) VALUES
(1, 1, 1, 6.00, 5.00, 4.00, 20.00, 10.00, 'divisor');

-- Serviços padrão de fábrica (Empresa 1)
INSERT IGNORE INTO `servicos` (`id`, `empresa_id`, `nome`, `unidade`, `tempo`, `sequencia`) VALUES
(1, 1, 'Separação', 1, 15, 5),
(2, 1, 'Usinagem', 2, 45, 10),
(3, 1, 'Fitagem', 3, 10, 20),
(4, 1, 'Montagem de caixa', 4, 30, 30),
(5, 1, 'Especial', 6, 60, 40);

-- Item de fabricação padrão em Material (Empresa 1)
INSERT IGNORE INTO `Material` (`empresa_id`, `MaterialReferencia`, `MaterialDescricao`, `MaterialUnidade`, `MaterialValorUnitario`, `GrupoSigla`, `ProdutoGrupo`, `MaterialTipo`, `MaterialTempo`, `ExibirNaProposta`) VALUES
(1, 'FAB.MON.CLI', 'Montagem cliente', 'DIA', 0.0000, NULL, 8, 'Serviço', 0, 'Nao');

-- Parâmetros da Empresa 1
INSERT IGNORE INTO `parametros_empresa` (`empresa_id`, `chave`, `tipo`, `conteudo`, `descricao`) VALUES
(1, 'RAZAO_SOC', 1, 'EZATTUS PLANEJADOS LTDA', 'Razão social oficial da empresa'),
(1, 'NOME_FANT', 1, 'EZATTUS PLANEJADOS', 'Nome fantasia da marca'),
(1, 'CNPJ', 1, '12.345.678/0001-90', 'CNPJ da matriz'),
(1, 'VAL_HORA', 2, '85.00', 'Valor da hora técnica padrão (R$)'),
(1, 'DT_FUNDAC', 3, '2015-06-10', 'Data de fundação da empresa'),
(1, 'DESC_MAX', 4, '15.00', 'Percentual de desconto máximo para vendedores (%)'),
(1, 'MIN_PECAS', 5, '1 UN', 'Lote mínimo padrão de peças por projeto'),
(1, 'HORA_INI', 6, '08:00', 'Horário de início do expediente'),
(1, 'EMP_LOGO', 7, '', 'Logomarca da empresa para cabeçalhos e documentos'),
(1, 'EMP_ASS', 7, '', 'Assinatura do responsável para contratos e recibos');

INSERT IGNORE INTO `schema_migrations` (`version`, `description`, `status`) VALUES
('V2026_10_28_MULTITENANT_V1', 'Isolamento multiempresa por empresa_id, chaves compostas, perfis, auditoria e segurança de uploads', 'APPLIED');

SET FOREIGN_KEY_CHECKS = 1;
