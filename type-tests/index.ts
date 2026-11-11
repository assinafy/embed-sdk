import {
  create,
  type AssinafyErrorCode,
  type SigningVia,
} from "@assinafy/embed-sdk";

declare const sessionUrl: string;
const signing = create({ sessionUrl });

signing.on("ready", (payload) => {
  const documentId: string = payload.document_id;
  const signerId: string = payload.signer_id;
  void [documentId, signerId];
});

signing.on("signed", (payload) => {
  const via: SigningVia = payload.via;
  void via;
});

signing.on("declined", (payload) => {
  const via: SigningVia = payload.via;
  void via;
});

signing.on("resize", (payload) => {
  const height: number = payload.height;
  void height;
});

signing.on("error", (payload) => {
  const code: AssinafyErrorCode = payload.code;
  const message: string = payload.message;
  void [code, message];
});

// @ts-expect-error Only documented frame events are accepted.
signing.on("cancelled", () => {});

// @ts-expect-error Event payloads are event-specific.
signing.on("resize", (payload) => payload.document_id);
