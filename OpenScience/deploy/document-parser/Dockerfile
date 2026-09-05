FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MINERU_MODEL_SOURCE=modelscope \
    CUDA_VISIBLE_DEVICES=""

RUN groupadd --system --gid 1000 evimed \
    && useradd --system --uid 1000 --gid evimed --home-dir /app --create-home evimed \
    && apt-get update \
    && apt-get install --no-install-recommends -y libgl1 libglib2.0-0 libreoffice-core libreoffice-writer libreoffice-impress libreoffice-calc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/document-parser/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt
COPY --chown=evimed:evimed deploy/document-parser/parser_service.py ./parser_service.py

USER evimed
RUN mineru-models-download -s modelscope -m pipeline

EXPOSE 8090
CMD ["uvicorn", "parser_service:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1", "--limit-concurrency", "2"]
