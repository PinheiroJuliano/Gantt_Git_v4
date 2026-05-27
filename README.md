# 📊 Issue Gantt & Progress Tracker

Uma ferramenta de visualização dinâmica que transforma as Issues do GitLab em um gráfico de Gantt interativo, com gestão de risco temporal e persistência de dados via GitHub API.

## 🚀 Funcionalidades

*   **Timeline Dinâmica:** Visualização clara de prazos e períodos de execução.
*   **Gestão de Risco:** Barras com lógica de cores e comportamento visual de alerta (pulso vermelho) para tarefas atrasadas.
*   **Progresso Temporal vs. Real:** Diferenciação visual entre o tempo consumido do prazo e o esforço manual reportado.
*   **Persistência Centralizada:** Banco de dados baseado em arquivo JSON hospedado no repositório, permitindo sincronização entre diferentes usuários.
*   **Configuração Externa:** Gerenciamento de credenciais e filtros de grupo/milestone via `config.json`.

## 🛠️ Tecnologias

*   **Frontend:** HTML5, CSS3 (Variáveis, Grid Layout), JavaScript (ES6+).
*   **Integrações:** GitLab API v4 (Issues) e GitHub Content API (Database).

## 📋 Como usar

1.  **Configuração de Credenciais:**
    *   Crie um arquivo `config.json` na raiz do projeto com o seguinte formato:
    ```json
    {
      "token": "seu-token-gitlab",
      "url": "[https://seu-gitlab.com](https://seu-gitlab.com)",
      "group": "ID-DO-GRUPO",
      "milestone": "Nome da Milestone"
    }
    ```

2.  **Banco de Dados:**
    *   Crie um arquivo `database.json` vazio (`{}`) no seu repositório GitHub para armazenar as porcentagens.

3.  **Execução:**
    *   O projeto utiliza `fetch` para carregar dados externos. Para rodar localmente, utilize o **Live Server** (ou qualquer servidor HTTP). No ambiente de produção, utilize o **GitHub/GitLab Pages**.

4.  **Interação:**
    *   Arraste a barra na coluna de **Progresso** para atualizar o esforço real. O salvamento no banco central ocorre automaticamente ao soltar o arraste.

## 🔒 Segurança

> [!IMPORTANT]  
> Este projeto foi desenhado para uso em ambiente interno. O token configurado no `config.json` é consumido pelo front-end para autenticação. Certifique-se de utilizar tokens com permissões mínimas necessárias (Read-only para GitLab e Content-write para o repositório do banco).

---
*Desenvolvido para otimização de cronogramas e gestão de issues.*
