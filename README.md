# WhatsApp Organizer

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?logo=javascript&logoColor=black) ![Licença](https://img.shields.io/badge/licença-MIT-green)

Conjunto de scripts Node.js para organizar mídias exportadas do WhatsApp em pastas baseadas em protocolos (OS) numéricos nas legendas.

## Requisitos

- Node.js 18+
- FFmpeg instalado no sistema (apenas para `extractThumbnails.js`)

## Instalação

```bash
git clone https://github.com/ooshimakenji/whatsapp-organizer.git
cd whatsapp-organizer
npm install
```

## Scripts

### `whatsapp-organizer.js` — Organizador principal

Agrupa mídias por bloco (mesmo autor + intervalo máximo de 2 minutos) e distribui nas pastas conforme o protocolo da legenda.

```bash
npm start                             # executa
node whatsapp-organizer.js --dry-run  # simula sem copiar arquivos
```

### `whatsapp-organizer-batedor.js` — Para colaboradores "batedores"

Variação sem limite de tempo entre mensagens. Uma linha vazia do autor define o fim de um bloco. Indicado para quem envia fotos com intervalos maiores.

```bash
node whatsapp-organizer-batedor.js --dry-run  # simula
node whatsapp-organizer-batedor.js            # executa
```

Output: `output/batedor-YYYY-MM-DD_HH-MM/`

### `whatsapp-feedbacker.js` — Organização por colaborador

Separa as mídias por colaborador para facilitar o feedback individual.

```bash
node whatsapp-feedbacker.js --dry-run  # simula
node whatsapp-feedbacker.js            # executa
```

Output: `output-feedback/feedback-YYYY-MM-DD_HH-MM/{colaborador}/{protocolo}/`

### `listar-pastas.js` — Gera CSV de subpastas

```bash
node listar-pastas.js <diretorio> [arquivo_saida.csv]
```

### `extractThumbnails.js` — Extrai frames de vídeos MP4

Extrai o primeiro frame de vídeos em pastas com menos de 3 JPGs. Requer FFmpeg instalado no sistema.

```bash
node extractThumbnails.js
```

### `busca-duplicatas.js` — Localiza e remove fotos duplicadas por hash MD5

```bash
node busca-duplicatas.js "C:\caminho\para\pasta"            # apenas visualização
node busca-duplicatas.js "C:\caminho\para\pasta" --deletar  # executa as deleções
```

---

## Uso do Organizador Principal

### 1. Prepare os arquivos

Exporte a conversa do WhatsApp com mídia e extraia o ZIP na pasta `input/`:

```
whatsapp-organizer/
└── input/
    ├── _chat.txt
    ├── IMG-20251205-WA0104.jpg
    ├── IMG-20251205-WA0105.jpg
    └── VID-20251205-WA0139.mp4
```

### 2. Execute

```bash
npm start
```

### 3. Resultado

Os arquivos serão organizados em `output/fotos-YYYY-MM-DD_HH-MM/`:

```
output/
└── fotos-2026-01-22_18-53/
    ├── 2026010728/
    │   ├── 2026-01-07_10-11_Santos_IMG-001.jpg
    │   └── 2026-01-07_10-11_Santos_IMG-002.jpg
    ├── 2026010745/
    │   └── ...
    └── sem_legenda/
        ├── Santos/
        │   └── 2026-01-07_10-05_IMG-001.jpg
        └── 55-47-9718-3289/
            └── 2026-01-22_16-04_IMG-050.jpg
```

---

## Lógica de Organização

### Protocolo válido

Deve ter exatamente **10 dígitos** iniciando com `2025` ou `2026`:

| Legenda | Resultado |
|---------|-----------|
| `2026010728` | `output/2026010728/` |
| `202` | `sem_legenda/{autor}/202/` |
| `6010728` | `sem_legenda/{autor}/6010728/` |

### Regras por tipo de legenda

| Situação | Destino |
|----------|---------|
| Protocolo válido único | `output/{protocolo}/` |
| Múltiplos protocolos válidos | `sem_legenda/{autor}/{prot1_prot2}/` com subpastas |
| Legenda inválida | `sem_legenda/{autor}/{legenda}/` |
| Sem legenda | `sem_legenda/{autor}/` |
| Mix válido + inválido | Usa o válido, descarta o inválido |

### Blocos (organizador principal)

Um bloco é definido por:
- Mesmo autor
- Intervalo máximo de 2 minutos entre mídias consecutivas

---

## Alertas no Log

O script gera um relatório em `logs/` com os seguintes alertas:

| Símbolo | Alerta |
|---------|--------|
| ⚠️ | **Mídia oculta** — arquivo não baixado |
| 📁 | **Pasta unida** — mesmo protocolo apareceu mais de uma vez |
| ⚠️ | **Múltiplas legendas** — bloco com mais de uma legenda numérica |
| ℹ️ | **Texto ignorado** — texto descartado em bloco com protocolo válido |
| ❌ | **Arquivo não encontrado** — mídia mencionada, mas inexistente |
| 🔢 | **Protocolo inválido** — legenda numérica fora do formato esperado |

---

## Configuração

Edite as constantes no início de `whatsapp-organizer.js`:

```javascript
const CONFIG = {
  inputDir: 'input',
  outputDir: 'output',
  logsDir: 'logs',
  toleranciaMinutos: 2,      // intervalo máximo entre mídias do mesmo bloco
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
  concorrencia: 10,          // arquivos copiados em paralelo
};
```

## Licença

MIT

## Contribuindo / Contributing

Contribuições são bem-vindas! Abra uma issue ou envie um pull request.  
Contributions are welcome! Feel free to open an issue or submit a pull request.
