from __future__ import annotations


class QuantWorkbenchError(Exception):
    def __init__(
        self,
        message: str,
        status_code: int = 400,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code or (
            "INVALID_REQUEST"
            if status_code == 400
            else "NOT_FOUND"
            if status_code == 404
            else "INTERNAL_ERROR"
        )
