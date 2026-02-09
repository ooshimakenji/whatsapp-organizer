# WhatsApp Organizer

Organiza fotos e vídeos do WhatsApp em pastas baseado nas legendas numéricas.

## Instalação

```bash
npm install
```

## Uso

### 1. Prepare os arquivos

Exporte a conversa do WhatsApp com mídia e extraia o ZIP na pasta `input/`:

```
whatsapp-organizer/
└── input/
    ├── _chat.txt (ou qualquer .txt)
    ├── IMG-20251205-WA0104.jpg
    ├── IMG-20251205-WA0105.jpg
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

## Lógica de Organização

### Legenda Numérica (forte)
Se uma sequência de fotos tem uma legenda que é só números (ex: `2025171359`), todas vão para uma pasta com esse nome.

### Legenda Texto (fraca)
Se não tem legenda numérica mas tem um texto, o arquivo vai para `sem_legenda/Autor/` com o texto no nome do arquivo.

### Sem Legenda
Arquivos sem nenhuma legenda vão para `sem_legenda/Autor/` apenas com timestamp.

### Blocos
Um bloco é definido por:
- Mesmo autor
- Intervalo máximo de 2 minutos entre mídias

## Alertas

O script gera um relatório em `logs/` com alertas para:

- ⚠️ **Mídia oculta**: arquivos não baixados
- 📁 **Pasta unida**: mesmo número de serviço apareceu mais de uma vez
- ⚠️ **Múltiplas legendas**: bloco com mais de uma legenda numérica
- ℹ️ **Texto ignorado**: texto descartado em bloco com legenda numérica
- ❌ **Arquivo não encontrado**: mídia mencionada mas não existe

## Configuração

Edite as constantes no início de `index.js`:

```javascript
const CONFIG = {
  inputDir: 'input',
  outputDir: 'output', 
  logsDir: 'logs',
  toleranciaMinutos: 2,        // intervalo máximo entre mídias do mesmo bloco
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
};
```
