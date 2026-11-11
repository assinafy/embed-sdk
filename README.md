# Assinafy Embed SDK

*Português · [Read in English](README.en.md)*

Mostre a tela de assinatura da Assinafy dentro do seu próprio app, em um iframe, sem que o signatário saia do seu produto. O SDK monta o iframe, faz a verificação de segurança com a Assinafy, ajusta a altura ao conteúdo e avisa sua página com eventos tipados quando o signatário assina, recusa ou quando algo dá errado.

## Como funciona

1. Seu **backend** pede à API da Assinafy uma URL de sessão de uso único, válida por 5 minutos.
2. Seu **frontend** recebe só essa URL e a entrega ao SDK, que exibe a assinatura em um iframe.
3. O SDK avisa sua página com eventos: `ready`, `signed`, `declined` e `error`.
4. Seu **backend** confirma o resultado por webhook antes de liberar qualquer coisa.

A chave de API nunca vai para o navegador.

## Antes de começar

- Seu plano precisa incluir o recurso **Embed**. Sem ele, as chamadas abaixo respondem `403` com o código `PlanRestricted`. Fale com o seu gerente de conta para habilitá-lo.
- Você vai precisar de uma **chave de API** da Assinafy, usada só no backend.
- A referência completa da API está no [guia de assinatura incorporada](https://api.assinafy.com.br/v1/docs#tag/embedded-signing-guide).

## Passo 1: registre as origens do seu site

Faça isso uma vez para cada origem. A Assinafy só exibe a assinatura dentro de páginas cuja origem esteja registrada:

```bash
curl -X POST "https://api.assinafy.com.br/v1/accounts/{accountId}/embed-origins" \
  -H "X-Api-Key: $ASSINAFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin": "https://app.suaempresa.com.br"}'
```

- A origem é exatamente `https://host[:porta]`, sem caminho, query ou curinga. `http` só é aceito para `localhost` e `127.0.0.1`, para o desenvolvimento local.
- São até 10 origens por conta. Use `GET` no mesmo caminho para listá-las, e `PUT` ou `DELETE` em `/embed-origins/{originId}` para alterá-las ou removê-las.

## Passo 2: marque o signatário como incorporado

Ao criar a atribuição (assignment) do documento, marque com `"embedded": true` cada signatário que vai assinar dentro do seu app:

```json
{
  "method": "virtual",
  "signers": [
    {
      "id": "{signerId}",
      "verification_method": "Email",
      "notification_methods": ["Email"],
      "embedded": true
    }
  ]
}
```

- Signatários incorporados usam a verificação `Email` ou `Whatsapp`. Eles recebem o convite normal, com o código de 6 dígitos que digitam dentro do iframe.
- O convite também funciona sozinho: se o signatário concluir por ele, fora do seu app, um iframe aberto recebe `signed` com `via: "external"`.
- Em `signing_urls`, um signatário incorporado aparece com `"url": null`. O link dele é sempre gerado no passo 3.

## Passo 3: gere uma sessão no backend a cada exibição

Sempre que o signatário chegar à etapa de assinatura no seu app, seu backend gera uma nova URL de sessão e devolve **só a URL** ao navegador:

```ts
// Backend (Node.js 18+). A chave de API fica só aqui.
export async function criarSessaoDeAssinatura(documentId: string, assignmentId: string, signerId: string) {
  const response = await fetch(
    `https://api.assinafy.com.br/v1/documents/${documentId}/assignments/${assignmentId}/signers/${signerId}/embed-sessions`,
    { method: "POST", headers: { "X-Api-Key": process.env.ASSINAFY_API_KEY! } },
  );
  if (!response.ok) throw new Error(`A Assinafy respondeu ${response.status}`);
  const { data } = await response.json();
  return data.url as string; // de uso único, válida por 5 minutos (data.expires_at)
}
```

Exponha essa função por uma rota autenticada do seu app, por exemplo `POST /api/signing-session`. Antes de gerar a sessão, confirme que o usuário logado é mesmo esse signatário.

- Cada URL funciona **uma única vez** e expira em **5 minutos**. Gere uma nova sempre que exibir o iframe, inclusive depois de recarregar a página. Nunca a guarde nem a reutilize.
- O limite é de 30 sessões por signatário por hora.

Se a API recusar:

| Status | Código | O que fazer |
|---|---|---|
| `400` | `embed_not_enabled_for_signer` | Marque o signatário com `"embedded": true` (passo 2) |
| `403` | `PlanRestricted` | Peça a habilitação do recurso Embed |
| `404` | | Confira os IDs do documento, da atribuição e do signatário |
| `409` | `already_signed` | O signatário já assinou: mostre o estado final |
| `409` | `document_not_ready` | O documento ainda está sendo processado: tente de novo em alguns segundos |
| `409` | `document_unavailable` | O documento não pode mais ser assinado, ou ainda não é a vez desse signatário (assinatura sequencial) |
| `409` | `embed_origins_missing` | Registre uma origem (passo 1) |
| `429` | | Sessões demais para esse signatário: aguarde antes de tentar de novo |

## Passo 4: exiba a assinatura no navegador

```bash
npm install @assinafy/embed-sdk
```

```ts
import { create } from "@assinafy/embed-sdk";

// Peça ao SEU backend uma URL nova (passo 3).
const { url } = await fetch("/api/signing-session", { method: "POST" }).then((r) => r.json());

const signing = create({ sessionUrl: url });

signing.on("ready", () => {
  // O iframe verificou sua origem e está exibindo a assinatura.
});
signing.on("signed", ({ document_id }) => {
  signing.destroy();
  mostrarSucesso(document_id); // confirme no backend antes de liberar algo (passo 5)
});
signing.on("declined", () => {
  signing.destroy();
  mostrarRecusa();
});
signing.on("error", ({ code, message }) => {
  signing.destroy();
  tratarErro(code, message); // veja "Erros e o que fazer"
});

signing.mount("#assinatura"); // seletor CSS ou elemento HTML
```

O SDK cria dentro do elemento um iframe com 100% de largura, que começa com 600 px de altura e acompanha a altura do conteúdo (mínimo de 200 px). Chame `destroy()` quando o fluxo terminar ou quando o usuário sair da tela: ele remove o iframe, os listeners e os timers.

## Passo 5: confirme o resultado no backend

Os eventos do navegador são sinais para a interface. O signatário pode fechar a aba, perder a conexão ou concluir pelo convite. Antes de liberar qualquer coisa no seu sistema, confirme o status pelos webhooks da Assinafy ou consultando o documento pela API.

## Eventos

| Evento | Payload | Quando |
|---|---|---|
| `ready` | `{ document_id, signer_id }` | O iframe verificou sua origem e está exibindo a tela de código ou de assinatura. Dispara de novo se o iframe recarregar |
| `signed` | `{ document_id, signer_id, via }` | O signatário assinou. `via` é `"embed"` (no iframe) ou `"external"` (por outro canal, como o convite) |
| `declined` | `{ document_id, signer_id, via }` | O signatário recusou, ou outra pessoa recusou o documento |
| `resize` | `{ height }` | A altura do conteúdo mudou. O SDK já ajusta o iframe |
| `error` | `{ code, message }` | Algo impediu a assinatura. Veja abaixo |

`signed` e `declined` chegam uma única vez por documento, mesmo que o iframe os reenvie depois de recarregar.

## Erros e o que fazer

Erros são finais: chame `destroy()` e, se fizer sentido, comece de novo com uma nova sessão.

| `code` | Significado | O que fazer |
|---|---|---|
| `session_expired` | A URL expirou ou já foi usada, ou o e-mail ou telefone do signatário mudou | Gere uma nova sessão (passo 3) e crie uma nova instância |
| `origin_not_allowed` | A origem da página não está registrada | Registre a origem exata, com a porta, se houver (passo 1) |
| `already_signed` | O signatário já assinou | Mostre o estado final |
| `document_unavailable` | O documento foi cancelado, recusado ou expirou, ou ainda não está pronto | Consulte o documento no backend |
| `not_embedded` | O signatário não está marcado como incorporado | Ajuste a atribuição (passo 2) |
| `access_closed` | O acesso do signatário foi encerrado | Consulte o documento no backend |
| `handshake_timeout` | O iframe não respondeu em 12,5 segundos (emitido pelo SDK) | Verifique a conexão e se algo bloqueia o iframe, e tente de novo com uma nova sessão |

Use `code` para decidir o que fazer. `message` é um texto descritivo e pode vir vazio. Novos códigos podem surgir: trate os desconhecidos como um erro genérico.

## React e Next.js

Gere a sessão dentro do efeito, para que cada montagem use uma URL nova:

```tsx
"use client"; // Next.js App Router

import { useEffect, useRef } from "react";
import { create, type Signing } from "@assinafy/embed-sdk";

export function Assinatura({ onSigned }: { onSigned: (documentId: string) => void }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let signing: Signing | undefined;
    let ativo = true;

    fetch("/api/signing-session", { method: "POST" })
      .then((r) => r.json())
      .then(({ url }) => {
        if (!ativo || !container.current) return;
        signing = create({ sessionUrl: url });
        signing.on("signed", ({ document_id }) => onSigned(document_id));
        signing.on("error", ({ code }) => console.warn("Assinafy:", code));
        signing.mount(container.current);
      });

    return () => {
      ativo = false;
      signing?.destroy();
    };
  }, []);

  return <div ref={container} />;
}
```

Em outros frameworks o padrão é o mesmo: crie e monte no hook de montagem e chame `destroy()` na limpeza. No Vue, use `onMounted` e `onUnmounted`; no Angular, `ngAfterViewInit` e `ngOnDestroy`; no Svelte, `onMount` (retornando a limpeza).

## HTML puro (CDN)

```html
<div id="assinatura"></div>
<script
  src="https://cdn.jsdelivr.net/npm/@assinafy/embed-sdk@1.0.1/dist/index.global.js"
  integrity="sha384-lSSpERrUWuEMJPmEUUdpk4LPI2V3JvcOAYpipt/Sboxw3yDkxbD1Rk3BZxd3Rho0"
  crossorigin="anonymous"
></script>
<script>
  fetch("/api/signing-session", { method: "POST" })
    .then((r) => r.json())
    .then(({ url }) => {
      const signing = Assinafy.create({ sessionUrl: url });
      signing.on("signed", ({ document_id }) => {
        signing.destroy();
        // mostre o sucesso
      });
      signing.on("error", ({ code, message }) => {
        signing.destroy();
        // trate o erro
      });
      signing.mount("#assinatura");
    });
</script>
```

O atributo `integrity` garante que o navegador só execute exatamente o arquivo publicado.

## Apps mobile

Para React Native, Swift ou Kotlin, hospede uma página HTTPS sua com o SDK, registre a origem dela (passo 1) e abra-a em uma WebView. Nessa página, repasse ao app só o resultado já validado, pela ponte da WebView. A chave de API e a geração de sessão continuam no seu backend.

## Bom saber

- **Código de 6 dígitos:** chega no convite (e-mail ou WhatsApp), não no iframe, e o iframe não tem botão de reenvio. Para reenviar, chame do backend `PUT /v1/documents/{documentId}/assignments/{assignmentId}/signers/{signerId}/resend`. O mesmo código é reenviado, e um iframe aberto continua funcionando.
- **Mudança de e-mail ou telefone:** alterar o contato do signatário antes da verificação gera um novo código. O iframe aberto recebe `session_expired`, e você gera uma nova sessão.
- **Recarregar o iframe:** o SDK refaz a verificação sozinho, e `ready` dispara de novo.
- **Envelopes:** gere a sessão em qualquer documento do envelope que ainda aguarde o signatário. O iframe lista todos os documentos pendentes dele.
- **Ambientes:** o SDK usa a origem da própria URL de sessão, então funciona em produção e no sandbox sem configuração.
- **Segurança:** o SDK só aceita mensagens vindas do próprio iframe e da origem da Assinafy, e recusa URLs de sessão que não sejam HTTPS.

## Referência

**`create({ sessionUrl })`** retorna uma instância `Signing` para uma URL de sessão. Lança `TypeError` se a URL não for HTTPS absoluta ou se tiver credenciais.

**`signing.on(evento, handler)`** registra um handler, e você pode registrar vários por evento. Se um handler lançar um erro, os outros continuam sendo chamados, e o erro é relançado de forma assíncrona para o seu monitoramento capturá-lo.

**`signing.mount(alvo)`** insere o iframe em um seletor CSS ou `HTMLElement`, uma única vez por instância.

**`signing.destroy()`** remove o iframe, os listeners, os timers e os handlers. Pode ser chamado mais de uma vez. Uma instância destruída não pode ser reutilizada.

Tipos exportados: `Signing`, `CreateOptions`, `SigningEventName`, `SigningEventPayloads`, `AssinafyErrorCode` e `SigningVia`. O pacote traz ESM, um bundle para navegador que expõe `window.Assinafy` e as declarações TypeScript.

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE)
