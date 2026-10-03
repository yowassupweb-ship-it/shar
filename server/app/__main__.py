"""python -m app — запуск сервиса (в разработке: SHAR_V2_RELOAD=1)."""

import logging
import os

import uvicorn

from app.config import settings

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=os.getenv("SHAR_V2_RELOAD") == "1")
