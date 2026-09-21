# Diretrizes de Verificação de Alterações

- O agente NÃO deve executar testes de verificação automatizados no navegador (`browser_subagent`) nem builds de produção automáticos após realizar alterações no código.
- A verificação manual do funcionamento das telas e das rotas deve ser realizada pelo próprio usuário.
- O agente deve apenas aplicar as modificações de código e relatar as alterações feitas, deixando a verificação e testes a cargo do usuário.
