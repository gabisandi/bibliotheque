# Conferir o estado da Bibliothèque

Execute `npm run dev` e abra **http://127.0.0.1:5173** para inspecionar a edição piloto. A prévia editorial também está disponível em **https://bibliotheque-self-three.vercel.app/**, no projeto pessoal `gabisandi/bibliotheque` da Vercel.

## Disponível

- Estante compacta com Le Petit Prince e Arsène Lupin, volumes cinza decorativos e capas em aquarela. No celular, os livros disponíveis ficam visíveis sem rolar entre placeholders.
- A capa se desloca até a direita e abre pela lombada. Voltar do início fecha a capa na direita; o verso permanece em branco durante o movimento.
- Leitor de duas páginas no computador e uma no celular.
- Francês com tradução em português, fonte, espaçamento, tema e tradução ajustáveis.
- Passar o mouse destaca a correspondência no outro idioma. Clicar, tocar ou ativar pelo teclado abre a consulta; o glossário combina palavras e expressões de contexto.
- Player compacto no celular, sem repetir o título. O relógio real do áudio conduz os destaques e pausa durante a virada, com dois segundos adicionais antes de retomar. Pausar manualmente cancela a retomada.
- Sons de papel independentes da narração, preparados após interação para funcionar nas viradas automáticas do celular. O ajuste de leitura permite desativá-los.
- Progresso e preferências locais; recuperação por identificadores de trechos.
- Diário editorial e página sobre o projeto.
- Ferramentas locais de importação PDF/EPUB/TXT, tradução, glossário, vozes, síntese, validação, backup, recuperação e preparação de publicação.

## Material do piloto

O PDF fornecido tem 86 páginas e foi preservado em `editorial/le_petit_prince/`. O original francês completo e sua tradução Azure estão salvos na edição privada `editorial/le_petit_prince/edition_2/`; revisão e narração integral ainda estão pendentes. O catálogo público local contém o primeiro capítulo, com três ilustrações originais e uma capa gerada em aquarela.

A tradução inicial do Azure recebeu correções locais, incluindo “à sa portée” e “cravates”. Isso não substitui a aprovação da proprietária: os indicadores editoriais permanecem pendentes até a conferência.

O capítulo piloto tem narração Azure salva com aproximadamente 2min28s e 432 marcações de palavras. Um lote de glossário retornou incompleto e ficou registrado sem repetição automática; as equivalências do piloto foram preparadas localmente. Termos sem equivalência individual usam a tradução da frase, com essa indicação na consulta.

## Antes da publicação integral

1. Conferir a experiência do capítulo piloto e aprovar capa, tradução, elenco e áudio.
2. Revisar a extração completa, inclusive diálogos e posição de todas as ilustrações.
3. Concluir a síntese e a revisão dos capítulos restantes; o volume de até 100 mil caracteres por serviço foi autorizado pela proprietária.
4. Verificar direitos de texto, ilustrações e territórios atendidos.
5. Validar a edição completa, exportar backup e revisar a distribuição estática.

Sem analytics de visitantes, não há métricas de retenção ou aprendizagem. Os relatórios locais de volume e arquivos de geração servem à preparação editorial.

## Arsène Lupin

O EPUB fornecido é _Arsène Lupin, gentleman-cambrioleur_, de Maurice Leblanc. O rascunho privado tem prefácio e nove contos, separados pelos títulos do EPUB; a licença Gutenberg permanece no original. Uma aquarela original foi criada com cartola, bengala, luva e safira.

O catálogo oferece apenas o primeiro conto, “L’Arrestation d’Arsène Lupin”, em francês. Não houve chamadas Azure para esse livro. A interface informa que tradução e narração estão em preparação.
