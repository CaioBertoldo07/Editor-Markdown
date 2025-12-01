# Planejamento Completo do Projeto + Identidade Visual

## 📌 1. Introdução

Este documento apresenta o **planejamento completo** para o desenvolvimento do Editor de Documentos Markdown solicitado no processo seletivo, juntamente com a **identidade visual Dark Premium com acento Azul**, que será aplicada em toda a interface do projeto.

---
## 1.1 🔧 Stack
* React + Vite
* TypeScript obrigatório
* React Router
* CSS3 normal (sem Tailwind)
* Biblioteca de preview: react-markdown
* Persistência: localStorage

# 🧱 2. Planejamento do Projeto

## 2.1 Objetivo Geral

Desenvolver uma aplicação web em **React + TypeScript** que permita criar, editar, visualizar e excluir documentos Markdown, com dados armazenados no **localStorage**, seguindo princípios de componentização, organização e boas práticas.

---

## 2.2 Fases do Desenvolvimento

### **Fase 1 — Setup Inicial**

* Criar projeto com Vite + React + TypeScript.
* Configurar estrutura de pastas.
* Criar arquivo de tipagem: `Document`.
* Instalar dependências (react-markdown, react-router-dom...).
* Configurar rotas básicas:

  * `/` – lista de documentos
  * `/doc/:id` – editor

### **Fase 2 — Context API (DocumentsContext)**

* Criar contexto global para:

  * lista de documentos
  * documento selecionado
  * funções: create, update, delete, select
* Salvar documentos no localStorage
* Sincronizar alterações automaticamente

### **Fase 3 — CRUD Completo de Documentos**

* Criar lista de documentos (Home)
* Criar novo documento
* Selecionar documento
* Renomear documento
* Excluir documento
* Exibir data de última atualização

### **Fase 4 — Editor de Markdown**

* Criar página de edição
* Textarea controlado para o conteúdo
* Preview Markdown com `react-markdown`
* Layout lado a lado (Editor / Preview)
* Atualização em tempo real

### **Fase 5 — Toolbar de Estilização**

* Criar toolbar com botões de formatação:

  * **Negrito**
  * *Itálico*
  * # Título
  * Lista
  * Código inline
* Inserção da formatação baseada na posição do cursor
* Feedback visual dos botões

### **Fase 6 — Funcionalidades Extras (Opcional)**

* Autosave com debounce
* Tema claro/escuro (Dark será padrão)
* Atalhos de teclado (Ctrl+B, Ctrl+I...)
* Renomear direto na lista
* Acessibilidade básica

### **Fase 7 — Finalização**

* Revisar código
* Criar README completo
* Subir para GitHub
* Enviar link do repositório

---

# 🎨 3. Identidade Visual Dark Premium + Azul

## 3.1 Conceito Visual

A identidade visual será baseada em:

* **Estilo Dark Premium** moderno
* Acento **Azul Tech** para destacar elementos
* Estética minimalista e elegante inspirada em:

  * Linear
  * Obsidian
  * Raycast
* Interface limpa e profissional

---

## 3.2 Paleta de Cores

### **Base (Dark)**

* Fundo principal: `#0D0D0D`
* Fundo secundário: `#111111`
* Cards: `#181818`
* Bordas: `#242424`
* Texto primário: `#F1F1F1`
* Texto secundário: `#A1A1A1`

### **Acento Azul (Tech)**

* Azul primário: `#3B82F6`
* Azul hover: `#2563EB`
* Azul claro: `#60A5FA`
* Azul translúcido: `rgba(59, 130, 246, 0.15)`

### **Sombras**

* `0 0 15px rgba(0, 0, 0, 0.35)`

---

## 3.3 Tipografia

### **Interface (UI)**

* **Manrope** (principal)
* Alternativa: Inter

### **Editor Markdown**

* **JetBrains Mono** (principal)
* Alternativas: Fira Code, Cascadia Code

---

## 3.4 Layout da Interface

### **Estrutura geral**

* Sidebar à esquerda (documentos)
* Área principal dividida em duas colunas:

  * **Editor** (esquerda)
  * **Preview** (direita)

### **Sidebar**

* Fundo: `#0F0F0F`
* Documentos listados com hover suave
* Documento selecionado:

  * Fundo translúcido azul
  * Borda azul à esquerda

### **Editor**

* Textarea fullscreen
* Fundo: `#111111`
* Fonte monoespaçada estilosa

### **Preview**

* Fundo: `#181818`
* Espaçamento amplo
* Estilo elegante para títulos, listas e código

---

## 3.5 Toolbar de Formatação

**Estilo dos botões:**

* Fundo: `#1A1A1A`
* Borda: `1px solid #242424`
* Ícones com opacidade 75%
* Hover:

  * Fundo `#222222`
  * Borda azul
* Ativo:

  * Fundo azul translúcido
  * Ícone branco

---

## 3.6 Microinterações

* Fade no preview
* Hover com leve zoom (2%)
* Borda azul sutil em elementos focados
* Animação suave ao criar documento

---

## 3.7 CSS Base do Tema

```css
:root {
  --bg-main: #0D0D0D;
  --bg-secondary: #111111;
  --bg-card: #181818;
  --border: #242424;

  --text-primary: #F1F1F1;
  --text-secondary: #A1A1A1;

  --accent: #3B82F6;
  --accent-hover: #2563EB;
  --accent-light: #60A5FA;
  --accent-transparent: rgba(59, 130, 246, 0.15);

  --radius: 6px;
  --shadow: 0 0 15px rgba(0, 0, 0, 0.35);
}

body {
  background: var(--bg-main);
  color: var(--text-primary);
  font-family: 'Manrope', sans-serif;
}
```

---

# ✔️ 4. Conclusão

Este documento estabelece um **plano de desenvolvimento claro e organizado**, junto a uma **identidade visual moderna, elegante e profissional**, garantindo que o projeto final tenha qualidade técnica e estética acima do esperado no processo seletivo.
