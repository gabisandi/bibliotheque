# Preparar um livro

Peça ao Codex: **“Leia este guia, importe meu livro como rascunho, prepare a tradução e um elenco de vozes e apresente uma amostra antes de gerar a edição inteira.”**

O original, a extração e os registros de geração ficam em `editorial/`, uma pasta privada excluída do Git. Use identificadores estáveis para que uma revisão não perca marcações de leitura nem cobre de novo por trechos idênticos.

## Configurar a Azure

Copie `.env.example` para `.env` apenas se o arquivo local ainda não existir. Preencha:

```dotenv
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=brazilsouth
AZURE_TRANSLATOR_KEY=
AZURE_TRANSLATOR_REGION=brazilsouth
```

Use a chave de cada recurso e sua região real. Para um Translator global, a região pode ficar vazia. Credenciais existentes no ambiente têm prioridade sobre o arquivo local. Nunca use prefixo `VITE_` nas chaves: esse prefixo torna valores públicos no navegador.

Confira as vozes, sem gerar áudio:

```bash
npm run books -- voices
```

O resultado lista as vozes francesas disponíveis, sem mostrar as chaves. `fr-FR-HenriNeural`, `fr-FR-DeniseNeural`, `fr-FR-AlainNeural` e `fr-FR-EloiseNeural` foram encontradas no recurso do piloto.

## Importar o original

```bash
npm run books -- import caminho/livro.pdf meu_livro
```

O resultado será `editorial/meu_livro/draft/manifest.json`, acompanhado do original, da extração e das imagens. EPUB sem bloqueio e TXT também são aceitos. A importação nunca substitui uma pasta existente.

Revise título, autoria, limites de capítulos, parágrafos, imagens e falas. A extração do PDF preserva evidência por página; a associação inicial das imagens é uma sugestão que exige conferência. Para texto com imagens separadas, copie os arquivos para `images/` e registre os caminhos no manifesto.

## Traduzir e revisar

```bash
npm run books -- estimate editorial/meu_livro/draft/manifest.json
```

O comando informa caracteres de narração, tradução pendente e elenco. Se `AZURE_SPEECH_PRICE_PER_MILLION` estiver configurado com o preço real da categoria escolhida, informa também uma estimativa de áudio na mesma moeda. Sem esse valor, não inventa preço.

Peça ao Codex para executar `translate` com `--execute --approve-characters N`, usando o volume mostrado e aprovado por você. Sem essas opções, o comando não faz chamadas pagas. `--chapter chapter_01` limita o processamento ao piloto.

`translate` preenche somente traduções vazias. Para retraduzir, revise e esvazie explicitamente os campos desejados; as correções existentes são preservadas.

Depois da tradução, use `glossary` com o mesmo mecanismo de aprovação. O comando prepara equivalências lexicais nos dois sentidos. Elas são auxílios de vocabulário; o Codex deve revisar expressões no contexto e acrescentar `annotations` aos trechos.

Uma anotação liga intervalos de caracteres, com início inclusivo e fim exclusivo:

```json
{
  "fr": [0, 7],
  "pt": [0, 6],
  "note": "Expressão revisada no contexto."
}
```

Os intervalos usam os textos daquele trecho. Quando não há anotação nem palavra no glossário, o leitor mostra a tradução da frase e identifica essa cobertura claramente.

## Preparar as vozes

No manifesto, `voices` relaciona personagem e voz Azure. Cada trecho usa `speaker` para selecionar sua voz. Separe a fala de um personagem da narração quando houver mudança dentro do mesmo parágrafo.

Peça ao Codex para gerar `sample` após mostrar o volume: esse comando narra os três primeiros trechos selecionados e salva um WAV com um JSON de marcações. Ele não transforma a amostra em áudio completo do capítulo.

Depois de aprovar a amostra, execute `synthesize`, sempre com `--execute --approve-characters N`. O áudio é gerado por trecho e montado por capítulo em WAV PCM mono de 24 kHz. A montagem usa a quantidade real de amostras para deslocar os tempos sem atraso de codificação.

Uma alteração no francês ou na voz invalida o áudio daquele capítulo. Os trechos idênticos são reutilizados do cache. Alterar apenas o português preserva a narração.

Se uma operação cair depois do envio, o registro fica `pending`. O comando **não tenta cobrar novamente**. Confira consumo e resultado no portal Azure; arquive o registro incerto somente depois dessa verificação e de autorizar uma nova tentativa.

## Criar a capa

Use a skill `watercolor-obj` como referência artística durante a sessão do Codex. A ilustração do piloto foi criada com a ferramenta nativa de imagem, com esta direção:

> Aquarela delicada de uma pequena criança de cabelos dourados, casaco verde-sálvia e cachecol ocre sobre um asteroide, com uma rosa sob uma redoma e poucas estrelas. Pigmentos translúcidos, bordas seletivamente suaves, detalhe 35, transparência 75, suavidade 55. Fundo marfim, espaço livre para o título, sem letras nem assinatura.

Salve a arte como `cover.png` na pasta da edição. Título e autor são compostos como texto pelo site. Preserve a capa anterior no material editorial; imagens internas não devem ser redesenhadas sem pedido específico.

## Preparar a publicação

Valide o pacote:

```bash
npm run books -- validate public/books/le_petit_prince/1/manifest.json
```

O resultado informa edição válida ou aponta o arquivo, marcação ou revisão incompatível. A validação confere os arquivos locais e rejeita áudio desatualizado.

Para uma nova edição, use uma nova pasta e atualize `edition` e seus caminhos `/books/id/edicao/…`. Marque direitos como verificados somente após conferência territorial. Os campos de revisão de tradução, vozes, ilustrações, capa e áudio só recebem `true` após aprovação editorial real.

`stage manifesto.json --preview` permite preparar uma prévia local. `stage manifesto.json` exige direitos e revisões completos, tradução e áudio em todos os capítulos. O comando copia os arquivos antes de trocar o catálogo; ele não faz deploy remoto. Uma pasta de edição existente nunca é sobrescrita.

## Guardar e recuperar uma edição

```bash
npm run books -- backup public/books/le_petit_prince/1/manifest.json backups/piloto.zip
npm run books -- restore backups/piloto.zip editorial/restaurado
```

O primeiro comando exporta manifesto e arquivos referenciados. Para incluir o original privado, acrescente seu caminho após o ZIP; esse pacote completo deve permanecer privado. O segundo comando verifica integridade e restaura em pasta nova, sem chamar Azure.

As notas do diário são editadas em `public/catalog.json`. Escreva novidades editoriais para os leitores; registros de requisições e detalhes de custo ficam privados.
