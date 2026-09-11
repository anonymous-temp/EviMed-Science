ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
FROM ${PYTHON_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MINERU_MODEL_SOURCE=modelscope \
    CUDA_VISIBLE_DEVICES=""

ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
RUN sed -ri "s|https?://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|https?://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && groupadd --system --gid 1000 evimed \
    && useradd --system --uid 1000 --gid evimed --home-dir /app --create-home evimed \
    && apt-get update \
    && apt-get install --no-install-recommends -y libgl1 libglib2.0-0 libreoffice-core libreoffice-writer libreoffice-impress libreoffice-calc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/document-parser/requirements.txt ./requirements.txt
ARG PYTORCH_CPU_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 --index-url "${PYTORCH_CPU_INDEX_URL}" \
    && pip install --no-cache-dir --requirement requirements.txt \
    && python -c "import torch,torchvision; assert torch.__version__.startswith('2.8.0'); assert torchvision.__version__.startswith('0.23.0'); assert torch.version.cuda is None"
COPY --chown=evimed:evimed deploy/document-parser/parser_service.py ./parser_service.py

USER evimed
RUN mineru-models-download -s modelscope -m pipeline

EXPOSE 8090
# Uvicorn counts idle keep-alive connections; parser_service admits one parse.
CMD ["uvicorn", "parser_service:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1", "--limit-concurrency", "32"]
