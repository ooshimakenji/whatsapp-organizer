# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Sobre o Projeto

WhatsApp Organizer - script Node.js para organizar mídias exportadas do WhatsApp em pastas baseadas nas legendas numéricas (protocolos/OS) das mensagens.

## Comandos

```bash
# Executar o organizador (tolerância 2 minutos)
npm start
node whatsapp-organizer.js --dry-run  # simula sem copiar
node whatsapp-organizer.js --herdar    # (opcional) foto sem legenda herda protocolo do vizinho
```

## Arquitetura

### Fluxo Principal (`whatsapp-organizer.js`)

1. **Parser**: Lê arquivo `.txt` exportado do WhatsApp e extrai mensagens com regex
2. **Agrupamento**: Agrupa mídias em blocos por autor e intervalo de tempo (tolerância de 2 minutos)
3. **Classificação**: Determina pasta de destino baseado em legendas numéricas
4. **Cópia**: Copia arquivos renomeados para estrutura organizada
5. **Log**: Gera relatório em `logs/` com alertas

### Estrutura de Pastas

- `input/` - Colocar o chat exportado (.txt) e as mídias
- `output/` - Pastas organizadas com timestamp
- `logs/` - Relatórios de execução

### Lógica de Organização

- **Protocolo válido único**: arquivos vão para `output/{protocolo}/`
- **Múltiplos protocolos válidos**: vão para `sem_legenda/{autor}/{prot1_prot2}/` com subpastas criadas
- **Protocolo inválido**: vão para `sem_legenda/{autor}/{legenda_errada}/`
- **Múltiplos protocolos inválidos**: vão para `sem_legenda/{autor}/{leg1_leg2}/`
- **Sem legenda nenhuma**: vão para `sem_legenda/{autor}/`
- **Mix válido + inválido**: usa o válido, ignora o inválido

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
- `output/fotos-2026-01-22_18-53/`

## Dependências

O organizador usa apenas módulos nativos do Node.js (`fs`, `path`, `url`) — não requer pacotes externos.
