/** Conteúdo inicial de um projeto LaTeX novo: compila de primeira e mostra o básico. */
export const NEW_PROJECT_TEMPLATE = String.raw`\documentclass[12pt]{article}
\usepackage[T1]{fontenc}
\usepackage[brazil]{babel}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}

\title{Novo documento}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introdução}\label{sec:intro}
Escreva aqui. Fórmulas em linha: $E = mc^2$; em destaque:
\begin{equation}\label{eq:euler}
  e^{i\pi} + 1 = 0
\end{equation}
Veja a Equação~\eqref{eq:euler} na Seção~\ref{sec:intro}.

\end{document}
`;
