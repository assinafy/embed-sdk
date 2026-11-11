# Creates a fresh live fixture: registers the localhost origin (idempotent), uploads a one-page
# test PDF, creates an example.com signer and a virtual assignment with one embedded Bypass signer.
# Needs ASSINAFY_API_KEY and ASSINAFY_ACCOUNT_ID (optional ASSINAFY_BASE_URL). Never prints the API key.
# Usage: python3 -I live-test/setup.py
import json, os, ssl, sys, time, uuid, urllib.request, urllib.error
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")

KEY, ACC = os.environ["ASSINAFY_API_KEY"], os.environ["ASSINAFY_ACCOUNT_ID"]
BASE = os.environ.get("ASSINAFY_BASE_URL", "https://api.assinafy.com.br/v1")
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
ORIGIN = "http://localhost:5174"


def call(method, path, body=None, ctype="application/json"):
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"X-Api-Key": KEY, "Accept": "application/json", "User-Agent": "embed-sdk-live-test/0.1"})
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def must(label, res, ok=(200, 201)):
    status, body = res
    print(f"{label}: HTTP {status}", "" if status in ok else json.dumps(body)[:400])
    if status not in ok:
        sys.exit(1)
    return body.get("data")


def tiny_pdf():
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"]
    text = b"BT /F1 18 Tf 72 760 Td (Embed SDK live test - safe to delete) Tj ET"
    objs.append(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % x for x in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)


state = {"origin": ORIGIN}

# 1. Register the test origin (idempotent).
origins = must("list origins", call("GET", f"/accounts/{ACC}/embed-origins"))
existing = next((o for o in origins if o["origin"] == ORIGIN), None)
state["origin_id"] = existing["id"] if existing else must("add origin", call("POST", f"/accounts/{ACC}/embed-origins", {"origin": ORIGIN}))["id"]

# 2. Upload a one-page PDF.
boundary = uuid.uuid4().hex
body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"embed-sdk-live-test.pdf\"\r\n"
        f"Content-Type: application/pdf\r\n\r\n").encode() + tiny_pdf() + f"\r\n--{boundary}--\r\n".encode()
state["document_id"] = must("upload document", call("POST", f"/accounts/{ACC}/documents", body, f"multipart/form-data; boundary={boundary}"))["id"]

# 3. Signer on a non-deliverable address (RFC 2606).
state["signer_id"] = must("create signer", call("POST", f"/accounts/{ACC}/signers",
                          {"full_name": "Embed SDK Test", "email": f"embed-sdk-test+{int(time.time())}@example.com"}))["id"]

# 4. Wait for processing, then a virtual assignment with one embedded Bypass signer.
for _ in range(30):
    doc = must("document status", call("GET", f"/documents/{state['document_id']}"))
    if doc.get("status") == "metadata_ready":
        break
    time.sleep(2)
assignment = must("create assignment", call("POST", f"/documents/{state['document_id']}/assignments",
                  {"method": "virtual", "signers": [{"id": state["signer_id"], "verification_method": "Bypass", "embedded": True}]}))
state["assignment_id"] = assignment["id"]
print("signing_urls:", json.dumps(assignment.get("signing_urls")))

json.dump(state, open(STATE, "w"), indent=1)
print("state:", json.dumps(state))
