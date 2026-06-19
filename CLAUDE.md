# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Sobre o Projeto

WhatsApp Organizer - scripts Node.js para organizar mídias exportadas do WhatsApp em pastas baseadas nas legendas numéricas das mensagens.

## Comandos

```bash
# Diagnóstico das órfãs (não copia nada) — entender por que fotos ficam sem pasta
node analisar-orfas.js

# Executar o organizador principal (tolerância 2 minutos)
npm start
node whatsapp-organizer.js --dry-run  # simula sem copiar
node whatsapp-organizer.js --herdar    # (opcional) foto sem legenda herda protocolo do vizinho

# Executar o organizador por ENDEREÇO (grupos que legendam com rua+número, não protocolo)
node whatsapp-organizer-endereco.js --dry-run   # simula
node whatsapp-organizer-endereco.js             # executa em PASTAS (herança por vizinho mais próximo, 25 min)
node whatsapp-organizer-endereco.js --lista     # PASTÃO: 1 pasta, renomeia "seq - endereço - data" na ordem de envio

# Executar o organizador BATEDOR (sem limite de tempo, agrupa por OS)
node whatsapp-organizer-batedor.js --dry-run  # simula sem copiar
node whatsapp-organizer-batedor.js            # executa

# Executar o feedbacker (organiza por colaborador)
node whatsapp-feedbacker.js --dry-run  # simula sem copiar
node whatsapp-feedbacker.js            # executa

# Listar pastas e gerar CSV
node listar-pastas.js <diretorio> [arquivo_saida.csv]

# Extrair thumbnails de vídeos MP4
node extractThumbnails.js

# Buscar e remover fotos duplicadas
node busca-duplicatas.js "C:\caminho\para\pasta"              # apenas visualização
node busca-duplicatas.js "C:\caminho\para\pasta" --deletar    # executa deleções
```

## Arquitetura

### Fluxo Principal (`whatsapp-organizer.js`)

1. **Parser**: Lê arquivo `.txt` exportado do WhatsApp e extrai mensagens com regex
2. **Agrupamento**: Agrupa mídias em blocos por autor e intervalo de tempo (tolerância de 2 minutos)
3. **Classificação**: Determina pasta de destino baseado em legendas numéricas
4. **Cópia**: Copia arquivos renomeados para estrutura organizada
5. **Log**: Gera relatório em `logs/` com alertas

### Fluxo Batedor (`whatsapp-organizer-batedor.js`)

Variação para colaboradores "batedores" que enviam com intervalos maiores de tempo.

1. **Parser**: Mesmo parser do organizador principal
2. **Agrupamento**:
   - Linha vazia do autor = separador de bloco
   - Sem limite de tempo entre mensagens
   - Mesma OS (número 10 dígitos tipo `2025XXXXXX`) agrupa automaticamente
3. **Alertas**: Gera alerta quando intervalo > 30 minutos (para revisão manual)
4. **Cópia**: Arquivos vão para `output/batedor-{timestamp}/{OS}/`
5. **Log**: Relatório separado por tipo de alerta (intervalo grande, sem OS, outros)

### Fluxo Feedbacker (`whatsapp-feedbacker.js`)

Organiza mídias por colaborador para feedback individual.

1. **Parser**: Mesmo parser do organizador principal
2. **Agrupamento**: Por autor + protocolo
3. **Estrutura**: `output-feedback/{colaborador}/{protocolo}/`
4. **Log**: Resumo por colaborador com quantidade de fotos e protocolos

### Fluxo Endereço (`whatsapp-organizer-endereco.js`)

Para grupos que legendam com **endereço** (rua + número) em vez de protocolo numérico (ex.: grupo "Kazan asfalto").

1. **Parser/Agrupamento**: reusa `parseChat` e `agruparBlocos` (importados de `whatsapp-organizer.js`); o endereço fica em `bloco.textos`
2. **Endereço próprio + dedup**: `enderecoDoBloco()` pega a 1ª legenda que não seja nota; `enderecoKey()` normaliza (sem acento, sem prefixo de via "Rua/Av/...") para juntar variações de escrita num nome canônico
3. **Herança por vizinho mais próximo**: foto sem endereço próprio (inclusive as com nota tipo "Material pra recolher") herda o endereço da âncora captionada MAIS PRÓXIMA no tempo, do mesmo autor, dentro de `--janela-heranca` (padrão 25 min)
4. **Estrutura**: `output/enderecos-{timestamp}/{endereço}/` e `sem_legenda/{time}/` para o resto
5. **`--lista` (pastão)**: tudo em `output/lista-{timestamp}/`, renomeado `{seq} - {endereço} - {data}.ext` na ordem de envio; sem endereço vira `NNNN - SEM ENDERECO - ...`

### Estrutura de Pastas

- `input/` - Colocar o chat exportado (.txt) e as mídias
- `output/` - Pastas organizadas com timestamp
- `logs/` - Relatórios de execução
- `backup/` - Versões antigas dos scripts

### Lógica de Organização

- **Protocolo válido único**: arquivos vão para `output/{protocolo}/`
- **Múltiplos protocolos válidos**: vão para `sem_legenda/{autor}/{prot1_prot2}/` com subpastas criadas
- **Protocolo inválido**: vão para `sem_legenda/{autor}/{legenda_errada}/`
- **Múltiplos protocolos inválidos**: vão para `sem_legenda/{autor}/{leg1_leg2}/`
- **Sem legenda nenhuma**: vão para `sem_legenda/{autor}/`
- **Mix válido + inválido**: usa o válido, ignora o inválido

Essa lógica se aplica aos três scripts (organizer, batedor e feedbacker).

### Validação de Protocolo

Protocolo válido deve ter exatamente **10 dígitos** começando com um ano `20XX` (>= `anoMinimoProtocolo`,
padrão 2025). É reconhecido em **qualquer posição** da legenda e tolera separadores (espaço/ponto/traço):
- Válido: `2026010728` / `OS 2026010728 concluída` / `2026-010728` (todos resultam em `2026010728`)
- Válido: `2027010728` (anos futuros aceitos; antes era fixo em 2025/2026)
- Inválido: `202` (enviado para `sem_legenda/{autor}/202/`)
- Inválido: `6010728` (enviado para `sem_legenda/{autor}/6010728/`)

Protocolos inválidos geram alerta no log: `🔢 Protocolo "XXX" inválido`

**Anexos** são reconhecidos nos formatos Android (`(arquivo anexado)` / `(file attached)`) e iOS
(`<anexado: ...>`), e as extensões vêm de `CONFIG.extensoesValidas`. O cabeçalho de mensagem aceita ano de
2 ou 4 dígitos, segundos e AM/PM. Blocos da mesma OS separados no tempo são unidos (reduz órfãs).

### Nomenclatura das Pastas de Output

As pastas são nomeadas com a **data/hora da última mensagem do chat** (não da execução):
- `output/fotos-2026-01-22_18-53/` (organizer)
- `output/batedor-2026-01-22_18-53/` (batedor)
- `output-feedback/feedback-2026-01-22_18-53/` (feedbacker)

### Scripts Auxiliares

- `analisar-orfas.js` - Diagnóstico READ-ONLY: classifica as fotos órfãs por causa (sem legenda / protocolo
  inválido / múltiplos) e mostra quantas a melhoria recuperou. Reusa funções exportadas de `whatsapp-organizer.js`
- `extractThumbnails.js` - Extrai frames de vídeos MP4 usando FFmpeg quando pasta tem menos de 3 JPGs
- `listar-pastas.js` - Gera CSV com nomes de subpastas de um diretório
- `busca-duplicatas.js` - Detecta e remove fotos duplicadas por hash MD5

## Dependências Externas

- `whatsapp-chat-parser` - Parser de chat do WhatsApp
- `fluent-ffmpeg` - Wrapper para FFmpeg (requer FFmpeg instalado no sistema)
