-- =============================================================================
-- SCRIPT DE CRIAÇÃO DO BANCO DE DADOS - ERP CHÃO DE FÁBRICA (HOSTINGER / MySQL)
-- Como usar:
-- 1. Acesse o hPanel da Hostinger -> Bancos de Dados -> phpMyAdmin
-- 2. Selecione o seu banco de dados na lateral esquerda
-- 3. Clique na aba "Importar" (ou "SQL") no topo, selecione este arquivo e execute.
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Tabela: usuarios
CREATE TABLE IF NOT EXISTS `usuarios` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `nome` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `senha` VARCHAR(255) NOT NULL,
  `role` VARCHAR(50) NOT NULL DEFAULT 'user',
  `assinatura` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabela: clientes
CREATE TABLE IF NOT EXISTS `clientes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
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
  `entrega_cep` VARCHAR(20) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Tabela: contratos
CREATE TABLE IF NOT EXISTS `contratos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `cliente_id` INT NOT NULL,
  `numero` VARCHAR(100) NOT NULL UNIQUE,
  `valor` DECIMAL(15,2) NOT NULL,
  `data_inicio` VARCHAR(50) NOT NULL,
  `data_fim` VARCHAR(50) NOT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'Ativo',
  `drive_file_id` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Tabela: servicos
CREATE TABLE IF NOT EXISTS `servicos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `nome` VARCHAR(255) NOT NULL,
  `unidade` INT NOT NULL DEFAULT 1,
  `tempo` INT NOT NULL,
  `sequencia` INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Tabela: Ordem_Servico
CREATE TABLE IF NOT EXISTS `Ordem_Servico` (
  `Numero` BIGINT NOT NULL,
  `ProjetoID` DECIMAL(3,0) NOT NULL DEFAULT 1,
  `DataCriacao` DATE DEFAULT NULL,
  `DataConclusao` DATE DEFAULT NULL,
  `Situacao` VARCHAR(20) NOT NULL DEFAULT 'Aberta',
  `Responsavel` VARCHAR(20) DEFAULT NULL,
  `NomeProjeto` VARCHAR(255) DEFAULT NULL,
  `Tempo` INT DEFAULT 0,
  PRIMARY KEY (`Numero`, `ProjetoID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Tabela: Parametro_Financeiro
CREATE TABLE IF NOT EXISTS `Parametro_Financeiro` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `nome` VARCHAR(255) NOT NULL,
  `situacao` VARCHAR(50) DEFAULT 'Ativado',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Tabela: configuracoes_financeiras
CREATE TABLE IF NOT EXISTS `configuracoes_financeiras` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parametro_id` INT NOT NULL UNIQUE,
  `perc_imposto` DECIMAL(5,2) DEFAULT 6.00,
  `perc_comissao` DECIMAL(5,2) DEFAULT 5.00,
  `perc_custo_financeiro` DECIMAL(5,2) DEFAULT 4.00,
  `perc_markup_lucro` DECIMAL(5,2) DEFAULT 20.00,
  `perc_margem_minima` DECIMAL(5,2) DEFAULT 10.00,
  `metodo_calculo` VARCHAR(50) DEFAULT 'divisor',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`parametro_id`) REFERENCES `Parametro_Financeiro`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Tabela: orcamentos
CREATE TABLE IF NOT EXISTS `orcamentos` (
  `numero` BIGINT PRIMARY KEY,
  `data_criacao` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `cliente_id` INT NOT NULL,
  `descricao` TEXT,
  `status` VARCHAR(50) DEFAULT 'Em Aberto',
  `situacao` VARCHAR(50) DEFAULT 'Em Aberto',
  `parametro_financeiro_id` INT DEFAULT 1,
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
  FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`parametro_financeiro_id`) REFERENCES `Parametro_Financeiro`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Tabela: projetos
CREATE TABLE IF NOT EXISTS `projetos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `orcamento_numero` BIGINT NOT NULL,
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
  FOREIGN KEY (`orcamento_numero`) REFERENCES `orcamentos`(`numero`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Tabela: arquivos_importados
CREATE TABLE IF NOT EXISTS `arquivos_importados` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `nome_arquivo` VARCHAR(255) NOT NULL,
  `tamanho` INT NOT NULL,
  `tipo_layout` VARCHAR(50) NOT NULL,
  `caminho_arquivo` VARCHAR(500) NOT NULL,
  `projeto_id` INT DEFAULT NULL,
  `data_upload` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Tabela: Projeto_Materiais
CREATE TABLE IF NOT EXISTS `Projeto_Materiais` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `projeto_id` INT NOT NULL,
  `referencia` VARCHAR(255) NOT NULL,
  `descricao` TEXT NOT NULL,
  `qtd` DECIMAL(15,4) NOT NULL,
  `un` VARCHAR(50) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Tabela: projeto_anexos
CREATE TABLE IF NOT EXISTS `projeto_anexos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `projeto_id` INT NOT NULL,
  `nome_original` VARCHAR(255) NOT NULL,
  `nome_arquivo` VARCHAR(255) NOT NULL,
  `caminho` VARCHAR(500) NOT NULL,
  `tipo_mime` VARCHAR(100) DEFAULT NULL,
  `tamanho` INT DEFAULT NULL,
  `exibir_na_proposta` VARCHAR(10) DEFAULT 'Sim',
  `criado_em` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `criado_por_nome` VARCHAR(255) DEFAULT NULL,
  FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Tabela: Projeto_Modulo
CREATE TABLE IF NOT EXISTS `Projeto_Modulo` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `projeto_id` INT NOT NULL,
  `modulo` VARCHAR(255) NOT NULL,
  `peca` VARCHAR(255) NOT NULL,
  `imagem` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. Tabela: Projeto_Chapa
CREATE TABLE IF NOT EXISTS `Projeto_Chapa` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `projeto_id` INT NOT NULL,
  `chapa` VARCHAR(255) NOT NULL,
  `acabamento` VARCHAR(255) NOT NULL,
  `DescChapa` TEXT DEFAULT NULL,
  `item` VARCHAR(255) NOT NULL,
  `descricao` TEXT NOT NULL,
  `dimensao` VARCHAR(255) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Tabela: Projeto_Pecas
CREATE TABLE IF NOT EXISTS `Projeto_Pecas` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
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
  FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. Tabela: Material
CREATE TABLE IF NOT EXISTS `Material` (
  `MaterialReferencia` VARCHAR(100) PRIMARY KEY,
  `MaterialDescricao` VARCHAR(255) NOT NULL,
  `MaterialUnidade` VARCHAR(20) DEFAULT NULL,
  `MaterialValorUnitario` DECIMAL(15,4) DEFAULT 0.0000,
  `GrupoSigla` VARCHAR(50) DEFAULT NULL,
  `ProdutoGrupo` INT DEFAULT 8,
  `MaterialTipo` VARCHAR(50) DEFAULT 'Produto',
  `MaterialImagem` LONGTEXT DEFAULT NULL,
  `MaterialTempo` INT DEFAULT 0,
  `ExibirNaProposta` VARCHAR(10) DEFAULT 'Nao'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. Tabela: ProjetoItem
CREATE TABLE IF NOT EXISTS `ProjetoItem` (
  `ProjetoID` INT NOT NULL,
  `ProjetoItemID` INT NOT NULL,
  `MaterialReferencia` VARCHAR(100) NOT NULL,
  `ProjetoItemVlrUnit` DECIMAL(15,2) NOT NULL,
  `ProjetoItemUnidade` VARCHAR(10) NOT NULL,
  `ProjetoItemQtd` DECIMAL(15,4) NOT NULL,
  `ProjetoItemTotal` DECIMAL(15,2) NOT NULL,
  `ProjetoItemTempo` INT DEFAULT 0,
  `ProjetoItemDuracao` INT DEFAULT 0,
  PRIMARY KEY (`ProjetoID`, `ProjetoItemID`),
  FOREIGN KEY (`ProjetoID`) REFERENCES `projetos`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`MaterialReferencia`) REFERENCES `Material`(`MaterialReferencia`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. Tabela: formas_pagamento
CREATE TABLE IF NOT EXISTS `formas_pagamento` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `nome` VARCHAR(255) NOT NULL,
  `descricao` TEXT DEFAULT NULL,
  `valor_minimo` DECIMAL(15,2) DEFAULT 0.00,
  `valor_maximo` DECIMAL(15,2) DEFAULT 0.00,
  `ativo` VARCHAR(10) NOT NULL DEFAULT 'Sim',
  `ordem` INT DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. Tabela: condicoes_pagamento
CREATE TABLE IF NOT EXISTS `condicoes_pagamento` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `forma_pagamento_id` INT NOT NULL,
  `perc_entrada` DECIMAL(5,2) DEFAULT 0.00,
  `num_parcelas` INT DEFAULT 0,
  `perc_desconto` DECIMAL(5,2) DEFAULT 0.00,
  `meio_pagamento` VARCHAR(50) DEFAULT '',
  `descricao` VARCHAR(255) NOT NULL,
  `ordem` INT DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`forma_pagamento_id`) REFERENCES `formas_pagamento`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20. Tabela: propostas
CREATE TABLE IF NOT EXISTS `propostas` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
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
  INDEX `idx_orcamento_numero` (`orcamento_numero`),
  INDEX `idx_versao` (`versao`),
  FOREIGN KEY (`orcamento_numero`) REFERENCES `orcamentos`(`numero`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 21. Tabela: proposta_compartilhamentos
CREATE TABLE IF NOT EXISTS `proposta_compartilhamentos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
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
  FOREIGN KEY (`orcamento_numero`) REFERENCES `orcamentos`(`numero`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 22. Tabela: parametros_empresa
CREATE TABLE IF NOT EXISTS `parametros_empresa` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `chave` VARCHAR(50) NOT NULL UNIQUE,
  `tipo` INT NOT NULL,
  `conteudo` VARCHAR(255) DEFAULT NULL,
  `descricao` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 23. Tabela: FluxoRecebimento
CREATE TABLE IF NOT EXISTS `FluxoRecebimento` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
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
  INDEX `idx_orcamento_numero` (`orcamento_numero`),
  INDEX `idx_cliente_id` (`cliente_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_data_vencimento` (`data_vencimento`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 24. Tabela: ordem_servico_checklist
CREATE TABLE IF NOT EXISTS `ordem_servico_checklist` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `numero` BIGINT NOT NULL,
  `projeto_id` DECIMAL(3,0) NOT NULL DEFAULT 1,
  `tarefa_key` VARCHAR(50) NOT NULL,
  `tarefa_texto` TEXT NOT NULL,
  `concluido` TINYINT DEFAULT 0,
  `data_conclusao` DATETIME DEFAULT NULL,
  `responsavel` VARCHAR(255) DEFAULT NULL,
  `observacao` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_os_tarefa` (`numero`, `projeto_id`, `tarefa_key`),
  INDEX `idx_os_checklist` (`numero`, `projeto_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- DADOS INICIAIS (SEEDS PADRÃO)
-- =============================================================================

-- Usuário Administrador padrão: admin@erp.com / Senha: admin123
INSERT IGNORE INTO `usuarios` (`id`, `nome`, `email`, `senha`, `role`) VALUES
(1, 'Administrador', 'admin@erp.com', '$2a$10$54lyxgdvKMMm1oGkriwodOmhubpGxAEbXWCi.w29LIV1IkGXgg0jS', 'admin');

-- Parâmetro Financeiro Padrão
INSERT IGNORE INTO `Parametro_Financeiro` (`id`, `nome`, `situacao`) VALUES
(1, 'Padrão Fábrica', 'Ativado');

INSERT IGNORE INTO `configuracoes_financeiras` (`id`, `parametro_id`, `perc_imposto`, `perc_comissao`, `perc_custo_financeiro`, `perc_markup_lucro`, `perc_margem_minima`, `metodo_calculo`) VALUES
(1, 1, 6.00, 5.00, 4.00, 20.00, 10.00, 'divisor');

-- Serviços padrão de fábrica
INSERT IGNORE INTO `servicos` (`id`, `nome`, `unidade`, `tempo`, `sequencia`) VALUES
(1, 'Separação', 1, 15, 5),
(2, 'Usinagem', 2, 45, 10),
(3, 'Fitagem', 3, 10, 20),
(4, 'Montagem de caixa', 4, 30, 30),
(5, 'Especial', 6, 60, 40);

-- Item de fabricação padrão em Material
INSERT IGNORE INTO `Material` (`MaterialReferencia`, `MaterialDescricao`, `MaterialUnidade`, `MaterialValorUnitario`, `GrupoSigla`, `ProdutoGrupo`, `MaterialTipo`, `MaterialTempo`, `ExibirNaProposta`) VALUES
('FAB.MON.CLI', 'Montagem cliente', 'DIA', 0.0000, NULL, 8, 'Serviço', 0, 'Nao');

-- Parâmetros da Empresa
INSERT IGNORE INTO `parametros_empresa` (`chave`, `tipo`, `conteudo`, `descricao`) VALUES
('RAZAO_SOC', 1, 'EZATTUS PLANEJADOS LTDA', 'Razão social oficial da empresa'),
('NOME_FANT', 1, 'EZATTUS PLANEJADOS', 'Nome fantasia da marca'),
('CNPJ', 1, '12.345.678/0001-90', 'CNPJ da matriz'),
('VAL_HORA', 2, '85.00', 'Valor da hora técnica padrão (R$)'),
('DT_FUNDAC', 3, '2015-06-10', 'Data de fundação da empresa'),
('DESC_MAX', 4, '15.00', 'Percentual de desconto máximo para vendedores (%)'),
('MIN_PECAS', 5, '1 UN', 'Lote mínimo padrão de peças por projeto'),
('HORA_INI', 6, '08:00', 'Horário de início do expediente'),
('EMP_LOGO', 7, '', 'Logomarca da empresa para cabeçalhos e documentos'),
('EMP_ASS', 7, '', 'Assinatura do responsável para contratos e recibos');

SET FOREIGN_KEY_CHECKS = 1;

