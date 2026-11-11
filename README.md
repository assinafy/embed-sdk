# Assinafy Embed SDK

*Português · [Read in English](README.en.md)*

SDK de navegador, independente de framework, para a assinatura incorporada da Assinafy. Ele monta a sessão de assinatura de uso único em um iframe e expõe eventos de conclusão tipados, sem colocar chave de API nem criação de sessão no código do navegador.

O contrato de integração é o [guia de assinatura incorporada da Assinafy](https://api.assinafy.com.br/v1/docs#tag/embedded-signing-guide).

## Instalação

```bash
npm install @assinafy/embed-sdk
```

```ts
import * as Assinafy from "@assinafy/embed-sdk";

const signing = Assinafy.create({ sessionUrl });

signing.on("ready", ({ document_id }) => {
  console.log("Pronto", document_id);
});
signing.on("signed", ({ document_id, via }) => {
  console.log("Assinado", document_id, via);
  signing.destroy();
});
signing.on("declined", ({ document_id, via }) => {
  console.log("Recusado", document_id, via);
  signing.destroy();
});
signing.on("error", ({ code, message }) => {
  console.error(code, message);
});

signing.mount("#signing-container");
```

`destroy()` remove o iframe, o listener de mensagens, o timer de novas tentativas e os handlers. Chame-o quando o fluxo terminar. Cada instância atende a uma única URL de sessão. Por isso, em `session_expired` (que também pode chegar no meio da sessão, depois que o e-mail ou o telefone do signatário muda), chame `destroy()`, gere uma nova URL no seu backend e crie uma nova instância. Se o frame recarregar, `ready` dispara de novo; depois de uma recarga na tela final, o frame reenvia `signed` ou `declined`, e o SDK ignora a repetição.

O mesmo módulo funciona em React, Next.js, Vue, Angular e Svelte. Crie e monte a instância no hook de ciclo de vida do navegador do framework e chame `destroy()` na limpeza desse hook.

## CDN / HTML puro

```html
<div id="signing-container"></div>
<script
  src="https://cdn.jsdelivr.net/npm/@assinafy/embed-sdk@1.0.0/dist/index.global.js"
  integrity="sha384-lSSpERrUWuEMJPmEUUdpk4LPI2V3JvcOAYpipt/Sboxw3yDkxbD1Rk3BZxd3Rho0"
  crossorigin="anonymous"
></script>
<script>
  const signing = Assinafy.create({ sessionUrl });
  signing.on("ready", handleReady);
  signing.on("signed", handleSigned);
  signing.on("declined", handleDeclined);
  signing.on("error", handleError);
  signing.mount("#signing-container");
</script>
```

## Fronteira com o servidor

Crie a sessão de curta duração no seu backend autenticado, como descreve o guia de assinatura incorporada, e devolva ao navegador apenas a URL dela. Cada URL funciona uma única vez e expira em 5 minutos, então gere uma nova sempre que exibir o frame. Antes, registre cada origem de página pai, como descreve o passo 1 do guia (`http` só funciona para `localhost` e `127.0.0.1`). Nunca exponha uma chave de API da Assinafy neste SDK, em variáveis de ambiente do cliente, em HTML, em analytics ou em logs.

O SDK:

- aceita URLs de sessão HTTPS absolutas, sem credenciais na URL, incluindo os hosts de stage, sandbox e produção;
- aceita mensagens apenas dessa origem e da janela do seu próprio iframe;
- executa o handshake `assinafy:hello` documentado, parando na primeira mensagem válida do frame;
- acompanha automaticamente as mensagens `resize`, com o mínimo documentado de 200 px;
- emite payloads tipados de `ready`, `signed`, `declined`, `resize` e `error`;
- entrega cada `signed` e `declined` uma vez por documento, ignorando repetições;
- continua chamando todos os handlers quando um deles lança uma exceção ou chama `destroy()`, e relança o erro de forma assíncrona para que o seu monitoramento de erros o capture.

Os códigos de erro documentados do frame são `origin_not_allowed`, `session_expired`, `not_embedded`, `document_unavailable`, `already_signed` e `access_closed`. Erros do frame são terminais. `message` é uma string vazia se o frame não a enviar. O SDK também emite `handshake_timeout` quando o frame não envia nada em até 12,5 segundos depois de carregar: 20 hellos ao longo de 10 segundos e, em seguida, um período de tolerância para que o `origin_not_allowed` do próprio frame chegue antes. Códigos futuros desconhecidos, desde que sejam strings, continuam sendo entregues, para compatibilidade com versões futuras.

Trate os eventos do navegador como sinais de interface. Confirme o status de assinado ou recusado com um webhook no backend autenticado ou com uma consulta à API antes de alterar o estado persistente da sua aplicação.

## Mobile

Carregue este SDK de navegador em uma página wrapper hospedada em HTTPS, valide os eventos nela e encaminhe apenas o resultado validado, que é pequeno, pela ponte do React Native, Swift ou Kotlin. A chave de API e a criação da sessão continuam no seu backend.

## Desenvolvimento e releases

O desenvolvimento usa a versão do Node.js definida em `.nvmrc` e a versão do npm definida em `packageManager`.

```bash
nvm use
npm ci
npx playwright install chromium
npm run verify
```

Quando o bundle do navegador muda, `npm test` falha até que o snippet de CDN dos dois READMEs tenha o novo hash `integrity`; a mensagem de falha mostra o valor a colar.

O GitHub Actions publica as releases no npm com [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, com proveniência); nenhum token do npm fica guardado em lugar algum. Para publicar uma release, defina a nova versão (`npm version <x.y.z> --no-git-tag-version`), atualize os dois snippets de CDN, faça o merge em `main` e envie a tag correspondente:

```bash
git tag -a v1.0.1 -m v1.0.1
git push origin v1.0.1
```

O `release.yml` confere se a tag corresponde ao `package.json`, roda `npm run verify`, publica no npm e cria a release no GitHub.

`live-test/` roda o SDK compilado contra o frame real da Assinafy. Ele não faz parte do `npm test` e precisa de um workspace com Embed habilitado em `ASSINAFY_API_KEY` e `ASSINAFY_ACCOUNT_ID`. `setup.py` cria um documento e um signatário de teste, `matrix.mjs` cobre o handshake e os caminhos de erro, `sign.mjs` assina de verdade e `leak.mjs` verifica as requisições de terceiros da página de embed:

```bash
npm run build
python3 -I live-test/setup.py
node live-test/matrix.mjs
node live-test/sign.mjs
node live-test/leak.mjs
```

O pacote publica:

- `dist/index.js`: ESM para npm e bundlers modernos;
- `dist/index.global.js`: IIFE de navegador exposto como `window.Assinafy`;
- `dist/index.d.ts`: declarações TypeScript;
- source maps dos dois bundles JavaScript.
