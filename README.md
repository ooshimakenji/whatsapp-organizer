# WhatsApp Organizer

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?logo=javascript&logoColor=black) ![Licença](https://img.shields.io/badge/licença-MIT-green)

Organiza fotos e vídeos de conversas exportadas do WhatsApp em pastas separadas, conforme as legendas numéricas enviadas pelos colaboradores.

## Instalação

```bash
git clone https://github.com/ooshimakenji/whatsapp-organizer.git
cd whatsapp-organizer
npm install
```

## Uso

### 1. Prepare os arquivos

Exporte a conversa do WhatsApp com mídia e extraia o ZIP na pasta `input/`:

```
whatsapp-organizer/
└── input/
    ├── _chat.txt
    ├── IMG-20251205-WA0104.jpg
    ├── VID-20251205-WA0139.mp4
    └── ...
```

### 2. Execute

```bash
npm start
```

### 3. Resultado

Os arquivos serão organizados em `output/fotos-organizadas-[timestamp]/`:

```
output/
└── fotos-organizadas-2024-12-05_14-30/
    ├── 2025171359/
    │   ├── 2024-12-01_10-11_Santos_IMG-001.jpg
    │   └── 2024-12-01_10-11_Santos_IMG-002.jpg
    ├── 2025171440/
    │   └── ...
    └── sem_legenda/
        ├── Santos/
        │   └── 2024-12-01_10-05_IMG-001.jpg
        └── 55-47-9718-3289/
            └── 2024-12-05_16-04_IMG-050.jpg
```

## Lógica de organização

### Legenda numérica (forte)
Se uma sequência de fotos tem legenda composta apenas por números (ex: `2025171359`), todos os arquivos vão para uma pasta com esse nome.

### Legenda de texto (fraca)
Se não há legenda numérica mas existe um texto, o arquivo vai para `sem_legenda/Autor/` com o texto no nome.

### Sem legenda
Arquivos sem nenhuma legenda vão para `sem_legenda/Autor/` com apenas o timestamp.

### Blocos
Um bloco é definido por:
- Mesmo autor
- Intervalo máximo de 2 minutos entre mídias consecutivas

## Alertas gerados

O script gera um relatório em `logs/` com os seguintes alertas:

| Símbolo | Alerta |
|---|---|
| ⚠️ | **Mídia oculta** — arquivo não baixado |
| 📁 | **Pasta unida** — mesmo número de serviço apareceu mais de uma vez |
| ⚠️ | **Múltiplas legendas** — bloco com mais de uma legenda numérica |
| ℹ️ | **Texto ignorado** — texto descartado em bloco com legenda numérica |
| ❌ | **Arquivo não encontrado** — mídia mencionada mas inexistente |

## Configuração

Edite as constantes no início de `index.js`:

```javascript
const CONFIG = {
  inputDir: 'input',
  outputDir: 'output',
  logsDir: 'logs',
  toleranciaMinutos: 2,
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
};
```

## Licença

MIT


## Contribuindo / Contributing

Contribuições são bem-vindas! Abra uma issue ou envie um pull request.  
Contributions are welcome! Feel free to open an issue or submit a pull request.
