"""A client for the Duct developer API (/v1). Python 3.8+, standard library only.

    from duct_client import DuctClient
    duct = DuctClient("https://search.example.com", key=os.environ["DUCT_API_KEY"])
    duct.upsert("help", "refunds", title="Refunds", text="...", metadata={"lang": "en"})
    hits = duct.search("help", "refund", filter={"lang": "en"})["hits"]
"""

import json
import mimetypes
import uuid
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

__all__ = ["DuctClient", "DuctApiError"]


class DuctApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


class DuctClient:
    def __init__(self, url: str, key: str, timeout: float = 60.0):
        if not key:
            raise ValueError("DuctClient needs an API key")
        self.base = url.rstrip("/") + "/v1"
        self.key = key
        self.timeout = timeout

    # ---------- plumbing ----------

    def _request(self, method: str, path: str, body: Any = None, data: Optional[bytes] = None, content_type: Optional[str] = None) -> Any:
        headers = {"Authorization": "Bearer " + self.key, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        req = Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except HTTPError as err:
            try:
                payload = json.loads(err.read() or b"{}")
            except ValueError:
                payload = {}
            raise DuctApiError(err.code, payload.get("code", "error"), payload.get("error", "HTTP %d" % err.code)) from None

    @staticmethod
    def _c(collection: str) -> str:
        return "/collections/" + quote(collection, safe="")

    # ---------- collections ----------

    def list_collections(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/collections")["collections"]

    def create_collection(self, name: str, search_mode: Optional[str] = None, ocr: Optional[bool] = None) -> Dict[str, Any]:
        settings = {k: v for k, v in {"search_mode": search_mode, "ocr": ocr}.items() if v is not None}
        return self._request("POST", "/collections", {"name": name, "settings": settings})

    def delete_collection(self, name: str) -> None:
        self._request("DELETE", self._c(name))

    # ---------- documents ----------

    def upsert(self, collection: str, id: str, text: Optional[str] = None, pages: Optional[List[str]] = None, title: Optional[str] = None,
               metadata: Optional[Dict[str, Any]] = None, format: Optional[str] = None) -> Dict[str, Any]:
        """Adds or replaces one text document under your id. Unchanged text is skipped."""
        doc = {k: v for k, v in {"text": text, "pages": pages, "title": title, "metadata": metadata, "format": format}.items() if v is not None}
        return self._request("PUT", self._c(collection) + "/documents/" + quote(id, safe=""), doc)

    def upsert_many(self, collection: str, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Adds or replaces up to 1000 documents: [{"id", "text" or "pages", "title"?, "metadata"?}]."""
        return self._request("POST", self._c(collection) + "/documents", {"documents": documents})["results"]

    def upload_file(self, collection: str, path: str, id: Optional[str] = None, title: Optional[str] = None,
                    metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Uploads a file (PDF, Word, Excel, PowerPoint, email, image...) for Duct to read."""
        boundary = uuid.uuid4().hex
        name = path.replace("\\", "/").rsplit("/", 1)[-1]
        parts = []
        for field, value in (("id", id), ("title", title), ("metadata", json.dumps(metadata) if metadata is not None else None)):
            if value is not None:
                parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, field, value)).encode("utf-8"))
        with open(path, "rb") as f:
            content = f.read()
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        safe_name = name.replace('"', "")
        parts.append(('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\nContent-Type: %s\r\n\r\n' % (boundary, safe_name, mime)).encode("utf-8") + content + b"\r\n")
        parts.append(("--%s--\r\n" % boundary).encode("utf-8"))
        return self._request("POST", self._c(collection) + "/files", data=b"".join(parts), content_type="multipart/form-data; boundary=" + boundary)

    def get_document(self, collection: str, id: str, include_text: bool = False) -> Dict[str, Any]:
        return self._request("GET", self._c(collection) + "/documents/" + quote(id, safe="") + ("?include=text" if include_text else ""))

    def list_documents(self, collection: str, limit: int = 20, offset: int = 0) -> Dict[str, Any]:
        return self._request("GET", self._c(collection) + "/documents?" + urlencode({"limit": limit, "offset": offset}))

    def delete_document(self, collection: str, id: str) -> None:
        self._request("DELETE", self._c(collection) + "/documents/" + quote(id, safe=""))

    # ---------- search ----------

    def search(self, collection: str, q: str, limit: int = 10, offset: int = 0, filter: Optional[Dict[str, Any]] = None,
               facets: Optional[List[str]] = None, formats: Optional[List[str]] = None, group: str = "document",
               sort: Optional[str] = None) -> Dict[str, Any]:
        body = {"q": q, "limit": limit, "offset": offset, "group": group}
        if filter:
            body["filter"] = filter
        if facets:
            body["facets"] = facets
        if formats:
            body["formats"] = formats
        if sort:
            body["sort"] = sort
        return self._request("POST", self._c(collection) + "/search", body)
