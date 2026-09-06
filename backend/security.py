"""Browser-origin boundary; worker/CLI authentication remains independent."""
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import normalize_origin


class BrowserOriginMiddleware:
    def __init__(self, app: ASGIApp, allowed_origins: tuple[str, ...] = ()):
        self.app = app
        self.allowed_origins = frozenset(allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] == "http" and scope["path"].startswith("/api/")
                and scope["method"] not in {"GET", "HEAD", "OPTIONS"}):
            headers = Headers(scope=scope)
            origins = headers.getlist("origin")
            rejected = not origins and headers.get("sec-fetch-site") == "cross-site"
            if origins:
                origin = normalize_origin(origins[0]) if len(origins) == 1 else None
                own_origin = normalize_origin(f"{scope['scheme']}://{headers.get('host', '')}")
                rejected = origin is None or (
                    origin != own_origin and origin not in self.allowed_origins)
            if rejected:
                response = JSONResponse(
                    {"detail": "不允许跨来源修改服务；请检查代理来源或 OPENK_ALLOWED_ORIGINS 配置"},
                    status_code=403,
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
