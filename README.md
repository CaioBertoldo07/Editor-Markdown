# 📝 Editor Markdown

Editor de documentos Markdown com preview em tempo real, desenvolvido com React + TypeScript para o processo seletivo do Projeto ADA.

![React](https://img.shields.io/badge/React-18.2-61DAFB?style=flat-square&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.2-3178C6?style=flat-square&logo=typescript)
![Vite](https://img.shields.io/badge/Vite-5.0-646CFF?style=flat-square&logo=vite)

## 🚀 Funcionalidades

### ✅ Obrigatórias

- **CRUD Completo de Documentos**
  - Criar novos documentos
  - Renomear documentos (clique no título)
  - Editar conteúdo em tempo real
  - Excluir documentos (com modal de confirmação)
  - Listar todos os documentos salvos

- **Editor com Preview Markdown**
  - Textarea com fonte monoespaçada
  - Preview renderizado em tempo real
  - Layout split-screen (editor/preview)
  - Suporte completo a sintaxe Markdown

- **Toolbar de Formatação**
  - 8 botões de formatação rápida
  - Inserção inteligente baseada na posição do cursor
  - Suporte para texto selecionado
  - Tooltips informativos

- **Context API**
  - Gerenciamento centralizado de estado
  - Sincronização automática com localStorage
  - Sem prop drilling

- **Roteamento**
  - `/` - Lista de documentos (Home)
  - `/doc/:id` - Editor do documento
  - Navegação suave entre páginas

### 🌟 Extras Implementadas

- **💾 Autosave com Debounce**
  - Salvamento automático após 800ms de inatividade
  - Indicador visual de status ("Salvando..." / "Salvo")
  - Timestamp da última atualização

- **🌓 Tema Claro/Escuro**
  - Alternância suave entre temas
  - Persistência da preferência no localStorage
  - Transições animadas de 300ms

- **⌨️ Atalhos de Teclado**
  - Formatação rápida via teclado
  - Tab para indentação
  - ESC para cancelar edições

- **🎨 Modal Customizado**
  - Confirmação visual de exclusão
  - Backdrop com blur
  - Animações suaves
  - Acessível (ESC para fechar)

- **📱 Responsividade Completa**
  - Layout adaptável para mobile, tablet e desktop
  - Sidebar drawer em mobile
  - Menu hambúrguer animado
  - Touch-friendly

- **✨ UI/UX Premium**
  - Identidade visual Dark Premium com acento Azul
  - Microinterações e animações suaves
  - Feedback visual em todas as ações
  - Design moderno e elegante

### 📐 Projetos LaTeX

- Criação de **documento Markdown** ou **projeto LaTeX** (o tipo não muda depois)
- Editor de código (CodeMirror 6): destaque, autocompletar de comandos, ambientes,
  `\ref`, `\cite` e arquivos; busca e substituição; erros sublinhados
- **Compilação real** em PDF (TeX Live + latexmk, BibTeX/Biber, pdfLaTeX, XeLaTeX,
  LuaLaTeX) num serviço isolado, manual ou automática
- Prévia do PDF ao lado (zoom, ajustar à largura, páginas, modo ampliado) e
  painel de problemas com mensagens em português e link para a linha
- Importação de `.tex` e de projetos `.zip`; exportação de `.tex`, `.zip` e PDF

Detalhes técnicos e implantação: [`docs/latex.md`](docs/latex.md).

| Atalho no editor LaTeX | Ação |
|--------|------|
| `Ctrl+Enter` / `Ctrl+S` | Compilar (salvando antes) |
| `Ctrl+F` | Buscar e substituir |
| `Ctrl+/` | Comentar linha |
| `Ctrl+B` / `Ctrl+I` | `\textbf{}` / `\textit{}` |
| `Ctrl+Space` | Autocompletar |

## ⌨️ Atalhos de Teclado

| Atalho | Ação |
|--------|------|
| `Ctrl+B` | **Negrito** |
| `Ctrl+I` | *Itálico* |
| `Ctrl+H` | # Título |
| `Ctrl+L` | Lista |
| `Ctrl+K` | `Código inline` |
| `Ctrl+Shift+K` | Bloco de código |
| `Ctrl+U` | Link |
| `Ctrl+Q` | Citação |
| `Tab` | Inserir indentação (2 espaços) |
| `ESC` | Cancelar edição de título |

## 🛠️ Tecnologias

### Core
- **React 18** - Biblioteca UI
- **TypeScript** - Tipagem estática
- **Vite** - Build tool e dev server

### Roteamento & Estado
- **React Router** - Navegação entre páginas
- **Context API** - Gerenciamento de estado global

### UI & Markdown
- **React Markdown** - Renderização de Markdown
- **CSS3** - Estilização com Custom Properties

### Utils
- **uuid** - Geração de IDs únicos
- **localStorage** - Persistência de dados

## 📦 Instalação e Uso

### Pré-requisitos
- Node.js 18+ 
- npm ou yarn

### Instalar Dependências
```bash
npm install
```

### Rodar em Desenvolvimento
```bash
npm run dev
```

O projeto estará disponível em `http://localhost:5173`

## 📂 Estrutura do Projeto
```
src/
├── components/
│   ├── DocumentList/      # Lista lateral de documentos
│   │   ├── DocumentList.tsx
│   │   └── DocumentList.css
│   ├── Editor/            # Editor de texto Markdown
│   │   ├── Editor.tsx
│   │   └── Editor.css
│   ├── Preview/           # Preview renderizado
│   │   ├── Preview.tsx
│   │   └── Preview.css
│   ├── Toolbar/           # Barra de formatação
│   │   ├── Toolbar.tsx
│   │   └── Toolbar.css
│   ├── ThemeToggle/       # Botão de alternância de tema
│   │   ├── ThemeToggle.tsx
│   │   └── ThemeToggle.css
│   ├── SaveIndicator/     # Indicador de salvamento
│   │   ├── SaveIndicator.tsx
│   │   └── SaveIndicator.css
│   ├── ConfirmModal/      # Modal de confirmação
│   │   ├── ConfirmModal.tsx
│   │   └── ConfirmModal.css
│   └── MobileMenu/        # Menu hambúrguer (mobile)
│       ├── MobileMenu.tsx
│       └── MobileMenu.css
├── context/
│   ├── DocumentsContext.tsx  # Estado global dos documentos
│   └── ThemeContext.tsx      # Estado global do tema
├── hooks/
│   └── useDebounce.ts        # Hook personalizado de debounce
├── pages/
│   ├── Home.tsx              # Página inicial
│   ├── Home.css
│   ├── EditorPage.tsx        # Página de edição
│   └── EditorPage.css
├── types/
│   └── document.ts           # Interfaces TypeScript
├── utils/
│   └── localStorage.ts       # Funções de persistência
├── styles/
│   └── global.css            # Estilos globais + temas
├── App.tsx                   # Componente raiz
└── main.tsx                  # Entry point
```

## 🎨 Identidade Visual

### Tema Dark (Padrão)
- **Fundo Principal**: `#0D0D0D`
- **Fundo Secundário**: `#111111`
- **Cards**: `#181818`
- **Texto**: `#F1F1F1`
- **Acento**: `#3B82F6` (Azul Tech)

### Tema Light
- **Fundo Principal**: `#FFFFFF`
- **Fundo Secundário**: `#F8F9FA`
- **Cards**: `#F1F3F5`
- **Texto**: `#1A202C`
- **Acento**: `#3B82F6` (Mantido)

### Tipografia
- **Interface**: Manrope (UI/UX)
- **Editor**: JetBrains Mono (Código)

## 📱 Responsividade

### Breakpoints
- **Mobile**: < 768px
- **Tablet**: 768px - 1024px
- **Desktop**: > 1024px

### Adaptações Mobile
- Sidebar como drawer lateral
- Menu hambúrguer animado
- Layout vertical (editor/preview empilhados)
- Botões otimizados para toque
- Fontes ajustadas para legibilidade

## ✨ Destaques Técnicos

### Arquitetura
- **Componentização clara** com responsabilidade única
- **Tipagem forte** em 100% do código
- **Context API** sem prop drilling
- **Custom Hooks** para reutilização de lógica

### Performance
- **Debounce** no autosave (800ms)
- **Lazy updates** no preview
- **CSS otimizado** com variáveis
- **Bundle otimizado** com Vite

### UX/UI
- **Feedback visual** em todas as ações
- **Animações suaves** (300ms)
- **Microinterações** elegantes
- **Acessibilidade** (focus visible, ARIA)

### Boas Práticas
- **Código limpo** e legível
- **Sem warnings** no console
- **Organização modular**
- **Separação de responsabilidades**

## 🧪 O que foi Avaliado

✅ **Qualidade do Código**
- Clareza e legibilidade
- Nomes descritivos
- Organização lógica

✅ **Domínio de React**
- Hooks (useState, useEffect, useCallback)
- Context API
- Componentização
- Controlled components

✅ **Domínio de TypeScript**
- Interfaces bem definidas
- Tipagem completa
- Type safety

✅ **Estrutura do Projeto**
- Pastas bem definidas
- Separação clara de concerns
- Arquivos pequenos e focados

✅ **Funcionalidades**
- Todas as obrigatórias implementadas
- Extras que agregam valor
- Funcionamento correto

✅ **Boas Práticas**
- Sem warnings desnecessários
- Código limpo
- Performance otimizada

## 📝 Notas de Desenvolvimento

- **Persistência**: Dados salvos no `localStorage` do navegador
- **Formato dos Documentos**: 
```typescript
  {
    id: string;        // UUID v4
    title: string;     // Título do documento
    content: string;   // Conteúdo em Markdown
    updatedAt: string; // ISO timestamp
  }
```
- **Debounce**: Configurado para 800ms no autosave
- **Preview**: Atualização em tempo real com `react-markdown`

## 🚧 Possíveis Melhorias Futuras

- Busca/filtro de documentos
- Tags e categorias
- Export para PDF/HTML
- Modo de apresentação
- Histórico de versões (undo/redo)
- Sincronização na nuvem
- Colaboração em tempo real
- Atalhos customizáveis

## 👨‍💻 Autor

**Caio Bertoldo** - Estudante de Engenharia de Computação (UEA)  
Desenvolvido como parte do processo seletivo para a bolsa de Frontend - Projeto ADA

## 📄 Licença

Este projeto foi desenvolvido para fins educacionais como parte de um processo seletivo.

---